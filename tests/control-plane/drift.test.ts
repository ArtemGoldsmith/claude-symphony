// tests/control-plane/drift.test.ts
import { describe, expect, it } from 'vitest';

import { isSlotPhase, isActiveRunPhase, assertTransition, type Phase } from '../../src/control-plane/phase.js';

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

  it('failure phases never hold a slot (incl. preview/teardown failures)', () => {
    for (const p of ['prep_failed', 'execute_failed', 'preview_failed', 'teardown_failed'] as Phase[]) {
      expect(isSlotPhase(p)).toBe(false);
    }
  });

  it('previewing holds a slot; tearing_down does not (§10)', () => {
    expect(isSlotPhase('previewing')).toBe(true);
    expect(isSlotPhase('tearing_down')).toBe(false);
  });

  it('preview/teardown re-entry transitions are legal (retry targets)', () => {
    expect(() => assertTransition('preview_failed', 'previewing')).not.toThrow();
    expect(() => assertTransition('teardown_failed', 'tearing_down')).not.toThrow();
    expect(() => assertTransition('closing', 'execute_failed')).not.toThrow(); // canPreview guard target
  });
});
