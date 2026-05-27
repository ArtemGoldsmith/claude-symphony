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
  root = await mkdtemp(path.join(tmpdir(), 'cp-retry-'));
  store = new TaskStore({ stateRoot: root, ownerGen: 'gen-1', now: () => 100 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// A dispatcher that records calls and claims the run like the real dispatchAgent:
// advance ONLY when `to` differs from the current phase, else updateRun (a
// continuation dispatches into the SAME phase, which is not a legal transition).
function recordingDispatcher(calls: DispatchArgs[]): Dispatcher {
  return {
    async dispatch(args) {
      calls.push(args);
      const cur = await args.store.get(args.ticket);
      const mutate = (r: TaskRecord) => {
        r.retryRequested = false;
        r.currentRun = { runId: 'r', attemptId: 1, kind: args.kind, pid: 1, pidStart: 's', spawnedAt: 0, sessionId: null, log: 'l', ownerGen: 'gen-1' };
      };
      if (cur && cur.phase !== args.to) {
        await args.store.advance(args.ticket, { expectRev: args.expectRev, to: args.to, mutate });
      } else {
        await args.store.updateRun(args.ticket, args.expectRev, mutate);
      }
    },
  };
}

function engineWith(dispatcher: Dispatcher, slots: SlotCounter): Engine {
  return new Engine({
    store, slots, dispatcher,
    reviewHasGaps: async () => false,
    stateRoot: root, ownerGen: 'gen-1', now: () => 100,
    probeExit: async () => null, // never route finished runs in these tests
  });
}

// Drive a fresh task to execute_failed with failedFrom recorded.
async function toExecuteFailed(ticket: string, failedFrom: 'executing' | 'reviewing'): Promise<void> {
  await store.create({ ticket, title: 'T', url: 'u' });
  await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; r.branch = 'b'; r.baseSha = 'sha'; } });
  await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval' });
  await store.advance(ticket, { expectRev: 2, to: 'approved' });
  await store.advance(ticket, { expectRev: 3, to: 'executing' });
  if (failedFrom === 'reviewing') {
    await store.advance(ticket, { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 5, to: 'execute_failed', mutate: (r) => { r.failedFrom = 'reviewing'; r.currentRun = null; } });
  } else {
    await store.advance(ticket, { expectRev: 4, to: 'execute_failed', mutate: (r) => { r.failedFrom = 'executing'; r.currentRun = null; } });
  }
}

describe('Engine retry lane', () => {
  it('failedFrom=executing → reserves + dispatches execute', async () => {
    await toExecuteFailed('PIN-1', 'executing');
    await store.updateRun('PIN-1', (await store.get('PIN-1'))!.rev, (r) => { r.retryRequested = true; });
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(2);
    await engineWith(recordingDispatcher(calls), slots).tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('executing');
    expect(calls[0]!.kind).toBe('execute');
    expect(slots.active).toBe(1);
    const t = (await store.get('PIN-1'))!;
    expect(t.phase).toBe('executing');
    expect(t.retryRequested).toBe(false);
  });

  it('failedFrom=reviewing → reserves + advances to reviewing (currentRun null), ensureRunning dispatches review', async () => {
    await toExecuteFailed('PIN-2', 'reviewing');
    await store.updateRun('PIN-2', (await store.get('PIN-2'))!.rev, (r) => { r.retryRequested = true; });
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(2);
    await engineWith(recordingDispatcher(calls), slots).tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe('reviewing');
    expect(calls[0]!.kind).toBe('review');
    expect(slots.active).toBe(1); // reserved once, not double
    expect((await store.get('PIN-2'))!.retryRequested).toBe(false);
  });

  it('does not retry when no slot is free', async () => {
    await toExecuteFailed('PIN-3', 'executing');
    await store.updateRun('PIN-3', (await store.get('PIN-3'))!.rev, (r) => { r.retryRequested = true; });
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(1);
    slots.tryReserve(); // saturate
    await engineWith(recordingDispatcher(calls), slots).tick();
    expect(calls).toHaveLength(0);
    expect((await store.get('PIN-3'))!.phase).toBe('execute_failed');
    expect((await store.get('PIN-3'))!.retryRequested).toBe(true); // still pending
  });

  it('first-prep dispatch failure surfaces prep_failed and releases the slot', async () => {
    await store.create({ ticket: 'PIN-5', title: 'T', url: 'u' });
    const failing: Dispatcher = { async dispatch() { throw new Error('intake boom'); } };
    const slots = new SlotCounter(2);
    await engineWith(failing, slots).tick(); // must NOT throw — prep failure is surfaced, not propagated
    const t = (await store.get('PIN-5'))!;
    expect(t.phase).toBe('prep_failed');
    expect(t.failedFrom).toBe('prepping');
    expect(slots.active).toBe(0);
  });

  it('ignores retryRequested on preview_failed/teardown_failed (Plan 4)', async () => {
    await store.create({ ticket: 'PIN-4', title: 'T', url: 'u' });
    await store.advance('PIN-4', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('PIN-4', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('PIN-4', { expectRev: 2, to: 'approved' });
    await store.advance('PIN-4', { expectRev: 3, to: 'executing' });
    await store.advance('PIN-4', { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-4', { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-4', { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('PIN-4', { expectRev: 7, to: 'preview_failed', mutate: (r) => { r.failedFrom = 'previewing'; } });
    await store.updateRun('PIN-4', 8, (r) => { r.retryRequested = true; });
    const calls: DispatchArgs[] = [];
    const slots = new SlotCounter(2);
    await engineWith(recordingDispatcher(calls), slots).tick();
    expect(calls).toHaveLength(0);
    expect(slots.active).toBe(0);
  });
});
