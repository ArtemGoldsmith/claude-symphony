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
    | 'retry_scheduled'
    | 'retry_skipped';
  at: number;
  issueId?: string;
  issueIdentifier?: string;
  error?: string;
  result?: AgentRunResult;
  retryAt?: number;
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

const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 2;

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

    this.emit({ type: 'tick_completed', at: this.deps.now?.() ?? Date.now() });
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

    try {
      const ws = await this.deps.workspace.ensureWorkspace(issue);
      const prompt = renderPrompt(this.deps.promptTemplate, {
        issue: buildIssueView(issue),
        attempt: null,
      });
      const result = await this.deps.agent.run({
        workspacePath: ws.path,
        prompt,
        config: this.deps.config.claude,
      });

      if (result.exitReason === 'completed') {
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

    if (this.state.attemptCount(issue.id) < MAX_ATTEMPTS) {
      const retryAt = now + RETRY_DELAY_MS;
      this.state.scheduleRetry(issue.id, retryAt);
      this.emit({
        type: 'retry_scheduled',
        at: now,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        retryAt,
      });
    } else {
      this.state.markFailed(issue.id);
    }
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
