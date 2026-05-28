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

/** What readPreviewOutcome reports from preview.json + the worktree HEAD (§8.3). */
export interface PreviewOutcome {
  state: string;       // preview.json.state
  gitSha: string;      // preview.json.gitSha
  url: string;         // https://<caddyVhost>
  headMatches: boolean; // preview.json.gitSha === `git rev-parse HEAD`
}

/** One open question, as loaded from open-questions.json (the control plane owns the rev). */
export type OpenQuestionItem = NonNullable<TaskRecord['openQuestions']>['items'][number];

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
  /** §8 guard at closing→previewing: worktree clean AND HEAD != baseSha. Exception
   *  → treated as guard-fail. Default allows (tests inject the I/O). */
  canPreview?: (task: TaskRecord) => Promise<boolean>;
  /** Read preview.json (+ HEAD) after a preview run. Default returns null. */
  readPreviewOutcome?: (task: TaskRecord) => Promise<PreviewOutcome | null>;
  /** Load open-questions.json items at prepping→awaiting_approval (control plane
   *  assigns the rev). Default returns null → empty question set. */
  loadOpenQuestions?: (task: TaskRecord) => Promise<OpenQuestionItem[] | null>;
  /** Load stage9.json at previewing→ready. Default returns null → empty stage9. */
  loadStage9?: (task: TaskRecord) => Promise<TaskRecord['stage9']>;
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
  private readonly canPreview: (task: TaskRecord) => Promise<boolean>;
  private readonly readPreviewOutcome: (task: TaskRecord) => Promise<PreviewOutcome | null>;
  private readonly loadOpenQuestions: (task: TaskRecord) => Promise<OpenQuestionItem[] | null>;
  private readonly loadStage9: (task: TaskRecord) => Promise<TaskRecord['stage9']>;

  constructor(opts: EngineOptions) {
    this.store = opts.store;
    this.slots = opts.slots;
    this.dispatcher = opts.dispatcher;
    this.reviewHasGaps = opts.reviewHasGaps;
    this.stateRoot = opts.stateRoot;
    this.ownerGen = opts.ownerGen;
    this.logWarn = opts.logWarn ?? (() => undefined);
    this.probeExit = opts.probeExit ?? (async () => null);
    this.canPreview = opts.canPreview ?? (async () => true);
    this.readPreviewOutcome = opts.readPreviewOutcome ?? (async () => null);
    this.loadOpenQuestions = opts.loadOpenQuestions ?? (async () => null);
    this.loadStage9 = opts.loadStage9 ?? (async () => null);
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
        if (!this.slots.tryReserve()) continue; // slots only decrease within a tick → FIFO preserved; continue lets later non-slot retries run
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
      // Lane C: granular retry (§17 + §8.3). Slot reserved only when the re-entry
      // target is itself a ⊕ phase (previewing yes; tearing_down no).
      if (t.phase.endsWith('_failed') && t.retryRequested && t.failedFrom && Engine.RETRY_KIND[t.failedFrom]) {
        const target = t.failedFrom;
        const kind = Engine.RETRY_KIND[target]!;
        const needsSlot = isSlotPhase(target);
        if (needsSlot && !this.slots.tryReserve()) continue; // codex HIGH: continue, not break — don't starve later non-slot teardown retries
        try {
          if (target === 'executing' || target === 'prepping') {
            // Reserving dispatch: the dispatcher runs clean-room/intake + claims.
            await this.dispatcher.dispatch({ store: this.store, ticket: t.ticket, expectRev: t.rev, to: target, kind });
          } else {
            // Continuation re-entry (reviewing/gapfixing/closing/previewing/tearing_down):
            // advance into the phase, clear the flag + null the run; ensureRunning
            // dispatches the agent/script on the (now-held, or none) slot.
            await this.store.advance(t.ticket, {
              expectRev: t.rev, to: target,
              mutate: (r) => { r.retryRequested = false; r.currentRun = null; },
            });
          }
        } catch (err) {
          const after = await this.store.get(t.ticket);
          const landed = !!after && after.phase === target;
          if (!landed) {
            if (needsSlot) this.slots.release();
            try { await this.store.updateRun(t.ticket, t.rev, (r) => { r.retryRequested = false; }); } catch { /* rev moved on */ }
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
   * The kind each ⊕/active phase (re)dispatches as a CONTINUATION (no slot
   * reservation — the phase already implies its slot, or holds none). Chain agents
   * (review/gapfix/closeout) plus the Plan-4 scripts (preview/teardown).
   */
  private static readonly CONTINUATION_KIND: Partial<Record<Phase, RunRecord['kind']>> = {
    reviewing: 'review',
    gapfixing: 'gapfix',
    closing: 'closeout',
    previewing: 'preview',
    tearing_down: 'teardown',
  };

  /** The agent kind to (re)dispatch when re-entering each phase on retry. */
  private static readonly RETRY_KIND: Partial<Record<Phase, RunRecord['kind']>> = {
    prepping: 'prep',
    executing: 'execute',
    reviewing: 'review',
    gapfixing: 'gapfix',
    closing: 'closeout',
    previewing: 'preview',
    tearing_down: 'teardown',
  };

  /**
   * Dispatch the continuation for any ⊕/active phase task that has no live run
   * (just routed in, or its run record was lost on restart). No slot reservation —
   * the slot is already held by virtue of the ⊕ phase (or tearing_down holds none).
   */
  async ensureRunning(): Promise<void> {
    const tasks = await this.store.list();
    for (const t of tasks) {
      if (t.currentRun) continue; // a run is present (running or awaiting routeExit)
      const kind = Engine.CONTINUATION_KIND[t.phase];
      if (!kind) continue;
      await this.dispatcher.dispatch({
        store: this.store,
        ticket: t.ticket,
        expectRev: t.rev,
        to: t.phase, // continuation: stay in the same phase (claim via updateRun)
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

  async routeExit(ticket: string): Promise<void> {
    const t = await this.store.get(ticket);
    if (!t || !t.currentRun) return;
    if (!isActiveRunPhase(t.phase)) return;
    if (t.currentRun.ownerGen !== this.ownerGen) return; // not ours to route (§10 fencing)

    const result = await this.probeExit(t); // for preview/teardown this also enforces the ceiling
    if (result === null) return; // still running / within grace

    const kind = t.currentRun.kind;
    if (kind === 'preview' || kind === 'teardown') {
      await this.routeScriptExit(t, result.ok);
      return;
    }

    const from = t.phase;
    const route = nextOnAgentExit(from, result.ok);
    let to: Phase = route.to;
    let failedFrom = route.failedFrom;
    if (from === 'reviewing' && result.ok && route.alt) {
      const hasGaps = await this.reviewHasGaps(taskDir(this.stateRoot, ticket));
      to = hasGaps ? route.alt : route.to;
    }
    // §8 guard: a clean closeout would route closing→previewing only if the worktree
    // is clean and HEAD != baseSha. A guard failure (or a thrown probe) re-runs the
    // executor instead of previewing stale/uncommitted code.
    if (from === 'closing' && result.ok && to === 'previewing') {
      let allowed: boolean;
      try { allowed = await this.canPreview(t); } catch { allowed = false; }
      if (!allowed) { to = 'execute_failed'; failedFrom = 'executing'; }
    }

    // Load prep output into the record so the awaiting_approval gate renders (§5).
    // The control plane owns the rev (fresh monotonic each prep completion, incl.
    // retries); answers are cleared so a re-prep can't approve against stale answers.
    let oqItems: OpenQuestionItem[] | null = null;
    if (from === 'prepping' && to === 'awaiting_approval') {
      try { oqItems = await this.loadOpenQuestions(t); } catch { oqItems = null; }
    }

    await this.store.advance(ticket, {
      expectRev: t.rev, to,
      mutate: (r) => {
        if (failedFrom) r.failedFrom = failedFrom;
        if (from === 'prepping' && to === 'awaiting_approval') {
          r.openQuestions = { rev: (t.openQuestions?.rev ?? 0) + 1, items: oqItems ?? [] };
          r.answers = null;
        }
        r.currentRun = null;
      },
    });
    if (isSlotPhase(from) && !isSlotPhase(to)) this.slots.release();
  }

  /**
   * Route a finished preview/teardown SCRIPT run. Exit code is authoritative (the
   * script can leave preview.json stuck at "starting" on a build failure, §8). The
   * shared slot-release guard runs at the end so previewing→{ready,preview_failed}
   * releases its slot and tearing_down (no slot) releases nothing (§8.3 H2).
   */
  private async routeScriptExit(t: TaskRecord, ok: boolean): Promise<void> {
    const from = t.phase;
    let to: Phase;
    let mutate: (r: TaskRecord) => void;

    if (from === 'previewing') {
      let outcome: PreviewOutcome | null = null;
      try { outcome = await this.readPreviewOutcome(t); } catch { outcome = null; }
      if (ok && outcome && outcome.state === 'up' && outcome.headMatches) {
        to = 'ready';
        // Load closeout's stage9.json so the ready gate renders (§5). Fall back to an
        // empty stage9 stamped with this gitSha so approve-preview is still reachable.
        let stage9: TaskRecord['stage9'] = null;
        try { stage9 = await this.loadStage9(t); } catch { stage9 = null; }
        const loadedStage9 = stage9 ?? { attemptId: t.attempts.execute, gitSha: outcome.gitSha, items: [] };
        mutate = (r) => { r.preview = { url: outcome!.url, gitSha: outcome!.gitSha, state: 'up' }; r.stage9 = loadedStage9; r.currentRun = null; };
      } else {
        to = 'preview_failed';
        // H1: record task.preview from the (possibly stuck) outcome so /teardown +
        // the board see that real compute may be live and needs reclaiming.
        const preview = outcome
          ? { url: '', gitSha: outcome.gitSha, state: outcome.state }
          : { url: '', gitSha: '', state: 'failed' };
        mutate = (r) => { r.failedFrom = 'previewing'; r.preview = preview; r.currentRun = null; };
      }
    } else {
      // tearing_down
      if (ok) {
        const target: Phase = t.teardownTarget ?? 'abandoned';
        to = target;
        mutate = (r) => {
          r.currentRun = null;
          r.teardownTarget = null;
          r.preview = null; // compute reclaimed (§8.3 M3)
          if (target === 'abandoned') r.terminalReason = 'abandoned';
        };
      } else {
        to = 'teardown_failed';
        mutate = (r) => { r.failedFrom = 'tearing_down'; r.currentRun = null; };
      }
    }

    await this.store.advance(t.ticket, { expectRev: t.rev, to, mutate });
    if (isSlotPhase(from) && !isSlotPhase(to)) this.slots.release();
  }

  /** Reconcile after a (re)boot: route finished runs, then re-dispatch any chain
   *  ⊕ phase that lost its run record. */
  async reconcile(): Promise<void> {
    await this.routeFinishedRuns();
    await this.ensureRunning();
  }
}
