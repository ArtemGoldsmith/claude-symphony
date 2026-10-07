// tests/control-plane/lock.test.ts
import { mkdtemp, rm, mkdir, utimes, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { SingletonLock, LockHeldError } from '../../src/control-plane/lock.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-lock-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(`${root}.lock`, { recursive: true, force: true });
});

describe('SingletonLock', () => {
  it('acquires when free and creates the lock dir', async () => {
    const lock = new SingletonLock(root);
    await lock.acquire();
    await expect(access(`${root}.lock`)).resolves.toBeUndefined();
    await lock.release();
  });

  it('refuses a second acquire while the lock is held', async () => {
    const a = new SingletonLock(root);
    await a.acquire();
    const b = new SingletonLock(root);
    await expect(b.acquire()).rejects.toThrow(LockHeldError);
    await a.release();
  });

  it('release removes the lock and allows re-acquire', async () => {
    const a = new SingletonLock(root);
    await a.acquire();
    await a.release();
    const b = new SingletonLock(root);
    await expect(b.acquire()).resolves.toBeUndefined();
    await b.release();
  });

  it('takes over a stale lock (old mtime) left by a dead instance', async () => {
    // Forge a stale lock dir whose mtime is far older than `staleMs`.
    await mkdir(`${root}.lock`, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    await utimes(`${root}.lock`, past, past);
    const lock = new SingletonLock(root, { staleMs: 5_000 });
    await lock.acquire(); // proper-lockfile sees the stale mtime and takes over
    await lock.release();
  });
});
