// src/control-plane/routing.ts
// Spec §4: pure routing of an agent run's exit to the next phase. The Engine
// applies the result via TaskStore.advance (which re-validates the transition).
// `failedFrom` is recorded so /retry (Plan 3) returns to the right phase.

import type { Phase } from './phase.js';

export interface RouteResult {
  to: Phase;
  /** Alternative legal target the Engine may pick (reviewing → gaps vs no-gaps). */
  alt?: Phase;
  /** When `to` is a failure phase, the phase to record as failedFrom. */
  failedFrom?: Phase;
}

/**
 * Route a completed agent run. `ok` = clean exit (exit 0 or completion-evidence).
 * On failure every ⊕ agent phase collapses to its mapped failure phase, tagging
 * failedFrom so retry resumes the right step. `reviewing` clean exit returns both
 * legal targets (`closing` default, `gapfixing` alt) — the Engine chooses by
 * inspecting review-fresh.md for MISSING/PARTIAL gaps.
 */
export function nextOnAgentExit(from: Phase, ok: boolean): RouteResult {
  if (!ok) {
    switch (from) {
      case 'prepping':
        return { to: 'prep_failed', failedFrom: 'prepping' };
      case 'executing':
      case 'reviewing':
      case 'gapfixing':
      case 'closing':
        return { to: 'execute_failed', failedFrom: from };
      default:
        return { to: 'execute_failed', failedFrom: from };
    }
  }
  switch (from) {
    case 'prepping':
      return { to: 'awaiting_approval' };
    case 'executing':
      return { to: 'reviewing' };
    case 'reviewing':
      return { to: 'closing', alt: 'gapfixing' };
    case 'gapfixing':
      return { to: 'closing' };
    case 'closing':
      return { to: 'previewing' };
    default:
      return { to: 'execute_failed', failedFrom: from };
  }
}
