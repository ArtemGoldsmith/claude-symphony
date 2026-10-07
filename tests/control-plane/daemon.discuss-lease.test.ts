import { describe, it, expect, vi } from 'vitest';
import { wrapDispatcherWithLease } from '../../src/control-plane/daemon.js';
import type { DiscussLease } from '../../src/control-plane/discuss-lease.js';
import type { Dispatcher, DispatchArgs } from '../../src/control-plane/engine.js';

function makeFakeLease() {
  const calls: string[] = [];
  const lease: DiscussLease = {
    requireClearForDispatch: vi.fn(async (t: string) => { calls.push(`req:${t}`); }),
    releaseDispatching: vi.fn((t: string) => { calls.push(`rel:${t}`); }),
    isDispatching: vi.fn(() => false),
    activeCount: vi.fn(() => 0),
    shutdown: vi.fn(async () => {}),
  };
  return { lease, calls };
}

function makeArgs(ticket: string): DispatchArgs {
  // Cast through unknown — only `ticket` is read by the wrapper.
  return { ticket } as unknown as DispatchArgs;
}

describe('wrapDispatcherWithLease', () => {
  it('awaits requireClearForDispatch BEFORE inner.dispatch; calls releaseDispatching after', async () => {
    const { lease, calls } = makeFakeLease();
    const inner: Dispatcher = { dispatch: vi.fn(async () => { calls.push('inner'); }) };
    const wrapped = wrapDispatcherWithLease(inner, lease);
    await wrapped.dispatch(makeArgs('ABC-1'));
    expect(calls).toEqual(['req:ABC-1', 'inner', 'rel:ABC-1']);
  });

  it('releases even when inner.dispatch throws', async () => {
    const { lease, calls } = makeFakeLease();
    const inner: Dispatcher = {
      dispatch: vi.fn(async () => { calls.push('inner'); throw new Error('boom'); }),
    };
    const wrapped = wrapDispatcherWithLease(inner, lease);
    await expect(wrapped.dispatch(makeArgs('ABC-1'))).rejects.toThrow('boom');
    expect(calls).toEqual(['req:ABC-1', 'inner', 'rel:ABC-1']);
  });

  it('per-ticket isolation: parallel dispatches do not cross-talk', async () => {
    const { lease, calls } = makeFakeLease();
    const inner: Dispatcher = { dispatch: vi.fn(async () => {}) };
    const wrapped = wrapDispatcherWithLease(inner, lease);
    await Promise.all([
      wrapped.dispatch(makeArgs('ABC-1')),
      wrapped.dispatch(makeArgs('ABC-2')),
    ]);
    // Each ticket must have a matching req+rel pair (order between tickets is not specified;
    // we only assert each ticket's request precedes its release).
    expect(calls.filter((c) => c.endsWith(':ABC-1'))).toEqual(['req:ABC-1', 'rel:ABC-1']);
    expect(calls.filter((c) => c.endsWith(':ABC-2'))).toEqual(['req:ABC-2', 'rel:ABC-2']);
  });
});
