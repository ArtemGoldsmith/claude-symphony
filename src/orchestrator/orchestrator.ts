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

import type { ResolvedWorkflowConfig } from '../config/resolve.js';
import type { LinearGateway } from '../linear/gateway.js';
import type { Issue } from '../linear/issue.js';
import type { WorkspaceManager } from '../workspace/manager.js';
import { AgentRunner, type AgentRunResult } from '../agent/runner.js';
import { buildIssueView, renderPrompt } from '../agent/prompt.js';

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
}

export interface OrchestratorDeps {
  linear: LinearGateway;
  workspace: WorkspaceManager;
  agent: AgentRunner;
  promptTemplate: string;
  config: ResolvedWorkflowConfig;
  /** Optional event sink; tests subscribe to assert behaviour. */
  onEvent?: (event: OrchestratorEvent) => void;
  /** Override for `Date.now()`; tests inject a controllable clock. */
  now?: () => number;
}

import { OrchestratorState } from './state.js';

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

  constructor(private readonly deps: OrchestratorDeps) {}

  /** Start the poll loop. Resolves once the orchestrator has scheduled its first tick. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick();
    this.scheduleNextTick();
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
        this.deps.config.tracker.project_slug,
        this.deps.config.tracker.active_states,
      );
    } catch (err) {
      this.emit({ type: 'tick_completed', at: now, error: (err as Error).message });
      return;
    }

    const cap = this.deps.config.agent.max_concurrent_agents;
    for (const issue of candidates) {
      if (this.state.busyCount() >= cap) break;
      if (this.state.isBusy(issue.id)) continue;
      if (this.state.stateOf(issue.id) === 'completed') continue;
      if (this.state.stateOf(issue.id) === 'failed') continue;
      if (this.state.isInRetryCooldown(issue.id, now)) {
        this.emit({
          type: 'retry_skipped',
          at: now,
          issueId: issue.id,
          issueIdentifier: issue.identifier,
        });
        continue;
      }

      this.state.claim(issue.id);
      this.state.trackInflight(this.dispatchOne(issue));
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
    const activeStates = new Set(this.deps.config.tracker.active_states);

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
      const resumeSessionId = this.state.sessionIdFor(issue.id) ?? undefined;
      const attemptNumber = this.state.attemptCount(issue.id);
      const prompt = resumeSessionId
        ? buildContinuationPrompt(issue, attemptNumber)
        : renderPrompt(this.deps.promptTemplate, {
            issue: buildIssueView(issue),
            attempt: null,
          });
      const result = await this.deps.agent.run({
        workspacePath: ws.path,
        prompt,
        config: this.deps.config.claude,
        resumeSessionId,
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

      if (result.exitReason === 'completed') {
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
      this.deps.config.tracker.active_states.includes(refreshed.state);

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
    }, this.deps.config.polling.interval_ms);
    // Intentionally NOT unref()'d — the timer is what keeps the Node process
    // alive between ticks. stop() clears the timer explicitly, so the process
    // exits cleanly through SIGINT/SIGTERM in bin/claude-symphony.ts.
  }

  private emit(event: OrchestratorEvent): void {
    this.deps.onEvent?.(event);
  }
}

export { AgentRunner }; // re-export so callers don't need a separate import
