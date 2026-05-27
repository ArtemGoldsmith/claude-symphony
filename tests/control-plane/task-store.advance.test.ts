// tests/control-plane/task-store.advance.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { TaskStore, StaleRevError, TaskExistsError } from '../../src/control-plane/task-store.js';
import { TransitionError } from '../../src/control-plane/phase.js';
import { readTaskRecord, writeTaskRecord } from '../../src/control-plane/task-record.js';

let root: string;
let store: TaskStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-store-'));
  store = new TaskStore({ stateRoot: root, ownerGen: 'gen-1', now: () => 100 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TaskStore.advance (CAS + queue)', () => {
  it('creates a queued task and advances it through a legal transition, bumping rev', async () => {
    const t0 = await store.create({ ticket: 'PIN-1', title: 'A', url: 'u' });
    expect(t0.phase).toBe('queued');
    expect(t0.rev).toBe(0);

    const t1 = await store.advance('PIN-1', { expectRev: 0, to: 'prepping' });
    expect(t1.phase).toBe('prepping');
    expect(t1.rev).toBe(1);
    expect(t1.updatedAt).toBe(100);
  });

  it('rejects creating a ticket that is already tracked (spec §12)', async () => {
    // PIN-DUP is not a valid TEAM-NNN identifier; use PIN-99 for the duplicate test.
    await store.create({ ticket: 'PIN-99', title: 'A', url: 'u' });
    await expect(store.create({ ticket: 'PIN-99', title: 'A', url: 'u' })).rejects.toThrow(
      TaskExistsError,
    );
    // a fresh store instance sees the on-disk record too
    const store2 = new TaskStore({ stateRoot: root, ownerGen: 'gen-2', now: () => 100 });
    await expect(store2.create({ ticket: 'PIN-99', title: 'A', url: 'u' })).rejects.toThrow(
      TaskExistsError,
    );
  });

  it('rejects a stale-rev advance with StaleRevError and does not mutate', async () => {
    await store.create({ ticket: 'PIN-2', title: 'B', url: 'u' });
    await store.advance('PIN-2', { expectRev: 0, to: 'prepping' }); // rev now 1
    await expect(store.advance('PIN-2', { expectRev: 0, to: 'awaiting_approval' })).rejects.toThrow(
      StaleRevError,
    );
    expect((await store.get('PIN-2'))!.phase).toBe('prepping');
  });

  it('rejects an illegal transition with TransitionError', async () => {
    await store.create({ ticket: 'PIN-3', title: 'C', url: 'u' });
    await expect(store.advance('PIN-3', { expectRev: 0, to: 'executing' })).rejects.toThrow(
      TransitionError,
    );
  });

  it('serializes concurrent advances on the same task (no lost update)', async () => {
    await store.create({ ticket: 'PIN-4', title: 'D', url: 'u' });
    // Fire two advances concurrently from rev 0. Exactly one wins; the other
    // sees the bumped rev and rejects.
    const a = store.advance('PIN-4', { expectRev: 0, to: 'prepping' });
    const b = store.advance('PIN-4', { expectRev: 0, to: 'prepping' });
    const results = await Promise.allSettled([a, b]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((await store.get('PIN-4'))!.rev).toBe(1);
  });

  it('adopts a higher-rev disk record (liveForCas cross-generation reconcile) and rejects a stale cache-rev advance', async () => {
    // Cache rev is 1 after create+advance.
    await store.create({ ticket: 'PIN-6', title: 'F', url: 'u' });
    await store.advance('PIN-6', { expectRev: 0, to: 'prepping' });

    // Out-of-band: a different generation writes a HIGHER-rev record straight to disk.
    const onDisk = await readTaskRecord(root, 'PIN-6');
    onDisk!.rev = 5;
    await writeTaskRecord(root, onDisk!);

    // A CAS with the STALE cache rev (1) must reject — liveForCas adopts disk rev 5.
    await expect(store.advance('PIN-6', { expectRev: 1, to: 'awaiting_approval' })).rejects.toThrow(
      StaleRevError,
    );
  });

  it('applies a mutator under the same CAS so field writes are atomic with the phase change', async () => {
    await store.create({ ticket: 'PIN-5', title: 'E', url: 'u' });
    const t = await store.advance('PIN-5', {
      expectRev: 0,
      to: 'prepping',
      mutate: (r) => {
        r.branch = 'agent/pin-5-x';
        r.attempts.prep += 1;
      },
    });
    expect(t.branch).toBe('agent/pin-5-x');
    expect(t.attempts.prep).toBe(1);
    // persisted on disk too
    const onDisk = await store.get('PIN-5', { fresh: true });
    expect(onDisk!.branch).toBe('agent/pin-5-x');
  });
});
