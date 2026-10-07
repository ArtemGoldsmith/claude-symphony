// SPEC.md §3.1.4 + §7 + §8 + §16 — Orchestrator (MVP subset).
// PARITY.md rows: §3.1.4, §7.1, §7.3, §8.1, §8.2, §8.3, §8.4 (partial),
// §16.2, §16.4, §16.6 (partial).
//
// Owns the poll-and-dispatch loop. MVP behavior:
//   - Poll Linear at `polling.interval_ms`.
//   - Dispatch up to `agent.max_concurrent_agents` issues concurrently.
//   - On dispatch failure (agent error/timeout, hook failure, infra blip),
//     schedule a single retry after a fixed delay; second failure is final.
//   - In-flight dispatches are drained on stop().
//
// Reconcile (§8.5), exponential backoff (§8.4 full), restart recovery
// (§14.3), continuation (§12.3), and stall-detection feedback (§10.6)
// are Phase 2.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedWorkflowConfig } from '../config/resolve.js';
import type { LinearGateway, LinearWriteGateway } from '../linear/gateway.js';
import type { Issue } from '../linear/issue.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { AgentRunner, type AgentRunResult } from '../agent/runner.js';
import { buildIssueView, renderPrompt } from '../agent/prompt.js';
import { createSymphonyLinearMcpServer } from '../agent/symphony-linear-server.js';
import { HookExecutionError, runHook } from '../workspace/hooks.js';

export interface OrchestratorEvent {
  type:
    | 'tick_started'
    | 'tick_completed'
    | 'dispatch_started'
    | 'dispatch_completed'
    | 'dispatch_failed'
    | 'continuation_scheduled'
    | 'retry_scheduled'
    | 'retry_skipped'
    | 'reconcile_aborted'
    | 'startup_recovery'
    | 'workspace_cleaned'
    | 'config_reloaded'
    | 'reactivation_detected'
    | 'agent_stderr';
  at: number;
  issueId?: string;
  issueIdentifier?: string;
  error?: string;
  result?: AgentRunResult;
  retryAt?: number;
  /**
   * When type === 'continuation_scheduled', the Linear state the issue was in
   * at the time the orchestrator decided the agent's job wasn't done yet.
   * When type === 'reconcile_aborted', the Linear state at the moment the
   * orchestrator decided the in-flight run should be aborted.
   */
  linearStateAfterRun?: string;
  /** Raw stderr chunk from the agent subprocess, when type is 'agent_stderr'. */
  stderrChunk?: string;
  /**
   * When type === 'startup_recovery', list of issue identifiers whose
   * per-issue worktrees were found on disk at boot time. They will be
   * picked up by the next poll tick if Linear still has them in active
   * states; otherwise they remain on disk for operator inspection.
   */
  recoveredIssueIdentifiers?: string[];
}

export interface OrchestratorDeps {
  linear: LinearGateway;
  /**
   * Linear write surface for the in-process symphony_linear MCP server
   * exposed to the agent. When omitted, no symphony_linear server is
   * attached and the agent only sees whatever MCP servers the user
   * configured in WORKFLOW.md.
   */
  linearWrites?: LinearWriteGateway;
  workspace: WorkspaceManager;
  agent: AgentRunner;
  promptTemplate: string;
  config: ResolvedWorkflowConfig;
  /** Optional event sink; tests subscribe to assert behaviour. */
  onEvent?: (event: OrchestratorEvent) => void;
  /** Override for `Date.now()`; tests inject a controllable clock. */
  now?: () => number;
  /**
   * Called after every state mutation so the CLI can persist the snapshot
   * to disk (Phase 3 P5). Errors thrown here are swallowed by the state
   * layer; persistence-side logging is the caller's responsibility.
   */
  onStateChanged?: (snapshot: import('./state.js').SerializedOrchestratorState) => void;
}

import { OrchestratorState } from './state.js';

/**
 * Sort candidate issues per SPEC.md §8.2: priority ascending (lower number =
 * higher priority; null priorities sort last), then created_at ascending so
 * older issues lead, with identifier as a deterministic tiebreaker.
 */
