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
