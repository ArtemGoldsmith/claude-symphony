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

export class OrchestratorState {
  private readonly states = new Map<string, IssueRunState>();
  private readonly retries = new Map<string, RetryEntry>();
  private readonly attempts = new Map<string, number>();
  private readonly inflight = new Set<Promise<void>>();

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

  claim(issueId: string): void {
    this.states.set(issueId, 'claimed');
    this.retries.delete(issueId);
  }

  markRunning(issueId: string): void {
    this.states.set(issueId, 'running');
    this.attempts.set(issueId, (this.attempts.get(issueId) ?? 0) + 1);
  }

  markCompleted(issueId: string): void {
    this.states.set(issueId, 'completed');
    this.retries.delete(issueId);
  }

  markFailed(issueId: string): void {
    this.states.set(issueId, 'failed');
    this.retries.delete(issueId);
  }

  scheduleRetry(issueId: string, notBefore: number): void {
    this.states.set(issueId, 'retry_pending');
    this.retries.set(issueId, { notBefore });
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
}
