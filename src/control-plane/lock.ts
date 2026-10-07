// src/control-plane/lock.ts
// Spec §10 single-daemon instance, via proper-lockfile (mtime-based staleness;
// no hand-rolled takeover race). The lock dir is `${stateRoot}.lock`.

import fs from 'node:fs/promises';
import lockfile from 'proper-lockfile';

export class LockHeldError extends Error {
  constructor() {
    super('control-plane lock already held by a live instance');
    this.name = 'LockHeldError';
  }
}

export interface SingletonLockOptions {
  /** Lock is considered stale (holder dead, stopped refreshing) after this many ms. */
  staleMs?: number;
  /** Invoked if the held lock is compromised (stolen by another instance). */
  onCompromised?: (err: Error) => void;
}

export class SingletonLock {
  private release_: (() => Promise<void>) | null = null;

  constructor(
    private readonly stateRoot: string,
    private readonly opts: SingletonLockOptions = {},
  ) {}

  async acquire(): Promise<void> {
    await fs.mkdir(this.stateRoot, { recursive: true });
    try {
      // realpath:false → lock literally at `${stateRoot}.lock` (tmp-dir friendly).
      // proper-lockfile auto-refreshes mtime while held; a dead holder stops
      // refreshing and the lock goes stale after `stale` ms, enabling takeover.
      this.release_ = await lockfile.lock(this.stateRoot, {
        stale: this.opts.staleMs ?? 30_000,
        realpath: false,
        onCompromised: this.opts.onCompromised ?? ((err) => { throw err; }),
      });
    } catch (err) {
      if ((err as { code?: string }).code === 'ELOCKED') throw new LockHeldError();
      throw err;
    }
  }

  async release(): Promise<void> {
    if (!this.release_) return;
    const release = this.release_;
    this.release_ = null;
    await release();
  }
}
