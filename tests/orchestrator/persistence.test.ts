import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  STATE_FILENAME,
  loadStateFromDisk,
  saveStateToDisk,
} from '../../src/orchestrator/persistence.js';

describe('persistence — load/save round trip (Phase 3 P5)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persist-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null snapshot when no file exists', async () => {
    const result = await loadStateFromDisk(dir);
    expect(result.snapshot).toBeNull();
    expect(result.note).toMatch(/starting clean/);
  });

  it('returns null on malformed JSON, with a note', async () => {
    await fs.writeFile(path.join(dir, STATE_FILENAME), 'not json', 'utf8');
    const result = await loadStateFromDisk(dir);
    expect(result.snapshot).toBeNull();
    expect(result.note).toMatch(/not valid JSON/);
  });

  it('returns null on a wrong-shape JSON, with a note', async () => {
    await fs.writeFile(path.join(dir, STATE_FILENAME), JSON.stringify({ foo: 1 }), 'utf8');
    const result = await loadStateFromDisk(dir);
    expect(result.snapshot).toBeNull();
    expect(result.note).toMatch(/unexpected shape/);
  });

  it('saves and reloads a valid snapshot', async () => {
    await saveStateToDisk(dir, {
      version: 1,
      savedAt: 12345,
      issues: { i1: { state: 'running', attemptCount: 2, failureCount: 0 } },
    });
    const loaded = await loadStateFromDisk(dir);
    expect(loaded.snapshot?.issues['i1']?.state).toBe('running');
    expect(loaded.note).toMatch(/loaded 1 issue records/);
  });

  it('save is atomic (temp file is renamed, never left behind on success)', async () => {
    await saveStateToDisk(dir, { version: 1, savedAt: 0, issues: {} });
    const entries = await fs.readdir(dir);
    expect(entries).toContain(STATE_FILENAME);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('creates the directory if missing', async () => {
    const nested = path.join(dir, 'does', 'not', 'exist');
    await saveStateToDisk(nested, { version: 1, savedAt: 0, issues: {} });
    const entries = await fs.readdir(nested);
    expect(entries).toContain(STATE_FILENAME);
  });
});
