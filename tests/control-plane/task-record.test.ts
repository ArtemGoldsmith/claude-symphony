// tests/control-plane/task-record.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  TaskRecordSchema,
  taskDir,
  readTaskRecord,
  writeTaskRecord,
  newTaskRecord,
} from '../../src/control-plane/task-record.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-rec-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('task-record', () => {
  it('newTaskRecord seeds a queued task at rev 0', () => {
    const r = newTaskRecord({ ticket: 'PIN-301', title: 'X', url: 'u', ownerGen: 'g1', now: 1000 });
    expect(r.ticket).toBe('PIN-301');
    expect(r.phase).toBe('queued');
    expect(r.rev).toBe(0);
    expect(r.createdAt).toBe(1000);
    expect(TaskRecordSchema.parse(r)).toEqual(r);
  });

  it('taskDir is $STATE_ROOT/PIN-NNN and rejects unsafe identifiers', () => {
    expect(taskDir(root, 'PIN-301')).toBe(path.join(root, 'PIN-301'));
    expect(() => taskDir(root, '../evil')).toThrow();
  });

  it('writeTaskRecord then readTaskRecord round-trips, leaving no tmp files', async () => {
    const r = newTaskRecord({ ticket: 'PIN-7', title: 'T', url: 'u', ownerGen: 'g', now: 5 });
    await writeTaskRecord(root, r);
    const back = await readTaskRecord(root, 'PIN-7');
    expect(back).toEqual(r);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(path.join(root, 'PIN-7'));
    expect(files).toEqual(['task.json']); // no leftover .tmp
  });

  it('readTaskRecord returns null for a missing task (ENOENT-tolerant)', async () => {
    expect(await readTaskRecord(root, 'PIN-404')).toBeNull();
  });

  it('readTaskRecord returns null for malformed JSON rather than throwing', async () => {
    const dir = path.join(root, 'PIN-9');
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'task.json'), '{ not json', 'utf8');
    expect(await readTaskRecord(root, 'PIN-9')).toBeNull();
  });
});
