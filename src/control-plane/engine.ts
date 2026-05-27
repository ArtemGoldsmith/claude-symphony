// src/control-plane/engine.ts
// Spec §10: the dispatcher = also the steady-state reconcile poll. Ties the store,
// the slot counter, and a dispatch port. No HTTP/preview (Plans 3/4). Slot
// reservation is synchronous and happens BEFORE the async dispatch so two ticks
// cannot over-commit. The slot counter is seeded from phases ONCE at boot; from
// then on it is maintained by `tryReserve` (promotion into the ⊕set) and an
// EXPLICIT `release` in routeExit (leaving the ⊕set) — never a phase-reseed, which
// could drop a reserved-but-not-yet-persisted slot.

import { isActiveRunPhase, isSlotPhase, type Phase } from './phase.js';
import { readPidFile } from './proc.js';
import { nextOnAgentExit } from './routing.js';
import type { SlotCounter } from './slots.js';
import { taskDir, type RunRecord, type TaskRecord } from './task-record.js';
import type { TaskStore } from './task-store.js';

export interface DispatchArgs {
  store: TaskStore;
  ticket: string;
  expectRev: number;
  to: Phase;
  kind: RunRecord['kind'];
}

/** Port the Engine uses to start a run. Real impl wraps ProcessManager (Task 12). */
export interface Dispatcher {
  dispatch(args: DispatchArgs): Promise<void>;
}

export interface EngineOptions {
  store: TaskStore;
  slots: SlotCounter;
  dispatcher: Dispatcher;
  /** Inspect review-fresh.md for MISSING/PARTIAL gaps (real impl in Task 12). */
  reviewHasGaps: (stateDir: string) => Promise<boolean>;
  /** State root, for resolving a task's state dir (reviewHasGaps). */
  stateRoot: string;
  /** This daemon generation — fences routing across a stale-lock takeover (§10). */
  ownerGen: string;
  now?: () => number;
  /** Optional warn sink (e.g. pino logger.warn). */
  logWarn?: (msg: string, meta?: Record<string, unknown>) => void;
  /**
   * Probe whether a finished run exited cleanly. Real impl uses
   * ProcessManager.detectCompletion; tests inject a result directly. Returns
   * `null` when the run is still running/unknown (do not route yet).
   */
  probeExit?: (task: TaskRecord) => Promise<{ ok: boolean } | null>;
}