export function sortCandidates(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    if (a.createdAt !== null && b.createdAt !== null) {
      const cmp = a.createdAt.localeCompare(b.createdAt);
      if (cmp !== 0) return cmp;
    } else if (a.createdAt !== null && b.createdAt === null) {
      return -1;
    } else if (a.createdAt === null && b.createdAt !== null) {
      return 1;
    }
    return a.identifier.localeCompare(b.identifier);
  });
}

/**
 * Per SPEC.md §8.2: a `Todo` issue is NOT eligible for dispatch while any of
 * its blocker references is still in a non-terminal state. Issues already in
 * progress are not gated — they may have been started before a blocker
 * appeared and the agent should be able to keep working.
 */
export function isBlocked(issue: Issue, terminalStates: ReadonlySet<string>): boolean {
  if (issue.state !== 'Todo') return false;
  for (const blocker of issue.blockedBy) {
    if (blocker.state === null) return true; // unknown state — fail safe
    if (!terminalStates.has(blocker.state)) return true;
  }
  return false;
}

/**
 * Exponential backoff schedule for consecutive dispatch failures. Indexed by
 * failureCount-1: the first failure waits 30 s, the second 2 min, the third
 * 8 min, the fourth 30 min. After RETRY_DELAYS_MS.length consecutive
 * failures the issue is marked failed — operator action required.
 */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 8 * 60_000, 30 * 60_000];
const MAX_FAILURE_ATTEMPTS = RETRY_DELAYS_MS.length + 1; // 5

/**
 * Short continuation prompt for resumed sessions. The SDK rehydrates the
 * full prior conversation from the captured session_id, so the prompt only
 * needs to nudge the agent on what changed since: which attempt this is and
 * what to do next.
 */
function buildContinuationPrompt(issue: Issue, attemptNumber: number): string {
  return [
    `Continuing work on ${issue.identifier}. This is dispatch attempt #${attemptNumber}.`,
    `Linear state was checked just now and is still in an active state, so the orchestrator is asking you to keep going.`,
    ``,
    `If the work is actually done from your side, transition the Linear issue to the appropriate non-active state (e.g. "Human Review" or whatever the team uses) so the orchestrator stops re-dispatching.`,
    `If you're blocked, post a single Linear comment describing the blocker and stop — do NOT silently no-op, that wastes a dispatch.`,
    `Otherwise resume what you were doing.`,
  ].join('\n');
}
/**
 * Hard cap on total dispatches per issue. Protects against runaway cost when
 * Linear state never leaves `active_states`. Hitting it marks the issue
 * `failed` with an explanatory error so an operator can intervene.
 */
const MAX_DISPATCHES = 10;

export class Orchestrator {
  readonly state = new OrchestratorState();
  private running = false;
  private nextTickTimer: ReturnType<typeof setTimeout> | null = null;

  /** Live config — replaceable via setConfig (Phase 3 P4 hot reload). */
  private liveConfig: ResolvedWorkflowConfig;
  /** Live prompt template — replaceable via setConfig. */
  private livePromptTemplate: string;

  constructor(private readonly deps: OrchestratorDeps) {
    this.liveConfig = deps.config;
    this.livePromptTemplate = deps.promptTemplate;
    if (deps.onStateChanged) {
      this.state.onChanged = () => {
        deps.onStateChanged!(this.state.serialize());
      };
    }
  }

  /**
   * Phase 3 P4: replace the live config and prompt template without
   * restarting the daemon. New dispatches use the new values; in-flight
   * dispatches are NOT affected (they finish under the prior config).
   * Polling interval is also picked up — applied on the next reschedule.
   */
  setConfig(config: ResolvedWorkflowConfig, promptTemplate: string): void {
    this.liveConfig = config;
    this.livePromptTemplate = promptTemplate;
    this.emit({
      type: 'config_reloaded',
      at: this.deps.now?.() ?? Date.now(),
    });
  }

