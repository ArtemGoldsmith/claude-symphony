// src/control-plane/task-store.ts
// Spec §5 store + §12 integrity: one writer, per-task FIFO mutation queue,
// read→CAS(rev)→atomic-write. scan()/snapshot live in Task 4 (appended).

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type TaskRecord,
  newTaskRecord,
  readTaskRecord,
  writeTaskRecord,
  taskDir,
} from './task-record.js';
import { type Phase, assertTransition, isTerminalPhase } from './phase.js';

export const SNAPSHOT_FILENAME = '.symphony-index.json';

/** Roll-up index for fast board first-paint (spec §5). task.json stays source of truth. */
export interface SnapshotIndex {
  version: 1;
  savedAt: number;
  tickets: string[];
}

/** PIN-NNN directory name matcher (mirrors orchestrator recoverFromDisk:271). */
const TICKET_DIR = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

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

  /**
   * Return the live record for a CAS, reconciling the cache from disk first.
   * If disk has a NEWER rev than the cache (a different generation wrote it),
   * adopt the disk record so the CAS compares against the true latest rev.
   */
  private async liveForCas(ticket: string): Promise<TaskRecord> {
    const cached = this.cache.get(ticket);
    const disk = await readTaskRecord(this.stateRoot, ticket);
    if (!cached && !disk) throw new UnknownTaskError(ticket);
    if (disk && (!cached || disk.rev > cached.rev)) {
      this.cache.set(ticket, disk);
      return disk;
    }
    return cached!;
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
      const live = await this.liveForCas(ticket);
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

  /**
   * Archive a tracked ticket's state dir (move to $STATE_ROOT/.archive/<ticket>-<rev>-<ts>)
   * and evict it from the cache, so a subsequent create() can re-add the same
   * identifier (spec §9/§12 terminal re-add). Runs inside the per-task queue.
   * Refuses a non-terminal task (defense-in-depth — the store is not a generic
   * "delete any task" primitive).
   */
  async archive(ticket: string): Promise<void> {
    return this.enqueue(ticket, async () => {
      const live = await this.liveForCas(ticket); // throws UnknownTaskError if absent
      if (!isTerminalPhase(live.phase)) {
        throw new Error(`refusing to archive ${ticket}: phase ${live.phase} is not terminal`);
      }
      const src = taskDir(this.stateRoot, ticket);
      const archiveRoot = path.join(this.stateRoot, '.archive');
      await fs.mkdir(archiveRoot, { recursive: true });
      const dest = path.join(archiveRoot, `${ticket}-${live.rev}-${this.now()}`);
      await fs.rename(src, dest);
      this.cache.delete(ticket);
    });
  }

  /**
   * CAS-update fields WITHOUT a phase transition (spec §12 — currentRun/session
   * writes that don't change phase still go through the per-task queue + rev bump).
   */
  async updateRun(
    ticket: string,
    expectRev: number,
    mutate: (record: TaskRecord) => void,
  ): Promise<TaskRecord> {
    return this.enqueue(ticket, async () => {
      const live = await this.liveForCas(ticket);
      if (live.rev !== expectRev) throw new StaleRevError(ticket, expectRev, live.rev);
      const next: TaskRecord = structuredClone(live);
      next.rev = live.rev + 1;
      next.updatedAt = this.now();
      next.ownerGen = this.ownerGen;
      mutate(next);
      // Invariant: updateRun is transition-free — a phase change must go through
      // advance() so it is validated + slot-accounted.
      if (next.phase !== live.phase) {
        throw new Error(`updateRun must not change phase (${live.phase} → ${next.phase}); use advance()`);
      }
      await writeTaskRecord(this.stateRoot, next);
      this.cache.set(ticket, next);
      return structuredClone(next);
    });
  }

  // Boot seed: load every $STATE_ROOT/PIN-NNN/task.json into the cache.
  // (line comment, not JSDoc — a */ glob inside a block comment would close it early)
  async scan(): Promise<TaskRecord[]> {
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(this.stateRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const tickets = entries
      .filter((e) => e.isDirectory() && TICKET_DIR.test(e.name))
      .map((e) => e.name)
      .sort();
    const loaded: TaskRecord[] = [];
    for (const ticket of tickets) {
      const r = await readTaskRecord(this.stateRoot, ticket);
      if (r) {
        this.cache.set(ticket, r);
        loaded.push(structuredClone(r));
      }
    }
    return loaded;
  }

  async list(): Promise<TaskRecord[]> {
    return [...this.cache.values()].map((r) => structuredClone(r)).sort((a, b) =>
      a.ticket.localeCompare(b.ticket),
    );
  }

  /** Atomically write the roll-up index (tmp + rename). */
  async saveSnapshot(): Promise<void> {
    const index: SnapshotIndex = {
      version: 1,
      savedAt: this.now(),
      tickets: [...this.cache.keys()].sort(),
    };
    await fs.mkdir(this.stateRoot, { recursive: true });
    const file = path.join(this.stateRoot, SNAPSHOT_FILENAME);
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  /** Read the index; null if missing or malformed (spec §12 tolerant). */
  async loadSnapshot(): Promise<SnapshotIndex | null> {
    const file = path.join(this.stateRoot, SNAPSHOT_FILENAME);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && Array.isArray(parsed.tickets)) {
        return parsed as SnapshotIndex;
      }
      return null;
    } catch {
      return null;
    }
  }
}
