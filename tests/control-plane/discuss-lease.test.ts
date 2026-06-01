import { describe, it, expect } from 'vitest';
import { nullDiscussLease } from '../../src/control-plane/discuss-lease.js';

describe('nullDiscussLease', () => {
  it('requireClearForDispatch resolves to undefined', async () => {
    await expect(nullDiscussLease.requireClearForDispatch('PIN-1')).resolves.toBeUndefined();
  });

  it('isDispatching is always false', () => {
    expect(nullDiscussLease.isDispatching('PIN-1')).toBe(false);
    expect(nullDiscussLease.isDispatching('PIN-999')).toBe(false);
  });

  it('activeCount is 0', () => {
    expect(nullDiscussLease.activeCount()).toBe(0);
  });

  it('releaseDispatching is no-op (no throw)', () => {
    expect(() => nullDiscussLease.releaseDispatching('PIN-1')).not.toThrow();
  });

  it('shutdown resolves to undefined', async () => {
    await expect(nullDiscussLease.shutdown()).resolves.toBeUndefined();
  });

  it('mountRoutes is intentionally undefined on null variant', () => {
    expect(nullDiscussLease.mountRoutes).toBeUndefined();
  });
});
