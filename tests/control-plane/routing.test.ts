import { describe, expect, it } from 'vitest';

import { nextOnAgentExit } from '../../src/control-plane/routing.js';
import { canTransition } from '../../src/control-plane/phase.js';

describe('nextOnAgentExit', () => {
  it('routes the clean agent chain', () => {
    expect(nextOnAgentExit('prepping', true)).toEqual({ to: 'awaiting_approval' });
    expect(nextOnAgentExit('executing', true)).toEqual({ to: 'reviewing' });
    expect(nextOnAgentExit('gapfixing', true)).toEqual({ to: 'closing' });
    expect(nextOnAgentExit('closing', true)).toEqual({ to: 'previewing' });
  });

  it('reviewing clean exit exposes both targets (Engine decides by gaps)', () => {
    expect(nextOnAgentExit('reviewing', true)).toEqual({ to: 'closing', alt: 'gapfixing' });
  });

  it('maps every ⊕ agent phase failure to its failure phase with failedFrom', () => {
    expect(nextOnAgentExit('prepping', false)).toEqual({ to: 'prep_failed', failedFrom: 'prepping' });
    expect(nextOnAgentExit('executing', false)).toEqual({ to: 'execute_failed', failedFrom: 'executing' });
    expect(nextOnAgentExit('reviewing', false)).toEqual({ to: 'execute_failed', failedFrom: 'reviewing' });
    expect(nextOnAgentExit('gapfixing', false)).toEqual({ to: 'execute_failed', failedFrom: 'gapfixing' });
    expect(nextOnAgentExit('closing', false)).toEqual({ to: 'execute_failed', failedFrom: 'closing' });
  });

  it('every routed target is a legal transition from its source', () => {
    for (const from of ['prepping', 'executing', 'gapfixing', 'closing'] as const) {
      for (const ok of [true, false]) {
        const r = nextOnAgentExit(from, ok);
        expect(canTransition(from, r.to)).toBe(true);
        if (r.alt) expect(canTransition(from, r.alt)).toBe(true);
      }
    }
  });
});