export class Engine {
  private readonly store: TaskStore;
  private readonly slots: SlotCounter;
  private readonly dispatcher: Dispatcher;
  private readonly reviewHasGaps: (stateDir: string) => Promise<boolean>;
  private readonly stateRoot: string;
  private readonly ownerGen: string;
  private readonly logWarn: (msg: string, meta?: Record<string, unknown>) => void;
  private readonly probeExit: (task: TaskRecord) => Promise<{ ok: boolean } | null>;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.slots = opts.slots;
    this.dispatcher = opts.dispatcher;
    this.reviewHasGaps = opts.reviewHasGaps;
    this.stateRoot = opts.stateRoot;
    this.ownerGen = opts.ownerGen;
    this.logWarn = opts.logWarn ?? (() => undefined);
    this.probeExit = opts.probeExit ?? (async () => null);
  }

  /**
   * Boot: scan once (carry-forward #1 — exactly once, before queue activity),
   * seed the slot counter from current phases, ADOPT in-flight runs by stamping
   * this generation's ownerGen onto them (§10 fencing — only the adopting gen
   * routes them), then reconcile.
   */
  async boot(): Promise<void> {
    await this.store.scan();
    const tasks = await this.store.list();
    this.slots.seedFrom(tasks.map((t) => t.phase)); // seed ONCE; release is explicit hereafter
    for (const t of tasks) {
      if (!isActiveRunPhase(t.phase) || !t.currentRun) continue;
      // Adopt the run for this generation: stamp ownerGen, and (codex C1) recover
      // pid/pidStart from the wrapper's <runId>.pid file if they were never
      // backfilled (daemon died between spawn and backfill) — so liveness can be
      // proven and a still-running long agent is NOT mis-judged crashed.
      const run = t.currentRun;
      const needsGen = run.ownerGen !== this.ownerGen;
      let pid = run.pid;
      let pidStart = run.pidStart;
      if (pid === null) {
        const fromFile = await readPidFile(taskDir(this.stateRoot, t.ticket), run.runId);
        if (fromFile) {
          pid = fromFile.pid;
          pidStart = fromFile.pidStart;
        }
      }
      if (needsGen || pid !== run.pid || pidStart !== run.pidStart) {
        await this.store.updateRun(t.ticket, t.rev, (r) => {
          if (r.currentRun) {
            r.currentRun.ownerGen = this.ownerGen;
            r.currentRun.pid = pid;
            r.currentRun.pidStart = pidStart;
          }
        });
      }
    }
    await this.reconcile();
  }

  /**
   * Promote queued→prepping and approved→executing in createdAt order while a
   * slot is free, then route any finished active runs. Slot reservation is
   * synchronous BEFORE the async dispatch (§10); release is explicit on leaving
   * the ⊕set (NOT via a phase-reseed, which could drop a reserved-not-yet-
   * dispatched slot — codex HIGH #1).
   */
  async tick(): Promise<void> {
    const tasks = (await this.store.list()).sort((a, b) => a.createdAt - b.createdAt);
    for (const t of tasks) {
      // Lane A/B: steady-state promotions.
      const promo: { to: Phase; kind: RunRecord['kind'] } | null =
        t.phase === 'queued'
          ? { to: 'prepping', kind: 'prep' }
          : t.phase === 'approved'
            ? { to: 'executing', kind: 'execute' }
            : null;
      if (promo) {
        if (!this.slots.tryReserve()) break;
        try {
          await this.dispatcher.dispatch({ store: this.store, ticket: t.ticket, expectRev: t.rev, to: promo.to, kind: promo.kind });
        } catch (err) {
          // Release the slot ONLY if the claim never landed (task did not enter the
          // ⊕ phase). If the claim landed but spawn/backfill threw, the task holds
          // this slot and routeExit releases it later — releasing here double-counts.
          const after = await this.store.get(t.ticket);
          const landed = !!after && after.phase === promo.to;
          if (!landed) {
            this.slots.release();
            // A pre-claim FIRST-PREP failure (intake/Linear/git) must be board-visible,
            // not a silent every-tick retry. Surface queued→prep_failed.
            if (after && promo.to === 'prepping') {
              try {
                await this.store.advance(t.ticket, { expectRev: after.rev, to: 'prep_failed', mutate: (r) => { r.failedFrom = 'prepping'; } });
              } catch { /* rev moved on; next tick re-evaluates */ }
              this.logWarn('first-prep intake failed → prep_failed', { ticket: t.ticket, error: (err as Error).message });
              continue;
            }
          }
          throw err;
        }
        continue;
      }
      // Lane C: granular retry. Only execute-chain failures are wired (Plan 3).
      // only re-enter from a failure phase — never double-reserve from a slot phase
      if (t.phase.endsWith('_failed') && t.retryRequested && t.failedFrom && Engine.RETRY_KIND[t.failedFrom]) {
        const target = t.failedFrom;
        const kind = Engine.RETRY_KIND[target]!;
        if (!this.slots.tryReserve()) break;
        try {
          if (target === 'executing' || target === 'prepping') {
            // Reserving dispatch: the dispatcher runs clean-room/intake + claims the
            // advance (clearing retryRequested in its mutate).
            await this.dispatcher.dispatch({ store: this.store, ticket: t.ticket, expectRev: t.rev, to: target, kind });
          } else {
            // Chain continuation: advance into the chain phase (slot now held), clear
            // the flag + null the run; ensureRunning dispatches the agent.
            await this.store.advance(t.ticket, {
              expectRev: t.rev, to: target,
              mutate: (r) => { r.retryRequested = false; r.currentRun = null; },
            });
          }
        } catch (err) {
          // Same as the promo lane: release ONLY if the (re)entry did not land.
          const after = await this.store.get(t.ticket);
          const landed = !!after && after.phase === target;
          if (!landed) {
            this.slots.release();
            // Clear the flag at the rev WE read (not latest), so a concurrently re-set
            // flag (newer rev) is not clobbered. Deterministic failure → clears → no loop.
            try { await this.store.updateRun(t.ticket, t.rev, (r) => { r.retryRequested = false; }); } catch { /* rev moved on; leave it */ }
          }
          this.logWarn('retry lane error', { ticket: t.ticket, landed, error: (err as Error).message });
          continue;
        }
        continue;
      }
    }
    await this.routeFinishedRuns();
    await this.ensureRunning();
  }

  /**
   * The agent kind each chain ⊕ phase runs. prepping/executing are entered via a
   * reserving promotion in tick(); reviewing/gapfixing/closing are entered via
   * routeExit (which nulls currentRun) and run a CONTINUATION agent on the SAME
   * slot — so ensureRunning dispatches them WITHOUT reserving. previewing has no
   * entry here (its agent is preview-up, Plan 4).
   */
  private static readonly CHAIN_AGENT: Partial<Record<Phase, RunRecord['kind']>> = {
    reviewing: 'review',
    gapfixing: 'gapfix',
    closing: 'closeout',
  };

  /** The agent kind to (re)dispatch when re-entering each phase on retry. */
  private static readonly RETRY_KIND: Partial<Record<Phase, RunRecord['kind']>> = {
    prepping: 'prep',
    executing: 'execute',
    reviewing: 'review',
    gapfixing: 'gapfix',
    closing: 'closeout',
  };

  /**
   * Dispatch the continuation agent for any chain ⊕ phase task that holds its slot
   * but has no live run (just routed in, or its run record was lost on restart).
   * No slot reservation — the slot is already held by virtue of the ⊕ phase.
   */
  async ensureRunning(): Promise<void> {
    const tasks = await this.store.list();
    for (const t of tasks) {
      if (t.currentRun) continue; // a run is present (running or awaiting routeExit)
      const kind = Engine.CHAIN_AGENT[t.phase];
      if (!kind) continue;
      await this.dispatcher.dispatch({
        store: this.store,
        ticket: t.ticket,
        expectRev: t.rev,
        to: t.phase, // continuation: stay in the same ⊕ phase (claim via updateRun)
        kind,
      });
    }
  }

  /** For every activeRunSet task, route if its run finished. */
  private async routeFinishedRuns(): Promise<void> {
    const tasks = await this.store.list();
    for (const t of tasks) {
      if (isActiveRunPhase(t.phase) && t.currentRun) {
        await this.routeExit(t.ticket);
      }
    }
  }

  /**
   * Route a single task's finished run. No-op if the run belongs to another
   * generation (§10 fencing), is preview/teardown (Plan 4), or is still running.
   * On clean/failed exit applies nextOnAgentExit and releases the slot iff the
   * task LEFT the ⊕set. closing→previewing stays ⊕ (slot retained) — until Plan 4
   * wires the preview driver, a task parks in `previewing` holding its slot; this
   * is acceptable because the pipeline cannot reach `closing` in production without
   * the execute/preview backend Plan 4 completes. The engine logs a warning so the
   * park is visible (codex HIGH #5).
   */
  async routeExit(ticket: string): Promise<void> {
    const t = await this.store.get(ticket);
    if (!t || !t.currentRun) return;
    if (!isActiveRunPhase(t.phase)) return;
    if (t.currentRun.kind === 'preview' || t.currentRun.kind === 'teardown') return; // Plan 4
    if (t.currentRun.ownerGen !== this.ownerGen) return; // not ours to route

    const result = await this.probeExit(t);
    if (result === null) return; // still running / within grace

    const route = nextOnAgentExit(t.phase, result.ok);
    let to: Phase = route.to;
    if (t.phase === 'reviewing' && result.ok && route.alt) {
      const hasGaps = await this.reviewHasGaps(taskDir(this.stateRoot, ticket));
      to = hasGaps ? route.alt : route.to; // gaps → gapfixing, else → closing
    }

    const from = t.phase;
    await this.store.advance(ticket, {
      expectRev: t.rev,
      to,
      mutate: (r) => {
        if (route.failedFrom) r.failedFrom = route.failedFrom;
        // The run is done. Keep currentRun only when the SAME run continues in a
        // new ⊕ phase via a fresh dispatch (not here — dispatch sets its own run).
        r.currentRun = null;
      },
    });
    // Explicit slot release: only when leaving the ⊕set.
    if (isSlotPhase(from) && !isSlotPhase(to)) this.slots.release();
    if (to === 'previewing') {
      this.logWarn('task reached previewing; awaiting Plan-4 preview driver (slot held)', { ticket });
    }
  }

  /** Reconcile after a (re)boot: route finished runs, then re-dispatch any chain
   *  ⊕ phase that lost its run record. */
  async reconcile(): Promise<void> {
    await this.routeFinishedRuns();
    await this.ensureRunning();
  }
}
