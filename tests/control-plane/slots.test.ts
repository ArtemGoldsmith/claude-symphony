// tests/control-plane/slots.test.ts
import { describe, expect, it } from 'vitest';

import { SlotCounter } from '../../src/control-plane/slots.js';
import type { Phase } from '../../src/control-plane/phase.js';

describe('SlotCounter (spec §10 synchronous reservation)', () => {
  it('seeds active count from current phases (only ⊕ phases count)', () => {
    const phases: Phase[] = ['executing', 'reviewing', 'ready', 'queued', 'tearing_down'];
    const c = new SlotCounter(3);
    c.seedFrom(phases);
    expect(c.active).toBe(2); // executing + reviewing; ready/queued/tearing_down do not hold slots
  });

  it('tryReserve succeeds while active < cap, then refuses', () => {
    const c = new SlotCounter(2);
    expect(c.tryReserve()).toBe(true); // 1
    expect(c.tryReserve()).toBe(true); // 2
    expect(c.tryReserve()).toBe(false); // cap reached
    expect(c.active).toBe(2);
  });

  it('release decrements and re-opens capacity; never below zero', () => {
    const c = new SlotCounter(1);
    expect(c.tryReserve()).toBe(true);
    c.release();
    expect(c.active).toBe(0);
    c.release(); // idempotent floor
    expect(c.active).toBe(0);
    expect(c.tryReserve()).toBe(true);
  });
});
