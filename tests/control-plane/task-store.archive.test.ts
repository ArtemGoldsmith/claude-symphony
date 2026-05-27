import { mkdtemp, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { TaskStore, UnknownTaskError } from '../../src/control-plane/task-store.js';

let root: string;
let store: TaskStore;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-arch-'));
  store = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => 100 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// Drive a fresh task to a terminal (abandoned) phase: queued→prep_failed→abandoned.
async function toAbandoned(ticket: string): Promise<void> {
  await store.create({ ticket, title: 'A', url: 'u' });
  await store.advance(ticket, { expectRev: 0, to: 'prep_failed', mutate: (r) => { r.failedFrom = 'prepping'; } });
  await store.advance(ticket, { expectRev: 1, to: 'abandoned', mutate: (r) => { r.terminalReason = 'abandoned'; } });
}

describe('TaskStore.archive', () => {
  it('moves a terminal task dir under .archive and evicts the cache so create can re-add', async () => {
    await toAbandoned('PIN-1');
    await store.archive('PIN-1');
    expect(await store.get('PIN-1')).toBeNull();
    await expect(access(path.join(root, 'PIN-1'))).rejects.toBeDefined();
    const archived = await readdir(path.join(root, '.archive'));
    expect(archived.some((n) => n.startsWith('PIN-1-'))).toBe(true);
    const re = await store.create({ ticket: 'PIN-1', title: 'A2', url: 'u2' });
    expect(re.phase).toBe('queued');
    expect(re.title).toBe('A2');
  });

  it('refuses to archive a non-terminal task', async () => {
    await store.create({ ticket: 'PIN-2', title: 'A', url: 'u' }); // queued = non-terminal
    await expect(store.archive('PIN-2')).rejects.toThrow(/terminal/i);
    expect((await store.get('PIN-2'))!.phase).toBe('queued'); // untouched
  });

  it('throws UnknownTaskError when the ticket is not tracked', async () => {
    await expect(store.archive('PIN-404')).rejects.toThrow(UnknownTaskError);
  });
});
