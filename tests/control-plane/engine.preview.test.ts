import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { Engine, type Dispatcher, type DispatchArgs } from '../../src/control-plane/engine.js';
import { SlotCounter } from '../../src/control-plane/slots.js';
import { TaskStore } from '../../src/control-plane/task-store.js';
import type { TaskRecord } from '../../src/control-plane/task-record.js';

let root: string;
let store: TaskStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-prev-'));
  store = new TaskStore({ stateRoot: root, ownerGen: 'gen-1', now: () => 100 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// Records dispatch calls and claims the run like dispatchAgent: advance when `to`
// differs from current phase, else updateRun (continuation into the same phase).
function recordingDispatcher(calls: DispatchArgs[]): Dispatcher {
  return {
    async dispatch(args) {
      calls.push(args);
      const cur = await args.store.get(args.ticket);
      const mutate = (r: TaskRecord) => {
        r.retryRequested = false;
        r.currentRun = { runId: 'r', attemptId: 1, kind: args.kind, pid: 1, pidStart: 's', spawnedAt: 0, sessionId: null, log: 'l', ownerGen: 'gen-1' };
      };
      if (cur && cur.phase !== args.to) await args.store.advance(args.ticket, { expectRev: args.expectRev, to: args.to, mutate });
      else await args.store.updateRun(args.ticket, args.expectRev, mutate);
    },
  };
}

function engineWith(dispatcher: Dispatcher, slots: SlotCounter): Engine {
  return new Engine({
    store, slots, dispatcher, reviewHasGaps: async () => false,
    stateRoot: root, ownerGen: 'gen-1', now: () => 100, probeExit: async () => null,
  });
}

// Drive a task to `previewing` with currentRun=null (post-closeout-route shape).
async function toPreviewing(ticket: string): Promise<void> {
  await store.create({ ticket, title: 'T', url: 'u' });
  await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; r.baseSha = 'base'; } });
  await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval' });
  await store.advance(ticket, { expectRev: 2, to: 'approved' });
  await store.advance(ticket, { expectRev: 3, to: 'executing' });
  await store.advance(ticket, { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
  await store.advance(ticket, { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
  await store.advance(ticket, { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
}

describe('Engine.ensureRunning — preview/teardown continuations', () => {
  it('dispatches preview for a previewing task with no run, without reserving a slot', async () => {
    await toPreviewing('PIN-1');
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(2);
    await engineWith(recordingDispatcher(calls), slots).ensureRunning();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('preview');
    expect(calls[0]!.to).toBe('previewing');
    expect(slots.active).toBe(0); // ensureRunning never reserves
    expect((await store.get('PIN-1'))!.currentRun!.kind).toBe('preview');
  });

  it('dispatches teardown for a tearing_down task with no run', async () => {
    await store.create({ ticket: 'PIN-2', title: 'T', url: 'u' });
    // hand-place into tearing_down (ready→tearing_down is the web path; we shortcut)
    await store.advance('PIN-2', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('PIN-2', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('PIN-2', { expectRev: 2, to: 'approved' });
    await store.advance('PIN-2', { expectRev: 3, to: 'executing' });
    await store.advance('PIN-2', { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-2', { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-2', { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-2', { expectRev: 7, to: 'ready', mutate: (r) => { r.preview = { url: 'https://x', gitSha: 's', state: 'up' }; } });
    await store.advance('PIN-2', { expectRev: 8, to: 'tearing_down', mutate: (r) => { r.teardownTarget = 'done'; r.terminalReason = 'approved'; } });
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(2);
    await engineWith(recordingDispatcher(calls), slots).ensureRunning();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('teardown');
    expect(calls[0]!.to).toBe('tearing_down');
  });

  it('does not re-dispatch when a run is already present', async () => {
    await toPreviewing('PIN-3');
    await store.updateRun('PIN-3', (await store.get('PIN-3'))!.rev, (r) => {
      r.currentRun = { runId: 'r', attemptId: 1, kind: 'preview', pid: 1, pidStart: 's', spawnedAt: 0, sessionId: null, log: 'preview.log', ownerGen: 'gen-1' };
    });
    const calls: DispatchArgs[] = [];
    await engineWith(recordingDispatcher(calls), new SlotCounter(2)).ensureRunning();
    expect(calls).toHaveLength(0);
  });
});

import type { PreviewOutcome } from '../../src/control-plane/engine.js';

function engineFull(opts: {
  dispatcher?: Dispatcher; slots?: SlotCounter;
  probe?: (t: TaskRecord) => Promise<{ ok: boolean } | null>;
  canPreview?: (t: TaskRecord) => Promise<boolean>;
  outcome?: (t: TaskRecord) => Promise<PreviewOutcome | null>;
  loadOQ?: (t: TaskRecord) => Promise<import('../../src/control-plane/engine.js').OpenQuestionItem[] | null>;
  loadS9?: (t: TaskRecord) => Promise<TaskRecord['stage9']>;
}): Engine {
  return new Engine({
    store, slots: opts.slots ?? new SlotCounter(2),
    dispatcher: opts.dispatcher ?? recordingDispatcher([]),
    reviewHasGaps: async () => false,
    stateRoot: root, ownerGen: 'gen-1', now: () => 100,
    probeExit: opts.probe ?? (async () => ({ ok: true })),
    ...(opts.canPreview ? { canPreview: opts.canPreview } : {}),
    ...(opts.outcome ? { readPreviewOutcome: opts.outcome } : {}),
    ...(opts.loadOQ ? { loadOpenQuestions: opts.loadOQ } : {}),
    ...(opts.loadS9 ? { loadStage9: opts.loadS9 } : {}),
  });
}

// place a task into `previewing` WITH a finished preview run to route.
async function previewingWithRun(ticket: string): Promise<void> {
  await toPreviewing(ticket);
  await store.updateRun(ticket, (await store.get(ticket))!.rev, (r) => {
    r.currentRun = { runId: 'r', attemptId: 1, kind: 'preview', pid: 1, pidStart: 's', spawnedAt: 0, sessionId: null, log: 'preview.log', ownerGen: 'gen-1' };
  });
}

describe('Engine.routeExit — preview', () => {
  it('preview up + gitSha match → ready, copies task.preview, loads stage9, releases the slot', async () => {
    await previewingWithRun('PIN-1');
    const slots = new SlotCounter(2); slots.tryReserve(); // previewing holds a slot
    const eng = engineFull({ slots, probe: async () => ({ ok: true }),
      outcome: async () => ({ state: 'up', gitSha: 'HEAD', url: 'https://pin-1.preview.internal', headMatches: true }),
      loadS9: async () => ({ attemptId: 1, gitSha: 'HEAD', items: [{ n: 1, tag: 'CUT', text: 'x', acked: false }] }) });
    await eng.routeExit('PIN-1');
    const t = (await store.get('PIN-1'))!;
    expect(t.phase).toBe('ready');
    expect(t.preview).toEqual({ url: 'https://pin-1.preview.internal', gitSha: 'HEAD', state: 'up' });
    expect(t.stage9!.items).toHaveLength(1); // ready gate now renders
    expect(t.currentRun).toBeNull();
    expect(slots.active).toBe(0); // released on leaving the ⊕set
  });

  it('previewing→ready with no stage9.json falls back to an empty stage9 (gate still reachable)', async () => {
    await previewingWithRun('PIN-11');
    const eng = engineFull({ probe: async () => ({ ok: true }),
      outcome: async () => ({ state: 'up', gitSha: 'HEAD', url: 'https://x', headMatches: true }),
      loadS9: async () => null });
    await eng.routeExit('PIN-11');
    const t = (await store.get('PIN-11'))!;
    expect(t.phase).toBe('ready');
    expect(t.stage9).toEqual({ attemptId: t.attempts.execute, gitSha: 'HEAD', items: [] });
  });

  it('preview exit≠0 → preview_failed, records task.preview from the (stuck) outcome', async () => {
    await previewingWithRun('PIN-2');
    const slots = new SlotCounter(2); slots.tryReserve();
    const eng = engineFull({ slots, probe: async () => ({ ok: false }),
      outcome: async () => ({ state: 'starting', gitSha: 'HEAD', url: 'https://x', headMatches: true }) });
    await eng.routeExit('PIN-2');
    const t = (await store.get('PIN-2'))!;
    expect(t.phase).toBe('preview_failed');
    expect(t.failedFrom).toBe('previewing');
    expect(t.preview).toEqual({ url: '', gitSha: 'HEAD', state: 'starting' }); // H1: teardown can now see live compute
    expect(slots.active).toBe(0);
  });

  it('preview up but gitSha mismatch → preview_failed', async () => {
    await previewingWithRun('PIN-3');
    const eng = engineFull({ probe: async () => ({ ok: true }),
      outcome: async () => ({ state: 'up', gitSha: 'OLD', url: 'https://x', headMatches: false }) });
    await eng.routeExit('PIN-3');
    expect((await store.get('PIN-3'))!.phase).toBe('preview_failed');
  });
});

describe('Engine.routeExit — closing→previewing guard (canPreview)', () => {
  // closeout is an AGENT run; place a finished closeout in `closing`.
  async function closingWithRun(ticket: string): Promise<void> {
    await store.create({ ticket, title: 'T', url: 'u' });
    await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; r.baseSha = 'base'; } });
    await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval' });
    await store.advance(ticket, { expectRev: 2, to: 'approved' });
    await store.advance(ticket, { expectRev: 3, to: 'executing' });
    await store.advance(ticket, { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 5, to: 'closing', mutate: (r) => {
      r.currentRun = { runId: 'r', attemptId: 1, kind: 'closeout', pid: 1, pidStart: 's', spawnedAt: 0, sessionId: null, log: 'closeout.jsonl', ownerGen: 'gen-1' };
    } });
  }

  it('canPreview true → previewing (slot retained across closing→previewing)', async () => {
    await closingWithRun('PIN-4');
    const slots = new SlotCounter(2); slots.tryReserve();
    const eng = engineFull({ slots, probe: async () => ({ ok: true }), canPreview: async () => true });
    await eng.routeExit('PIN-4');
    expect((await store.get('PIN-4'))!.phase).toBe('previewing');
    expect(slots.active).toBe(1); // closing and previewing are both ⊕ → no release
  });

  it('canPreview false → execute_failed(failedFrom=executing), releases the slot', async () => {
    await closingWithRun('PIN-5');
    const slots = new SlotCounter(2); slots.tryReserve();
    const eng = engineFull({ slots, probe: async () => ({ ok: true }), canPreview: async () => false });
    await eng.routeExit('PIN-5');
    const t = (await store.get('PIN-5'))!;
    expect(t.phase).toBe('execute_failed');
    expect(t.failedFrom).toBe('executing');
    expect(slots.active).toBe(0);
  });

  it('canPreview that throws is treated as guard-fail (no wedged slot)', async () => {
    await closingWithRun('PIN-6');
    const slots = new SlotCounter(2); slots.tryReserve();
    const eng = engineFull({ slots, probe: async () => ({ ok: true }), canPreview: async () => { throw new Error('git boom'); } });
    await eng.routeExit('PIN-6');
    expect((await store.get('PIN-6'))!.phase).toBe('execute_failed');
    expect(slots.active).toBe(0);
  });
});

describe('Engine.routeExit — prepping→awaiting_approval loads open-questions', () => {
  async function preppingWithRun(ticket: string): Promise<void> {
    await store.create({ ticket, title: 'T', url: 'u' });
    await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => {
      r.worktree = '/wt'; r.baseSha = 'base';
      r.currentRun = { runId: 'r', attemptId: 1, kind: 'prep', pid: 1, pidStart: 's', spawnedAt: 0, sessionId: null, log: 'prep.jsonl', ownerGen: 'gen-1' };
    } });
  }

  it('loads items with a fresh rev and clears answers', async () => {
    await preppingWithRun('PIN-21');
    const eng = engineFull({ probe: async () => ({ ok: true }),
      loadOQ: async () => [{ id: 'q1', text: 'pick', kind: 'bool', required: true }] });
    await eng.routeExit('PIN-21');
    const t = (await store.get('PIN-21'))!;
    expect(t.phase).toBe('awaiting_approval');
    expect(t.openQuestions).toEqual({ rev: 1, items: [{ id: 'q1', text: 'pick', kind: 'bool', required: true }] });
    expect(t.answers).toBeNull();
  });

  it('bumps the rev on a re-prep (monotonic) and clears prior answers', async () => {
    await preppingWithRun('PIN-22');
    // simulate a prior prep cycle: openQuestions rev 3 + stale answers
    await store.updateRun('PIN-22', (await store.get('PIN-22'))!.rev, (r) => {
      r.openQuestions = { rev: 3, items: [] };
      r.answers = { questionsRev: 3, planAckRev: 3, values: { q1: 'old' } };
    });
    const eng = engineFull({ probe: async () => ({ ok: true }), loadOQ: async () => [{ id: 'q9', text: 'new', kind: 'free', required: false }] });
    await eng.routeExit('PIN-22');
    const t = (await store.get('PIN-22'))!;
    expect(t.openQuestions!.rev).toBe(4); // 3 + 1
    expect(t.answers).toBeNull();
  });

  it('null loader → empty question set (still lands awaiting_approval)', async () => {
    await preppingWithRun('PIN-23');
    const eng = engineFull({ probe: async () => ({ ok: true }), loadOQ: async () => null });
    await eng.routeExit('PIN-23');
    const t = (await store.get('PIN-23'))!;
    expect(t.openQuestions).toEqual({ rev: 1, items: [] });
  });
});

describe('Engine.routeExit — teardown', () => {
  async function tearingDownWithRun(ticket: string, target: 'done' | 'abandoned' | 'queued', terminal: 'approved' | null): Promise<void> {
    await store.create({ ticket, title: 'T', url: 'u' });
    await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval' });
    await store.advance(ticket, { expectRev: 2, to: 'approved' });
    await store.advance(ticket, { expectRev: 3, to: 'executing' });
    await store.advance(ticket, { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 7, to: 'ready', mutate: (r) => { r.preview = { url: 'https://x', gitSha: 's', state: 'up' }; } });
    await store.advance(ticket, { expectRev: 8, to: 'tearing_down', mutate: (r) => {
      r.teardownTarget = target; if (terminal) r.terminalReason = terminal;
      r.currentRun = { runId: 'r', attemptId: 1, kind: 'teardown', pid: 1, pidStart: 's', spawnedAt: 0, sessionId: null, log: 'teardown.log', ownerGen: 'gen-1' };
    } });
  }

  it('teardown ok + target done → done, clears teardownTarget + preview, keeps terminalReason approved', async () => {
    await tearingDownWithRun('PIN-7', 'done', 'approved');
    const eng = engineFull({ probe: async () => ({ ok: true }) });
    await eng.routeExit('PIN-7');
    const t = (await store.get('PIN-7'))!;
    expect(t.phase).toBe('done');
    expect(t.terminalReason).toBe('approved');
    expect(t.teardownTarget).toBeNull();
    expect(t.preview).toBeNull();
  });

  it('teardown ok + target abandoned → abandoned, sets terminalReason abandoned', async () => {
    await tearingDownWithRun('PIN-8', 'abandoned', null);
    const eng = engineFull({ probe: async () => ({ ok: true }) });
    await eng.routeExit('PIN-8');
    const t = (await store.get('PIN-8'))!;
    expect(t.phase).toBe('abandoned');
    expect(t.terminalReason).toBe('abandoned');
  });

  it('teardown ok + target queued → queued, clears preview (re-prep)', async () => {
    await tearingDownWithRun('PIN-9', 'queued', null);
    const eng = engineFull({ probe: async () => ({ ok: true }) });
    await eng.routeExit('PIN-9');
    const t = (await store.get('PIN-9'))!;
    expect(t.phase).toBe('queued');
    expect(t.preview).toBeNull();
  });

  it('teardown exit≠0 → teardown_failed (no slot involved)', async () => {
    await tearingDownWithRun('PIN-10', 'done', 'approved');
    const slots = new SlotCounter(2); // tearing_down holds none
    const eng = engineFull({ slots, probe: async () => ({ ok: false }) });
    await eng.routeExit('PIN-10');
    expect((await store.get('PIN-10'))!.phase).toBe('teardown_failed');
    expect((await store.get('PIN-10'))!.failedFrom).toBe('tearing_down');
    expect(slots.active).toBe(0);
  });
});

describe('Engine retry lane — preview/teardown (slot-conditional)', () => {
  async function previewFailed(ticket: string): Promise<void> {
    await store.create({ ticket, title: 'T', url: 'u' });
    await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval' });
    await store.advance(ticket, { expectRev: 2, to: 'approved' });
    await store.advance(ticket, { expectRev: 3, to: 'executing' });
    await store.advance(ticket, { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 7, to: 'preview_failed', mutate: (r) => { r.failedFrom = 'previewing'; } });
    await store.updateRun(ticket, 8, (r) => { r.retryRequested = true; });
  }

  it('preview_failed retry reserves a slot, re-enters previewing, ensureRunning dispatches preview', async () => {
    await previewFailed('PIN-1');
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(2);
    await engineWith(recordingDispatcher(calls), slots).tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('preview');
    expect(calls[0]!.to).toBe('previewing');
    expect(slots.active).toBe(1); // previewing ∈ ⊕ → reserved once
    expect((await store.get('PIN-1'))!.retryRequested).toBe(false);
  });

  it('preview_failed retry breaks when no slot is free', async () => {
    await previewFailed('PIN-2');
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(1); slots.tryReserve();
    await engineWith(recordingDispatcher(calls), slots).tick();
    expect(calls).toHaveLength(0);
    expect((await store.get('PIN-2'))!.phase).toBe('preview_failed');
    expect((await store.get('PIN-2'))!.retryRequested).toBe(true);
  });

  it('teardown_failed retry re-enters tearing_down WITHOUT reserving a slot', async () => {
    await store.create({ ticket: 'PIN-3', title: 'T', url: 'u' });
    await store.advance('PIN-3', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('PIN-3', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('PIN-3', { expectRev: 2, to: 'approved' });
    await store.advance('PIN-3', { expectRev: 3, to: 'executing' });
    await store.advance('PIN-3', { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-3', { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-3', { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-3', { expectRev: 7, to: 'ready', mutate: (r) => { r.preview = { url: 'u', gitSha: 's', state: 'up' }; } });
    await store.advance('PIN-3', { expectRev: 8, to: 'tearing_down', mutate: (r) => { r.teardownTarget = 'done'; } });
    await store.advance('PIN-3', { expectRev: 9, to: 'teardown_failed', mutate: (r) => { r.failedFrom = 'tearing_down'; } });
    await store.updateRun('PIN-3', 10, (r) => { r.retryRequested = true; });
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(2);
    await engineWith(recordingDispatcher(calls), slots).tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('teardown');
    expect(calls[0]!.to).toBe('tearing_down');
    expect(slots.active).toBe(0); // tearing_down ∉ ⊕ → no reservation
    expect((await store.get('PIN-3'))!.retryRequested).toBe(false);
  });

  it('a saturated earlier slot-retry does NOT starve a later non-slot teardown retry (codex HIGH)', async () => {
    // PIN-30 (older) = preview_failed retry needing a slot; slots are full → it cannot proceed.
    await previewFailed('PIN-30');
    // PIN-31 (newer) = teardown_failed retry needing NO slot → must still be dispatched.
    await store.create({ ticket: 'PIN-31', title: 'T', url: 'u' });
    await store.advance('PIN-31', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('PIN-31', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('PIN-31', { expectRev: 2, to: 'approved' });
    await store.advance('PIN-31', { expectRev: 3, to: 'executing' });
    await store.advance('PIN-31', { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-31', { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-31', { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-31', { expectRev: 7, to: 'ready', mutate: (r) => { r.preview = { url: 'u', gitSha: 's', state: 'up' }; } });
    await store.advance('PIN-31', { expectRev: 8, to: 'tearing_down', mutate: (r) => { r.teardownTarget = 'done'; } });
    await store.advance('PIN-31', { expectRev: 9, to: 'teardown_failed', mutate: (r) => { r.failedFrom = 'tearing_down'; } });
    await store.updateRun('PIN-31', 10, (r) => { r.retryRequested = true; });
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(1); slots.tryReserve(); // saturated → PIN-30 cannot reserve
    await engineWith(recordingDispatcher(calls), slots).tick();
    // PIN-30 stays preview_failed (no slot), PIN-31 teardown still dispatched
    expect((await store.get('PIN-30'))!.phase).toBe('preview_failed');
    expect(calls.some((c) => c.kind === 'teardown' && c.to === 'tearing_down')).toBe(true);
  });
});
