// SPEC.md §7.1 + §7.2 — Orchestrator state.
// PARITY.md rows: §3.1.4, §7.1, §7.2 (MVP subset).
//
// In-memory only. Restart recovery (SPEC.md §7.4 / §14.3) is Phase 2.
// Holds per-issue runtime status plus a retry queue (single retry, fixed
// delay) and the set of in-flight dispatch promises so stop() can drain
// gracefully.

export type IssueRunState =
  | 'idle'
  | 'claimed'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retry_pending';

export interface RetryEntry {
  /** Unix milliseconds at which this issue becomes eligible to dispatch again. */
  notBefore: number;
}

/**
 * Serializable snapshot of orchestrator state — what we persist to disk
 * (Phase 3 P5). Excludes ephemeral fields (in-flight promises, abort
 * controllers); those reconstruct themselves naturally on the next tick
 * after hydration.
 */
export interface SerializedOrchestratorState {
  version: 1;
  savedAt: number;
  issues: Record<
    string,
    {
      state: IssueRunState;
      attemptCount: number;
      failureCount: number;
      sessionId?: string;
      retry?: RetryEntry;
    }
  >;
}

export class OrchestratorState {
  private readonly states = new Map<string, IssueRunState>();
  private readonly retries = new Map<string, RetryEntry>();
  private readonly attempts = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private readonly sessionIds = new Map<string, string>();
  private readonly inflight = new Set<Promise<void>>();

  /**
   * Hook fired after every state-mutating method completes. Used by the
   * orchestrator to persist changes to disk (Phase 3 P5). No-op by default.
   */
  onChanged: () => void = () => undefined;

  private touch(): void {
    try {
      this.onChanged();
    } catch {
      // Persistence failures must not break orchestrator state; the
      // caller is expected to log inside onChanged if it cares.
    }
  }

  stateOf(issueId: string): IssueRunState {
    return this.states.get(issueId) ?? 'idle';
  }

  /** True if the issue is currently being processed and should not be dispatched again. */
  isBusy(issueId: string): boolean {
    const s = this.states.get(issueId);
    return s === 'claimed' || s === 'running';
  }

  /** True if the issue is in retry cooldown and not yet eligible. */
  isInRetryCooldown(issueId: string, now: number): boolean {
    const entry = this.retries.get(issueId);
    return entry !== undefined && entry.notBefore > now;
  }

  attemptCount(issueId: string): number {
    return this.attempts.get(issueId) ?? 0;
  }

  /**
   * Consecutive failure count, reset on any success (completion OR
   * continuation). Drives exponential retry backoff so a failure interleaved
   * with successful continuations doesn't get a 30-minute delay.
   */
  failureCount(issueId: string): number {
    return this.failures.get(issueId) ?? 0;
  }

  incrementFailureCount(issueId: string): number {
    const next = (this.failures.get(issueId) ?? 0) + 1;
    this.failures.set(issueId, next);
    this.touch();
    return next;
  }

  resetFailureCount(issueId: string): void {
    this.failures.delete(issueId);
    this.touch();
  }

  /**
   * Most recent SDK session id captured for this issue, or null. Used by the
   * orchestrator on continuation dispatches to ask the SDK to `resume` rather
   * than start a fresh conversation.
   */
  sessionIdFor(issueId: string): string | null {
    return this.sessionIds.get(issueId) ?? null;
  }

  setSessionId(issueId: string, sessionId: string): void {
    this.sessionIds.set(issueId, sessionId);
    this.touch();
  }

  clearSessionId(issueId: string): void {
    this.sessionIds.delete(issueId);
    this.touch();
  }

  /**
   * AbortControllers (with the issue identifier we need to refresh against
   * Linear) for in-flight dispatches. Reconciliation aborts these when
   * Linear state moves out of active during a run (SPEC.md §8.5).
   */
  private readonly inflightDispatches = new Map<
    string,
    { controller: AbortController; identifier: string }
  >();

  registerInflight(
    issueId: string,
    identifier: string,
    controller: AbortController,
  ): void {
    this.inflightDispatches.set(issueId, { controller, identifier });
  }

  inflightFor(
    issueId: string,
  ): { controller: AbortController; identifier: string } | null {
    return this.inflightDispatches.get(issueId) ?? null;
  }

  clearInflight(issueId: string): void {
    this.inflightDispatches.delete(issueId);
  }

