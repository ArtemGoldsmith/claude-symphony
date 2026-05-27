// tests/control-plane/engine.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { TaskStore } from '../../src/control-plane/task-store.js';
import { SlotCounter } from '../../src/control-plane/slots.js';
import { Engine, type Dispatcher } from '../../src/control-plane/engine.js';
import type { Phase } from '../../src/control-plane/phase.js';

let root: string;
let store: TaskStore;
let now: number;

// A fake dispatcher records calls and never spawns a process.
function fakeDispatcher(): Dispatcher & { calls: Array<{ ticket: string; to: Phase }> } {
  const calls: Array<{ ticket: string; to: Phase }> = [];
  return {
    calls,
    async dispatch(args) {
      calls.push({ ticket: args.ticket, to: args.to });
      const cur = await args.store.get(args.ticket);
      const mutate = (r: import('../../src/control-plane/task-record.js').TaskRecord): void => {
        r.currentRun = {
          runId: `run-${args.ticket}-${args.kind}`,
          attemptId: 1,
          kind: args.kind,
          pid: 999999, // not alive
          pidStart: 'x',
          spawnedAt: 0,
          sessionId: null,
          ownerGen: 'gen-1',
          log: 'agent.jsonl',
        };
      };
      // Continuation (to === current phase) → transition-free updateRun; else advance.
      if (cur && cur.phase === args.to) await args.store.updateRun(args.ticket, args.expectRev, mutate);
      else await args.store.advance(args.ticket, { expectRev: args.expectRev, to: args.to, mutate });
    },
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-eng-'));
  now = 1000;
  store = new TaskStore({ stateRoot: root, ownerGen: 'gen-1', now: () => now });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Engine.tick — promotion under the slot cap', () => {
  it('promotes queued→prepping and approved→executing in createdAt order until the cap is hit', async () => {
    now = 1;
    await store.create({ ticket: 'PIN-1', title: 'A', url: 'u' });
    now = 2;
    await store.create({ ticket: 'PIN-2', title: 'B', url: 'u' });
    now = 3;
    await store.create({ ticket: 'PIN-3', title: 'C', url: 'u' });

    const slots = new SlotCounter(2);
    slots.seedFrom([]); // nothing active
    const dispatcher = fakeDispatcher();
    const engine = new Engine({ store, slots, dispatcher, reviewHasGaps: async () => false, stateRoot: root, ownerGen: 'gen-1', now: () => now });

    await engine.tick();
    // cap 2 → only the two oldest promoted
    expect(dispatcher.calls.map((c) => c.ticket)).toEqual(['PIN-1', 'PIN-2']);
    expect(slots.active).toBe(2);
    expect((await store.get('PIN-3'))!.phase).toBe('queued');
  });

  it('does not over-commit when called twice with no slot freed', async () => {
    await store.create({ ticket: 'PIN-1', title: 'A', url: 'u' });
    const slots = new SlotCounter(1);
    const dispatcher = fakeDispatcher();
    const engine = new Engine({ store, slots, dispatcher, reviewHasGaps: async () => false, stateRoot: root, ownerGen: 'gen-1', now: () => now });
    await engine.tick();
    await engine.tick();
    expect(dispatcher.calls).toHaveLength(1);
    expect(slots.active).toBe(1);
  });
});

