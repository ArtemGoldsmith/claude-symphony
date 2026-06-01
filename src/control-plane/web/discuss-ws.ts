// src/control-plane/web/discuss-ws.ts
// Spec: 2026-06-01-web-terminal-discuss-design.md §6 (phase gate).
// This is the Task 9 stub — only the phase-gate helper. Task 11 extends this
// module with createDiscussLease() (the WS factory) + pre-upgrade middleware
// + WS lifecycle handlers.

import type { Phase } from '../phase.js';
import type { TaskRecord } from '../task-record.js';

const ALLOWED_BASE: ReadonlySet<Phase> = new Set<Phase>([
  'awaiting_approval', 'ready', 'done', 'abandoned',
  'prep_failed', 'execute_failed', 'preview_failed', 'teardown_failed',
]);

/**
 * Discuss is allowed only when:
 *  - phase is in the ALLOWED_BASE set (gates + terminal + failure phases),
 *  - no active run is in flight (defense-in-depth even if the phase implies idle),
 *  - the task has a worktree on record (the WS handler needs a cwd to spawn into),
 *  - and on a *_failed phase, retry isn't already requested (engine is about to
 *    dispatch — closing the WS now is part of the dispatch interlock).
 */
export function isDiscussAllowed(t: TaskRecord): boolean {
  if (!ALLOWED_BASE.has(t.phase)) return false;
  if (t.currentRun !== null) return false;
  if (t.worktree === null) return false;
  if (t.phase.endsWith('_failed') && t.retryRequested) return false;
  return true;
}