  /** Snapshot of issue ids currently busy (claimed or running). */
  busyIssueIds(): string[] {
    const ids: string[] = [];
    for (const [id, s] of this.states.entries()) {
      if (s === 'claimed' || s === 'running') ids.push(id);
    }
    return ids;
  }

  claim(issueId: string): void {
    this.states.set(issueId, 'claimed');
    this.retries.delete(issueId);
    this.touch();
  }

  markRunning(issueId: string): void {
    this.states.set(issueId, 'running');
    this.attempts.set(issueId, (this.attempts.get(issueId) ?? 0) + 1);
    this.touch();
  }

  markCompleted(issueId: string): void {
    this.states.set(issueId, 'completed');
    this.retries.delete(issueId);
    this.sessionIds.delete(issueId);
    this.failures.delete(issueId);
    this.touch();
  }

  markFailed(issueId: string): void {
    this.states.set(issueId, 'failed');
    this.retries.delete(issueId);
    this.sessionIds.delete(issueId);
    this.failures.delete(issueId);
    this.touch();
  }

  scheduleRetry(issueId: string, notBefore: number): void {
    this.states.set(issueId, 'retry_pending');
    this.retries.set(issueId, { notBefore });
    this.touch();
  }

  /**
   * After a successful agent run that left the issue in an active Linear
   * state, transition back to idle so the next poll tick can re-dispatch
   * with no cooldown. Does NOT reset the attempt counter — that counter
   * is what bounds total dispatches per issue (Symphony continuation cap).
   */
  markIdleForContinuation(issueId: string): void {
    this.states.set(issueId, 'idle');
    this.retries.delete(issueId);
    this.touch();
  }

  /** Total number of issues currently `claimed` or `running`. */
  busyCount(): number {
    let count = 0;
    for (const s of this.states.values()) {
      if (s === 'claimed' || s === 'running') count += 1;
    }
    return count;
  }

  trackInflight<T>(promise: Promise<T>): Promise<T> {
    const wrapped = promise.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(wrapped);
    void wrapped.finally(() => {
      this.inflight.delete(wrapped);
    });
    return promise;
  }

  /** Resolves once every currently-tracked dispatch has completed. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) {
      const snapshot = Array.from(this.inflight);
      await Promise.allSettled(snapshot);
    }
  }

  /**
   * Snapshot of the persistable state (Phase 3 P5). Excludes ephemeral
   * fields (in-flight promises, abort controllers, the "running" / "claimed"
   * busy markers — those reset to idle on the next boot).
   */
  serialize(): SerializedOrchestratorState {
    const issues: SerializedOrchestratorState['issues'] = {};
    const ids = new Set<string>([
      ...this.states.keys(),
      ...this.attempts.keys(),
      ...this.failures.keys(),
      ...this.sessionIds.keys(),
      ...this.retries.keys(),
    ]);
    for (const id of ids) {
      const entry: SerializedOrchestratorState['issues'][string] = {
        state: this.states.get(id) ?? 'idle',
        attemptCount: this.attempts.get(id) ?? 0,
        failureCount: this.failures.get(id) ?? 0,
      };
      const sid = this.sessionIds.get(id);
      if (sid !== undefined) entry.sessionId = sid;
      const retry = this.retries.get(id);
      if (retry !== undefined) entry.retry = retry;
      issues[id] = entry;
    }
    return { version: 1, savedAt: Date.now(), issues };
  }

  /**
   * Replace state with a previously-serialized snapshot. `claimed` and
   * `running` states from a prior process are stale (the dispatch is dead);
   * those reset to `idle` so the next tick can re-dispatch with the
   * preserved sessionId / failureCount intact.
   */
  hydrate(snapshot: SerializedOrchestratorState): void {
    this.states.clear();
    this.attempts.clear();
    this.failures.clear();
    this.sessionIds.clear();
    this.retries.clear();
    for (const [id, entry] of Object.entries(snapshot.issues)) {
      const safeState: IssueRunState =
        entry.state === 'claimed' || entry.state === 'running' ? 'idle' : entry.state;
      this.states.set(id, safeState);
      if (entry.attemptCount > 0) this.attempts.set(id, entry.attemptCount);
      if (entry.failureCount > 0) this.failures.set(id, entry.failureCount);
      if (entry.sessionId !== undefined) this.sessionIds.set(id, entry.sessionId);
      if (entry.retry !== undefined) this.retries.set(id, entry.retry);
    }
    // Hydration itself doesn't fire onChanged — caller decides whether to
    // re-save (typically yes, to migrate the file's savedAt).
  }
}