  /**
   * Phase 3 P3: read-only snapshot for the status surface. Includes the
   * persistable state plus live config summary and `running` flag.
   */
  snapshot(): {
    running: boolean;
    config: { project_slug: string; active_states: string[]; terminal_states: string[]; max_concurrent_agents: number; polling_interval_ms: number };
    state: import('./state.js').SerializedOrchestratorState;
  } {
    return {
      running: this.running,
      config: {
        project_slug: this.liveConfig.tracker.project_slug,
        active_states: [...this.liveConfig.tracker.active_states],
        terminal_states: [...this.liveConfig.tracker.terminal_states],
        max_concurrent_agents: this.liveConfig.agent.max_concurrent_agents,
        polling_interval_ms: this.liveConfig.polling.interval_ms,
      },
      state: this.state.serialize(),
    };
  }

  /**
   * Phase 3 P3: trigger an immediate poll-and-dispatch cycle, regardless
   * of the polling interval. Used by `POST /api/v1/refresh`. Returns once
   * the tick completes; in-flight dispatches kicked off during the tick
   * keep running asynchronously.
   */
  async refreshNow(): Promise<void> {
    await this.tick();
  }

  /**
   * Replace in-memory state with a previously-saved snapshot. Called by the
   * CLI on boot when a state file is present. Hydration does NOT fire
   * onStateChanged; the caller is expected to take it from there.
   */
  hydrate(snapshot: import('./state.js').SerializedOrchestratorState): void {
    this.state.hydrate(snapshot);
  }

  /** Start the poll loop. Resolves once the orchestrator has scheduled its first tick. */
  async start(): Promise<void> {
    if (this.running) return;
    await this.recoverFromDisk();
    this.running = true;
    await this.tick();
    this.scheduleNextTick();
  }

