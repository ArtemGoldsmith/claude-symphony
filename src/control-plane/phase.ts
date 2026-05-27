// src/control-plane/phase.ts
// Spec §4 lifecycle + §10 phase sets. Pure — no I/O.

// Single source of truth for the 17 phases — task-record.ts derives its zod
// enum from this same const, so the union and the schema can never drift.
export const ALL_PHASES = [
  'queued',
  'prepping',
  'awaiting_approval',
  'approved',
  'executing',
  'reviewing',
  'gapfixing',
  'closing',
  'previewing',
  'ready',
  'tearing_down',
  'done',
  'abandoned',
  'prep_failed',
  'execute_failed',
  'preview_failed',
  'teardown_failed',
] as const;

export type Phase = (typeof ALL_PHASES)[number];

/** Phases that hold a concurrency slot (spec §10 ⊕set). */
export const SLOT_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'prepping',
  'executing',
  'reviewing',
  'gapfixing',
  'closing',
  'previewing',
]);

/** Phases that have a wrapper run the dispatcher/reconcile must own (spec §10). */
export const ACTIVE_RUN_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  ...SLOT_PHASES,
  'tearing_down',
]);

export function isSlotPhase(p: Phase): boolean {
  return SLOT_PHASES.has(p);
}

export function isActiveRunPhase(p: Phase): boolean {
  return ACTIVE_RUN_PHASES.has(p);
}

// Allowed transitions, spec §4. Keyed by source phase.
// NOTE: failure phases list permissive retry targets (e.g. execute_failed →
// {executing,gapfixing,closing}). The /retry handler (Plan 3) MUST route to the
// task's recorded `failedFrom`, not pick arbitrarily — this table only bounds
// what is structurally legal, it does not choose the retry target.
export const TRANSITIONS: Readonly<Record<Phase, ReadonlySet<Phase>>> = {
  queued: new Set(['prepping', 'prep_failed']),
  prepping: new Set(['awaiting_approval', 'prep_failed']),
  awaiting_approval: new Set(['approved', 'queued']),
  approved: new Set(['executing']),
  executing: new Set(['reviewing', 'execute_failed']),
  reviewing: new Set(['gapfixing', 'closing', 'execute_failed']),
  gapfixing: new Set(['closing', 'execute_failed']),
  closing: new Set(['previewing', 'execute_failed']),
  previewing: new Set(['ready', 'preview_failed']),
  ready: new Set(['tearing_down']),
  tearing_down: new Set(['done', 'abandoned', 'queued', 'teardown_failed']),
  done: new Set(),
  abandoned: new Set(),
  prep_failed: new Set(['prepping', 'abandoned']),
  execute_failed: new Set(['executing', 'reviewing', 'gapfixing', 'closing', 'tearing_down', 'abandoned']),
  preview_failed: new Set(['previewing', 'tearing_down', 'abandoned']),
  teardown_failed: new Set(['tearing_down', 'abandoned']),
};

export class TransitionError extends Error {
  constructor(
    public readonly from: Phase,
    public readonly to: Phase,
  ) {
    super(`illegal transition ${from} → ${to}`);
    this.name = 'TransitionError';
  }
}

export function canTransition(from: Phase, to: Phase): boolean {
  return TRANSITIONS[from].has(to);
}

export function assertTransition(from: Phase, to: Phase): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

/** Terminal phases (a re-add archives the prior state dir; spec §9/§12). */
const TERMINAL_PHASES: ReadonlySet<Phase> = new Set<Phase>(['done', 'abandoned']);

export function isTerminalPhase(p: Phase): boolean {
  return TERMINAL_PHASES.has(p);
}
