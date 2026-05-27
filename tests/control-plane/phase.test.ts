// tests/control-plane/phase.test.ts
import { describe, expect, it } from 'vitest';

import {
  type Phase,
  isSlotPhase,
  isActiveRunPhase,
  assertTransition,
  TransitionError,
} from '../../src/control-plane/phase.js';

describe('phase model', () => {
  it('classifies slot-holding phases (⊕set, spec §10)', () => {
    const slot: Phase[] = ['prepping', 'executing', 'reviewing', 'gapfixing', 'closing', 'previewing'];
    for (const p of slot) expect(isSlotPhase(p)).toBe(true);
    for (const p of ['queued', 'awaiting_approval', 'approved', 'ready', 'tearing_down', 'done'] as Phase[]) {
      expect(isSlotPhase(p)).toBe(false);
    }
  });

  it('activeRunSet = ⊕set ∪ {tearing_down} (spec §10)', () => {
    expect(isActiveRunPhase('tearing_down')).toBe(true);
    expect(isActiveRunPhase('executing')).toBe(true);
    expect(isActiveRunPhase('ready')).toBe(false);
    expect(isActiveRunPhase('queued')).toBe(false);
  });

  it('allows the happy-path chain and the documented loops', () => {
    expect(() => assertTransition('queued', 'prepping')).not.toThrow();
    expect(() => assertTransition('prepping', 'awaiting_approval')).not.toThrow();
    expect(() => assertTransition('awaiting_approval', 'approved')).not.toThrow();
    expect(() => assertTransition('awaiting_approval', 'prepping')).not.toThrow(); // reject loop
    expect(() => assertTransition('reviewing', 'gapfixing')).not.toThrow();
    expect(() => assertTransition('reviewing', 'closing')).not.toThrow(); // no-gaps skip
    expect(() => assertTransition('ready', 'tearing_down')).not.toThrow();
    expect(() => assertTransition('tearing_down', 'done')).not.toThrow();
    expect(() => assertTransition('tearing_down', 'abandoned')).not.toThrow();
    expect(() => assertTransition('tearing_down', 'prepping')).not.toThrow(); // request-changes
  });

  it('rejects illegal transitions with TransitionError', () => {
    expect(() => assertTransition('queued', 'executing')).toThrow(TransitionError);
    expect(() => assertTransition('done', 'prepping')).toThrow(TransitionError);
    expect(() => assertTransition('ready', 'executing')).toThrow(TransitionError);
  });

  it('allows every ⊕/active phase to fail to its mapped failure phase', () => {
    expect(() => assertTransition('prepping', 'prep_failed')).not.toThrow();
    expect(() => assertTransition('executing', 'execute_failed')).not.toThrow();
    expect(() => assertTransition('reviewing', 'execute_failed')).not.toThrow();
    expect(() => assertTransition('gapfixing', 'execute_failed')).not.toThrow();
    expect(() => assertTransition('closing', 'execute_failed')).not.toThrow();
    expect(() => assertTransition('previewing', 'preview_failed')).not.toThrow();
    expect(() => assertTransition('tearing_down', 'teardown_failed')).not.toThrow();
  });

  it('allows operator retry to each execute-chain phase + each failure phase', () => {
    expect(() => assertTransition('prep_failed', 'prepping')).not.toThrow();
    expect(() => assertTransition('execute_failed', 'executing')).not.toThrow();
    expect(() => assertTransition('execute_failed', 'reviewing')).not.toThrow(); // crashed reviewer retry
    expect(() => assertTransition('execute_failed', 'gapfixing')).not.toThrow();
    expect(() => assertTransition('execute_failed', 'closing')).not.toThrow();
    expect(() => assertTransition('preview_failed', 'previewing')).not.toThrow();
    expect(() => assertTransition('teardown_failed', 'tearing_down')).not.toThrow();
    // teardown from a failure with no preview goes straight to abandoned (spec §8)
    expect(() => assertTransition('execute_failed', 'abandoned')).not.toThrow();
  });
});
