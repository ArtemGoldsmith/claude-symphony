// tests/control-plane/task-store.scan.test.ts
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { TaskStore, SNAPSHOT_FILENAME } from '../../src/control-plane/task-store.js';
import { newTaskRecord, writeTaskRecord } from '../../src/control-plane/task-record.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-scan-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('TaskStore.scan + snapshot', () => {
  it('scans $STATE_ROOT/ABC-*/task.json into the cache, ignoring non-task dirs', async () => {
    await writeTaskRecord(root, newTaskRecord({ ticket: 'ABC-1', title: 'A', url: 'u', ownerGen: 'g0', now: 1 }));
    await writeTaskRecord(root, newTaskRecord({ ticket: 'ABC-2', title: 'B', url: 'u', ownerGen: 'g0', now: 2 }));
    await mkdir(path.join(root, '.preview'), { recursive: true }); // not a ABC dir
    await mkdir(path.join(root, 'notes'), { recursive: true });

    const store = new TaskStore({ stateRoot: root, ownerGen: 'gen-2', now: () => 9 });
    const loaded = await store.scan();
    expect(loaded.map((t) => t.ticket).sort()).toEqual(['ABC-1', 'ABC-2']);
    expect((await store.get('ABC-1'))!.title).toBe('A');
  });

  it('list() returns all cached tasks', async () => {
    const store = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => 9 });
    await store.create({ ticket: 'ABC-9', title: 'Z', url: 'u' });
    expect((await store.list()).map((t) => t.ticket)).toEqual(['ABC-9']);
  });

  it('saveSnapshot writes a roll-up index atomically; loadSnapshot reads it back', async () => {
    const store = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => 9 });
    await store.create({ ticket: 'ABC-3', title: 'C', url: 'u' });
    await store.saveSnapshot();
    const idx = JSON.parse(await readFile(path.join(root, SNAPSHOT_FILENAME), 'utf8'));
    expect(idx.version).toBe(1);
    expect(idx.tickets).toEqual(['ABC-3']);

    const fresh = new TaskStore({ stateRoot: root, ownerGen: 'g2', now: () => 9 });
    const snap = await fresh.loadSnapshot();
    expect(snap!.tickets).toEqual(['ABC-3']);
  });

  it('loadSnapshot returns null when the index is missing or malformed (tolerant)', async () => {
    const store = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => 9 });
    expect(await store.loadSnapshot()).toBeNull();
    await writeFile(path.join(root, SNAPSHOT_FILENAME), 'nope', 'utf8');
    expect(await store.loadSnapshot()).toBeNull();
  });
});
