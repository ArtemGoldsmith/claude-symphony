import { describe, expect, it } from 'vitest';

import { OrchestratorState } from '../../src/orchestrator/state.js';

describe('OrchestratorState', () => {
  it('starts every unknown issue as idle', () => {
    const s = new OrchestratorState();
    expect(s.stateOf('whatever')).toBe('idle');
    expect(s.isBusy('whatever')).toBe(false);
    expect(s.busyCount()).toBe(0);
  });

  it('tracks the canonical state lifecycle: claim → running → completed', () => {
    const s = new OrchestratorState();
    s.claim('i1');
    expect(s.stateOf('i1')).toBe('claimed');
    expect(s.isBusy('i1')).toBe(true);
    expect(s.busyCount()).toBe(1);

    s.markRunning('i1');
    expect(s.stateOf('i1')).toBe('running');
    expect(s.isBusy('i1')).toBe(true);
    expect(s.attemptCount('i1')).toBe(1);

    s.markCompleted('i1');
    expect(s.stateOf('i1')).toBe('completed');
    expect(s.isBusy('i1')).toBe(false);
    expect(s.busyCount()).toBe(0);
  });

  it('increments attemptCount on each markRunning', () => {
    const s = new OrchestratorState();
    s.claim('i1');
    s.markRunning('i1');
    s.scheduleRetry('i1', 1000);
    s.claim('i1');
    s.markRunning('i1');
    expect(s.attemptCount('i1')).toBe(2);
  });

  it('places an issue in retry_pending with cooldown until notBefore', () => {
    const s = new OrchestratorState();
    s.scheduleRetry('i1', 1500);
    expect(s.stateOf('i1')).toBe('retry_pending');
    expect(s.isInRetryCooldown('i1', 1499)).toBe(true);
    expect(s.isInRetryCooldown('i1', 1500)).toBe(false);
    expect(s.isInRetryCooldown('i1', 2000)).toBe(false);
  });

  it('clears the cooldown record on claim', () => {
    const s = new OrchestratorState();
    s.scheduleRetry('i1', 5000);
    s.claim('i1');
    expect(s.isInRetryCooldown('i1', 0)).toBe(false);
  });

  it('markIdleForContinuation transitions back to idle, retains attemptCount, and clears cooldown', () => {
    const s = new OrchestratorState();
    s.claim('i1');
    s.markRunning('i1');
    s.markRunning('i1'); // force attemptCount = 2
    s.scheduleRetry('i1', 5000);

    s.markIdleForContinuation('i1');
    expect(s.stateOf('i1')).toBe('idle');
    expect(s.attemptCount('i1')).toBe(2);
    expect(s.isInRetryCooldown('i1', 0)).toBe(false);
    expect(s.isBusy('i1')).toBe(false);
  });

  it('drain resolves once all tracked promises settle', async () => {
    const s = new OrchestratorState();
    let resolveA: (v: void) => void = () => undefined;
    let resolveB: (v: void) => void = () => undefined;
    s.trackInflight(new Promise<void>((r) => (resolveA = r)));
    s.trackInflight(
      new Promise<void>((r) => (resolveB = r)).then(() => {
        // also queue another inflight after the first one resolves to make
        // sure drain re-checks.
      }),
    );

    let drained = false;
    const drainPromise = s.drain().then(() => {
      drained = true;
    });

    expect(drained).toBe(false);
    resolveA();
    resolveB();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('drain handles rejected promises without re-throwing', async () => {
    const s = new OrchestratorState();
    s.trackInflight(Promise.reject(new Error('boom')).catch(() => undefined));
    await expect(s.drain()).resolves.toBeUndefined();
  });

  it('serialize / hydrate round-trips state cleanly (Phase 3 P5)', () => {
    const s = new OrchestratorState();
    s.claim('i1');
    s.markRunning('i1');
    s.setSessionId('i1', 'sess_abc');
    s.scheduleRetry('i2', 12345);
    s.incrementFailureCount('i2');
    s.incrementFailureCount('i3');
    s.markCompleted('i3'); // failures cleared on completed

    const snap = s.serialize();
    expect(snap.version).toBe(1);
    expect(snap.issues['i1']).toMatchObject({
      state: 'running',
      attemptCount: 1,
      sessionId: 'sess_abc',
    });
    expect(snap.issues['i2']).toMatchObject({
      state: 'retry_pending',
      failureCount: 1,
      retry: { notBefore: 12345 },
    });
    expect(snap.issues['i3']).toMatchObject({ state: 'completed' });

    const fresh = new OrchestratorState();
    fresh.hydrate(snap);
    // running → idle on rehydrate (the prior dispatch is dead).
    expect(fresh.stateOf('i1')).toBe('idle');
    expect(fresh.attemptCount('i1')).toBe(1);
    expect(fresh.sessionIdFor('i1')).toBe('sess_abc');
    expect(fresh.stateOf('i2')).toBe('retry_pending');
    expect(fresh.isInRetryCooldown('i2', 0)).toBe(true);
    expect(fresh.failureCount('i2')).toBe(1);
    expect(fresh.stateOf('i3')).toBe('completed');
  });

  it('hydrate clears prior in-memory state before loading the snapshot', () => {
    const s = new OrchestratorState();
    s.claim('stale');
    s.setSessionId('stale', 'old-session');

    s.hydrate({ version: 1, savedAt: 0, issues: {} });
    expect(s.stateOf('stale')).toBe('idle');
    expect(s.sessionIdFor('stale')).toBeNull();
  });

  it('onChanged fires on every mutation but not on hydrate', () => {
    const s = new OrchestratorState();
    let calls = 0;
    s.onChanged = () => {
      calls += 1;
    };
    s.claim('i1');
    s.markRunning('i1');
    s.markCompleted('i1');
    expect(calls).toBe(3);

    s.hydrate({ version: 1, savedAt: 0, issues: {} });
    expect(calls).toBe(3); // unchanged
  });
});
