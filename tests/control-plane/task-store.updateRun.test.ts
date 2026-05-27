// tests/control-plane/task-store.updateRun.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { TaskStore, StaleRevError } from '../../src/control-plane/task-store.js';
import type { RunRecord } from '../../src/control-plane/task-record.js';

let root: string;
let store: TaskStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-updaterun-'));
  store = new TaskStore({ stateRoot: root, ownerGen: 'gen-1', now: () => 100 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run: RunRecord = {
  runId: 'r1',
  attemptId: 1,
  kind: 'prep',
  pid: 123,
  pidStart: null,
  spawnedAt: 5,
  sessionId: null,
  log: 'agent.jsonl',
  ownerGen: 'gen-1',
};

describe('TaskStore.updateRun (transition-free CAS)', () => {
  it('bumps rev + stamps ownerGen + applies the mutate without changing phase', async () => {
    await store.create({ ticket: 'PIN-10', title: 'A', url: 'u' });
    const advanced = await store.advance('PIN-10', { expectRev: 0, to: 'prepping' }); // rev 1
    expect(advanced.phase).toBe('prepping');

    const t = await store.updateRun('PIN-10', 1, (r) => {
      r.currentRun = { ...run };
    });
    expect(t.rev).toBe(2);
    expect(t.phase).toBe('prepping'); // unchanged
    expect(t.ownerGen).toBe('gen-1');
    expect(t.currentRun).not.toBeNull();
    expect(t.currentRun!.runId).toBe('r1');
  });

  it('throws when the mutate changes phase (transition-free guard)', async () => {
    await store.create({ ticket: 'PIN-11', title: 'B', url: 'u' });
    await store.advance('PIN-11', { expectRev: 0, to: 'prepping' }); // rev 1
    await expect(
      store.updateRun('PIN-11', 1, (r) => {
        r.phase = 'awaiting_approval';
      }),
    ).rejects.toThrow(/must not change phase/);
    // unchanged on disk
    expect((await store.get('PIN-11', { fresh: true }))!.phase).toBe('prepping');
  });

  it('rejects a stale expectRev with StaleRevError', async () => {
    await store.create({ ticket: 'PIN-12', title: 'C', url: 'u' });
    await store.advance('PIN-12', { expectRev: 0, to: 'prepping' }); // rev 1
    await expect(
      store.updateRun('PIN-12', 0, (r) => {
        r.currentRun = { ...run };
      }),
    ).rejects.toThrow(StaleRevError);
  });
});