  /**
   * Restart-time recovery scan: enumerate per-issue worktrees that already
   * exist on disk and emit a startup_recovery event listing them. Existing
   * worktrees survive across daemon restarts; the next poll tick will
   * pick up any whose Linear state is still active and continue work
   * (sessionId is lost across restart, so the resumed agent starts from
   * a fresh SDK session — full session-state persistence is Phase 3).
   * Worktrees for issues that have moved terminal stay on disk for
   * operator inspection; auto-cleanup is also Phase 3.
   */
  private async recoverFromDisk(): Promise<void> {
    const root = path.resolve(this.liveConfig.workspace.root);
    let entries: ReadonlyArray<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const recovered = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(name))
      .sort();
    this.emit({
      type: 'startup_recovery',
      at: this.deps.now?.() ?? Date.now(),
      recoveredIssueIdentifiers: recovered,
    });
    await this.cleanupTerminalWorktrees(recovered);
  }

  /**
   * Phase 3 P6: for each recovered worktree, ask Linear what state the
   * issue is in. If terminal, run the before_remove hook (if configured)
   * and rm -rf the worktree. Issues we can't reach Linear for are kept
   * (operator can clean manually); issues whose Linear state is anything
   * other than terminal are kept (the next tick will pick them up).
   */
  private async cleanupTerminalWorktrees(identifiers: string[]): Promise<void> {
    if (identifiers.length === 0) return;
    const terminal = new Set(this.liveConfig.tracker.terminal_states);
    for (const identifier of identifiers) {
      let issue;
      try {
        issue = await this.deps.linear.fetchIssueByIdentifier(identifier);
      } catch {
        continue; // Linear flake — leave the worktree alone
      }
      if (issue === null) continue; // identifier no longer exists in Linear
      if (!terminal.has(issue.state)) continue;
      try {
        await this.deps.workspace.removeWorkspace(issue);
        this.emit({
          type: 'workspace_cleaned',
          at: this.deps.now?.() ?? Date.now(),
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          linearStateAfterRun: issue.state,
        });
      } catch (err) {
        this.emit({
          type: 'workspace_cleaned',
          at: this.deps.now?.() ?? Date.now(),
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          linearStateAfterRun: issue.state,
          error: (err as Error).message,
        });
      }
    }
  }

  /** Stop polling and wait for in-flight dispatches to drain. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.nextTickTimer !== null) {
      clearTimeout(this.nextTickTimer);
      this.nextTickTimer = null;
    }
    await this.state.drain();
  }

  /**
   * Run a single poll-and-dispatch tick. Public so tests can drive the
   * orchestrator deterministically without engaging timers.
   */
  async tick(): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    this.emit({ type: 'tick_started', at: now });

    let candidates: Issue[];
    try {
      candidates = await this.deps.linear.fetchActiveCandidates(
        this.liveConfig.tracker.project_slug,
        this.liveConfig.tracker.active_states,
      );
    } catch (err) {
      this.emit({ type: 'tick_completed', at: now, error: (err as Error).message });
      return;
    }

    const terminalStates: ReadonlySet<string> = new Set(
      this.liveConfig.tracker.terminal_states,
    );
    const sorted = sortCandidates(candidates);
    const dispatchable = sorted.filter((issue) => !isBlocked(issue, terminalStates));

    const cap = this.liveConfig.agent.max_concurrent_agents;
    const stateCaps = this.liveConfig.agent.max_concurrent_agents_by_state;
    // Seed per-state busy counts from issues dispatched in earlier ticks
    // that are still busy. The dispatch loop increments them as new
    // dispatches happen this tick.
    const perStateBusy = new Map<string, number>();
    for (const issue of dispatchable) {
      if (this.state.isBusy(issue.id)) {
        perStateBusy.set(issue.state, (perStateBusy.get(issue.state) ?? 0) + 1);
      }
    }

    for (const issue of dispatchable) {
      if (this.state.busyCount() >= cap) break;
      if (this.state.isBusy(issue.id)) continue;
      // Reactivation: a previously-terminal issue is back in active_states
      // (operator moved Human Review → Rework, etc). The persisted
      // sessionId was already cleared on completion/failure, so this
      // dispatch starts a fresh session — agent re-renders the full
      // prompt, sees the current ticket including new comments, and
      // works from there. failureCount resets so the new run gets a full
      // fresh backoff window.
      const persisted = this.state.stateOf(issue.id);
      if (persisted === 'completed' || persisted === 'failed') {
        this.state.markIdleForContinuation(issue.id);
        this.state.resetFailureCount(issue.id);
        this.emit({
          type: 'reactivation_detected',
          at: now,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          linearStateAfterRun: issue.state,
        });
      }
      if (this.state.isInRetryCooldown(issue.id, now)) {
        this.emit({
          type: 'retry_skipped',
          at: now,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
        });
        continue;
      }
      const stateCap = stateCaps[issue.state];
      if (stateCap !== undefined && (perStateBusy.get(issue.state) ?? 0) >= stateCap) {
        // Per-state cap reached. The issue is eligible globally but the
        // operator has limited concurrent dispatches in this Linear state.
        // Try the next candidate; this one will get picked up on a later
        // tick when an "In Progress" run finishes.
        continue;
      }

      this.state.claim(issue.id);
      this.state.trackInflight(this.dispatchOne(issue));
      perStateBusy.set(issue.state, (perStateBusy.get(issue.state) ?? 0) + 1);
    }

    await this.reconcileRunningDispatches();

    this.emit({ type: 'tick_completed', at: this.deps.now?.() ?? Date.now() });
  }

  /**
   * For each in-flight dispatch, fetch the current Linear state and abort
   * the agent if the issue has moved out of active_states (SPEC.md §8.5).
   * Errors fetching individual issues are tolerated — we'd rather not abort
   * a run on transient Linear flakiness.
   */
  private async reconcileRunningDispatches(): Promise<void> {
    const ids = this.state.busyIssueIds();
    if (ids.length === 0) return;
    const activeStates = new Set(this.liveConfig.tracker.active_states);

    await Promise.all(
      ids.map(async (issueId) => {
        const inflight = this.state.inflightFor(issueId);
        if (inflight === null || inflight.controller.signal.aborted) return;

        let refreshed;
        try {
          refreshed = await this.deps.linear.fetchIssueByIdentifier(inflight.identifier);
        } catch {
          return; // tolerate transient errors
        }

        if (refreshed === null || !activeStates.has(refreshed.state)) {
          const at = this.deps.now?.() ?? Date.now();
          this.emit({
            type: 'reconcile_aborted',
            at,
            issueId,
            issueIdentifier: inflight.identifier,
            linearStateAfterRun: refreshed?.state,
          });
          inflight.controller.abort();
        }
      }),
    );
  }

  private async dispatchOne(issue: Issue): Promise<void> {
    const startedAt = this.deps.now?.() ?? Date.now();
    this.emit({
      type: 'dispatch_started',
      at: startedAt,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
    });

    this.state.markRunning(issue.id);

    // External abort plumbed through to the agent runner so reconcile (and
    // future stop-on-shutdown) can interrupt this dispatch.
    const externalAbort = new AbortController();
    this.state.registerInflight(issue.id, issue.identifier, externalAbort);

    try {
      const ws = await this.deps.workspace.ensureWorkspace(issue);
      await this.runLifecycleHook('before_run', issue, ws.path);
      const resumeSessionId = this.state.sessionIdFor(issue.id) ?? undefined;
      const attemptNumber = this.state.attemptCount(issue.id);
      const prompt = resumeSessionId
        ? buildContinuationPrompt(issue, attemptNumber)
        : renderPrompt(this.livePromptTemplate, {
            issue: buildIssueView(issue),
            attempt: null,
          });
      const dispatchMcpServers: Record<string, unknown> = {};
      if (this.deps.linearWrites) {
        dispatchMcpServers.symphony_linear = createSymphonyLinearMcpServer({
          currentIssue: issue,
          writes: this.deps.linearWrites,
          projectSlug: this.liveConfig.tracker.project_slug,
          disabledTools: this.liveConfig.claude.symphony_linear_disabled_tools,
        });
      }
      const result = await this.deps.agent.run({
        workspacePath: ws.path,
        prompt,
        config: this.liveConfig.claude,
        resumeSessionId,
        dispatchMcpServers,
        externalAbort: externalAbort.signal,
        onStderr: (chunk) => {
          this.emit({
            type: 'agent_stderr',
            at: this.deps.now?.() ?? Date.now(),
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            stderrChunk: chunk,
          });
        },
      });

      if (result.sessionId !== null) {
        this.state.setSessionId(issue.id, result.sessionId);
      }

      if (result.exitReason === 'completed' || result.exitReason === 'incomplete_turns') {
        // 'incomplete_turns' (SDK error_max_turns) goes through the success
        // path: Linear refresh decides terminal-vs-continuation. Cheaper
        // than treating it as failure with 30s cooldown — see SPEC-claude.md
        // Phase 3 P1.
        await this.handleSuccess(issue, result);
      } else if (result.exitReason === 'aborted_externally') {
        // Reconcile has already aborted because Linear moved to a terminal
        // state. Treat as completed — the work is no longer the agent's
        // responsibility. handleSuccess would otherwise re-fetch Linear,
        // which is wasteful when reconcile just did exactly that.
        this.state.markCompleted(issue.id);
        this.emit({
          type: 'dispatch_completed',
          at: this.deps.now?.() ?? Date.now(),
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          result,
        });
      } else {
        this.handleFailure(issue, result.errorMessage ?? `agent ${result.exitReason}`);
      }
    } catch (err) {
      this.handleFailure(issue, (err as Error).message);
    } finally {
      this.state.clearInflight(issue.id);
      // after_run runs whether the dispatch succeeded, failed, or threw.
      // Failures inside the hook itself are logged as agent_stderr-shaped
      // events and do NOT fail the dispatch retroactively (it's already
      // been resolved one way or another above).
      const wsPathForAfter = this.deps.workspace.pathFor(issue.identifier);
      await this.runLifecycleHook('after_run', issue, wsPathForAfter, true);
    }
  }

  /**
   * Run a hooks.{name} script in the per-issue workspace cwd. Failures in
   * before_run propagate (so the dispatch fails fast); failures in after_run
   * are logged as warnings only (the dispatch's outcome has already been
   * recorded). When `tolerateFailure` is true, the error is swallowed.
   */
  private async runLifecycleHook(
    name: 'before_run' | 'after_run',
    issue: Issue,
    workspacePath: string,
    tolerateFailure = false,
  ): Promise<void> {
    const script = this.liveConfig.hooks[name];
    if (!script) return;
    try {
      await runHook(
        script,
        workspacePath,
        {
          ISSUE_ID: issue.id,
          ISSUE_IDENTIFIER: issue.identifier,
          ISSUE_TITLE: issue.title,
          ISSUE_URL: issue.url ?? '',
          WORKSPACE_PATH: workspacePath,
        },
        { timeoutMs: this.liveConfig.hooks.timeout_ms },
      );
    } catch (err) {
      if (err instanceof HookExecutionError) {
        this.emit({
          type: 'agent_stderr',
          at: this.deps.now?.() ?? Date.now(),
          issueId: issue.id,
          issueIdentifier: issue.identifier,
          stderrChunk: `[${name}] ${err.message}\n${err.stderr}`,
        });
      }
      if (!tolerateFailure) throw err;
    }
  }

  private handleFailure(issue: Issue, reason: string): void {
    const now = this.deps.now?.() ?? Date.now();
    this.emit({
      type: 'dispatch_failed',
      at: now,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      error: reason,
    });

    const failureCount = this.state.incrementFailureCount(issue.id);
    if (failureCount >= MAX_FAILURE_ATTEMPTS) {
      this.state.markFailed(issue.id);
      return;
    }

    // Backoff index is failureCount-1 capped at the schedule's last entry.
    // (failureCount is 1-based after the increment above.)
    const delayIdx = Math.min(failureCount - 1, RETRY_DELAYS_MS.length - 1);
    const delay = RETRY_DELAYS_MS[delayIdx]!;
    const retryAt = now + delay;
    this.state.scheduleRetry(issue.id, retryAt);
    this.emit({
      type: 'retry_scheduled',
      at: now,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      retryAt,
    });
  }

  /**
   * Handle a successful SDK exit. Symphony parity (SPEC.md §7.2): a
   * successful agent run does NOT mean the issue is done — the orchestrator
   * re-checks Linear and only marks completed if the issue has left the
   * configured active_states. Otherwise it requeues for continuation
   * (no cooldown, attempt counter retained for the runaway cap).
   */
  private async handleSuccess(issue: Issue, result: AgentRunResult): Promise<void> {
    const now = this.deps.now?.() ?? Date.now();
    // A successful agent run breaks any consecutive-failure streak; the
    // backoff window resets so a later failure starts at the 30 s tier
    // again rather than at 30 minutes.
    this.state.resetFailureCount(issue.id);
    let refreshed: Issue | null = null;
    try {
      refreshed = await this.deps.linear.fetchIssueByIdentifier(issue.identifier);
    } catch (err) {
      // If we can't refresh the tracker, fall back to "completed" rather
      // than re-dispatching blindly. Operator can manually re-open the
      // ticket if the agent's work was actually incomplete.
      this.state.markCompleted(issue.id);
      this.emit({
        type: 'dispatch_completed',
        at: now,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        result,
        error: `linear refresh failed after success: ${(err as Error).message}`,
      });
      return;
    }

    const stillActive =
      refreshed !== null &&
      this.liveConfig.tracker.active_states.includes(refreshed.state);

    if (!stillActive) {
      this.state.markCompleted(issue.id);
      this.emit({
        type: 'dispatch_completed',
        at: now,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        result,
      });
      return;
    }

    if (this.state.attemptCount(issue.id) >= MAX_DISPATCHES) {
      this.state.markFailed(issue.id);
      this.emit({
        type: 'dispatch_failed',
        at: now,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        error: `issue still in active state "${refreshed!.state}" after ${MAX_DISPATCHES} dispatches; manual intervention required`,
      });
      return;
    }

    this.state.markIdleForContinuation(issue.id);
    this.emit({
      type: 'continuation_scheduled',
      at: now,
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      result,
      linearStateAfterRun: refreshed!.state,
    });
  }

  private scheduleNextTick(): void {
    if (!this.running) return;
    this.nextTickTimer = setTimeout(async () => {
      this.nextTickTimer = null;
      try {
        await this.tick();
      } finally {
        this.scheduleNextTick();
      }
    }, this.liveConfig.polling.interval_ms);
    // Intentionally NOT unref()'d — the timer is what keeps the Node process
    // alive between ticks. stop() clears the timer explicitly, so the process
    // exits cleanly through SIGINT/SIGTERM in bin/claude-symphony.ts.
  }

  private emit(event: OrchestratorEvent): void {
    this.deps.onEvent?.(event);
  }
}

export { AgentRunner }; // re-export so callers don't need a separate import
