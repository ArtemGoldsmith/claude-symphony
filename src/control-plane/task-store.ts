// src/control-plane/task-store.ts
// Spec §5 store + §12 integrity: one writer, per-task FIFO mutation queue,
// read→CAS(rev)→atomic-write. scan()/snapshot live in Task 4 (appended).

import {
  type TaskRecord,
  newTaskRecord,
  readTaskRecord,
  writeTaskRecord,
} from './task-record.js';
import { type Phase, assertTransition } from './phase.js';

export class StaleRevError extends Error {
  constructor(ticket: string, expected: number, actual: number) {
    super(`stale rev for ${ticket}: expected ${expected}, found ${actual}`);
    this.name = 'StaleRevError';
  }
}

export class UnknownTaskError extends Error {
  constructor(ticket: string) {
    super(`no task record for ${ticket}`);
    this.name = 'UnknownTaskError';
  }
}

export class TaskExistsError extends Error {
  constructor(ticket: string) {
    super(`task ${ticket} already tracked`);
    this.name = 'TaskExistsError';
  }
}

export interface TaskStoreOptions {
  stateRoot: string;
  ownerGen: string;
  now?: () => number;
}

export interface AdvanceArgs {
  /** CAS guard — the advance applies only if the live rev still equals this. */
  expectRev: number;
  to: Phase;
  /** Optional mutation applied under the same CAS, before the write. */
  mutate?: (record: TaskRecord) => void;
}

export class TaskStore {
  private readonly stateRoot: string;
  private readonly ownerGen: string;
  private readonly now: () => number;
  /** In-memory authoritative copy, keyed by ticket. */
  private readonly cache = new Map<string, TaskRecord>();
  /** Per-task FIFO: every mutation chains onto the prior one (spec §12). */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: TaskStoreOptions) {
    this.stateRoot = opts.stateRoot;
    this.ownerGen = opts.ownerGen;
    this.now = opts.now ?? Date.now;
  }

  /** Serialize `fn` after any in-flight mutation for `ticket`. */
  private enqueue<T>(ticket: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.chains.get(ticket) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    // Keep the chain alive regardless of fn's outcome; swallow to avoid unhandled rejection.
    this.chains.set(
      ticket,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async create(args: { ticket: string; title: string; url: string }): Promise<TaskRecord> {
    return this.enqueue(args.ticket, async () => {
      // Reject a ticket already tracked in-memory OR on disk (spec §12 — the
      // web layer handles the terminal-archive flow before calling create).
      // The existence check runs inside the per-task queue, so concurrent
      // POSTs for the same ticket can't both create.
      if (this.cache.has(args.ticket) || (await readTaskRecord(this.stateRoot, args.ticket))) {
        throw new TaskExistsError(args.ticket);
      }
      const record = newTaskRecord({ ...args, ownerGen: this.ownerGen, now: this.now() });
      await writeTaskRecord(this.stateRoot, record);
      this.cache.set(args.ticket, record);
      return structuredClone(record);
    });
  }

  /**
   * Return a defensive copy of the cached (authoritative) record, or with
   * `fresh:true` a read-only disk peek. The fresh path MUST NOT write the
   * cache — the cache is mutated only through the per-task queue, so a
   * concurrent fresh read can never clobber it with a staler disk record.
   */
  async get(ticket: string, opts: { fresh?: boolean } = {}): Promise<TaskRecord | null> {
    if (opts.fresh) {
      const r = await readTaskRecord(this.stateRoot, ticket);
      return r ? structuredClone(r) : null;
    }
    const c = this.cache.get(ticket);
    return c ? structuredClone(c) : null;
  }

  /**
   * CAS-advance: under the per-task queue, verify rev + legal transition,
   * apply the optional mutator, bump rev, atomically persist.
   */
  async advance(ticket: string, args: AdvanceArgs): Promise<TaskRecord> {
    return this.enqueue(ticket, async () => {
      const live = this.cache.get(ticket);
      if (!live) throw new UnknownTaskError(ticket);
      if (live.rev !== args.expectRev) throw new StaleRevError(ticket, args.expectRev, live.rev);
      assertTransition(live.phase, args.to);

      const next: TaskRecord = structuredClone(live);
      next.phase = args.to;
      next.rev = live.rev + 1;
      next.updatedAt = this.now();
      next.ownerGen = this.ownerGen;
      if (args.mutate) args.mutate(next);

      await writeTaskRecord(this.stateRoot, next);
      this.cache.set(ticket, next);
      return structuredClone(next);
    });
  }
}