describe('Engine.routeExit — agent chain', () => {
  it('routes a clean executing exit to reviewing and releases nothing extra', async () => {
    await store.create({ ticket: 'PIN-1', title: 'A', url: 'u' });
    await store.advance('PIN-1', { expectRev: 0, to: 'prepping' });
    await store.advance('PIN-1', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('PIN-1', { expectRev: 2, to: 'approved' });
    await store.advance('PIN-1', {
      expectRev: 3,
      to: 'executing',
      mutate: (r) => {
        r.currentRun = { runId: 'r', attemptId: 1, kind: 'execute', pid: 999999, pidStart: 'x', spawnedAt: 0, sessionId: null, ownerGen: 'gen-1', log: 'agent.jsonl' };
      },
    });

    const slots = new SlotCounter(2);
    slots.seedFrom(['executing']);
    const engine = new Engine({
      store,
      slots,
      dispatcher: fakeDispatcher(),
      reviewHasGaps: async () => false,
      stateRoot: root,
      ownerGen: 'gen-1',
      now: () => now,
      // inject the exit result so no real process is needed
      probeExit: async () => ({ ok: true }),
    });

    await engine.routeExit('PIN-1');
    expect((await store.get('PIN-1'))!.phase).toBe('reviewing');
  });

  it('routes reviewing→gapfixing when the reviewer reports gaps, else →closing', async () => {
    async function setup(gaps: boolean) {
      const s = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => now });
      await s.create({ ticket: gaps ? 'PIN-7' : 'PIN-8', title: 'A', url: 'u' });
      const t = gaps ? 'PIN-7' : 'PIN-8';
      await s.advance(t, { expectRev: 0, to: 'prepping' });
      await s.advance(t, { expectRev: 1, to: 'awaiting_approval' });
      await s.advance(t, { expectRev: 2, to: 'approved' });
      await s.advance(t, { expectRev: 3, to: 'executing' });
      await s.advance(t, { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = { runId: 'r', attemptId: 1, kind: 'review', pid: 999999, pidStart: 'x', spawnedAt: 0, sessionId: null, ownerGen: 'gen-1', log: 'review.jsonl' }; } });
      return { s, t };
    }
    const slots = new SlotCounter(4);
    slots.seedFrom(['reviewing', 'reviewing']);

    const g = await setup(true);
    const eg = new Engine({ store: g.s, slots, dispatcher: fakeDispatcher(), reviewHasGaps: async () => true, stateRoot: root, ownerGen: 'gen-1', now: () => now, probeExit: async () => ({ ok: true }) });
    await eg.routeExit(g.t);
    expect((await g.s.get(g.t))!.phase).toBe('gapfixing');

    const n = await setup(false);
    const en = new Engine({ store: n.s, slots, dispatcher: fakeDispatcher(), reviewHasGaps: async () => false, stateRoot: root, ownerGen: 'gen-1', now: () => now, probeExit: async () => ({ ok: true }) });
    await en.routeExit(n.t);
    expect((await n.s.get(n.t))!.phase).toBe('closing');
  });

  it('routes a crashed executing run to execute_failed with failedFrom=executing', async () => {
    await store.create({ ticket: 'PIN-1', title: 'A', url: 'u' });
    await store.advance('PIN-1', { expectRev: 0, to: 'prepping' });
    await store.advance('PIN-1', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('PIN-1', { expectRev: 2, to: 'approved' });
    await store.advance('PIN-1', { expectRev: 3, to: 'executing', mutate: (r) => { r.currentRun = { runId: 'r', attemptId: 1, kind: 'execute', pid: 999999, pidStart: 'x', spawnedAt: 0, sessionId: null, ownerGen: 'gen-1', log: 'agent.jsonl' }; } });
    const slots = new SlotCounter(2);
    slots.seedFrom(['executing']);
    const engine = new Engine({ store, slots, dispatcher: fakeDispatcher(), reviewHasGaps: async () => false, stateRoot: root, ownerGen: 'gen-1', now: () => now, probeExit: async () => ({ ok: false }) });
    await engine.routeExit('PIN-1');
    const t = (await store.get('PIN-1'))!;
    expect(t.phase).toBe('execute_failed');
    expect(t.failedFrom).toBe('executing');
  });
});

describe('Engine.ensureRunning — chain continuation without reserving', () => {
  it('dispatches the review agent for a reviewing task that holds its slot but has no run', async () => {
    await store.create({ ticket: 'PIN-1', title: 'A', url: 'u' });
    await store.advance('PIN-1', { expectRev: 0, to: 'prepping' });
    await store.advance('PIN-1', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('PIN-1', { expectRev: 2, to: 'approved' });
    await store.advance('PIN-1', { expectRev: 3, to: 'executing' });
    // routed into reviewing, currentRun nulled, slot still held
    await store.advance('PIN-1', { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });

    const slots = new SlotCounter(2);
    slots.seedFrom(['reviewing']); // 1 held
    const dispatcher = fakeDispatcher();
    const engine = new Engine({ store, slots, dispatcher, reviewHasGaps: async () => false, stateRoot: root, ownerGen: 'gen-1', now: () => now });

    await engine.ensureRunning();
    // a review agent was dispatched, in-place (no extra slot reserved)
    expect(dispatcher.calls).toEqual([{ ticket: 'PIN-1', to: 'reviewing' }]);
    const t = (await store.get('PIN-1'))!;
    expect(t.phase).toBe('reviewing');
    expect(t.currentRun!.kind).toBe('review');
    expect(slots.active).toBe(1); // unchanged
  });
});
