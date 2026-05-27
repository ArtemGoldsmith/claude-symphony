// tests/control-plane/drift.test.ts
import { describe, expect, it } from 'vitest';

import { isSlotPhase, isActiveRunPhase } from '../../src/control-plane/phase.js';

describe('lifecycle drift guards', () => {
  it('failure phases never hold a concurrency slot (so a failed run frees its slot)', () => {
    for (const p of ['prep_failed', 'execute_failed', 'preview_failed', 'teardown_failed'] as const) {
      expect(isSlotPhase(p)).toBe(false);
    }
  });

  it('tearing_down is an active-run phase but holds no slot (teardown must not block dispatch)', () => {
    expect(isActiveRunPhase('tearing_down')).toBe(true);
    expect(isSlotPhase('tearing_down')).toBe(false);
  });
});
