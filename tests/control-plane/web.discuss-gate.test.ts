import { describe, it, expect } from 'vitest';
import { isDiscussAllowed } from '../../src/control-plane/web/discuss-ws.js';
import type { TaskRecord, RunRecord } from '../../src/control-plane/task-record.js';
import { ALL_PHASES, type Phase } from '../../src/control-plane/phase.js';

const seedRun: RunRecord = {
  runId: 'r', attemptId: 1, kind: 'prep', pid: null, pidStart: null,
  spawnedAt: 0, sessionId: null, log: '', ownerGen: 'g',
};

const seed = (over: Partial<TaskRecord>): TaskRecord => ({
  ticket: 'PIN-1', rev: 0, phase: 'awaiting_approval', ownerGen: 'g',
  title: '', url: '',
  branch: 'b', worktree: '/tmp/x', baseSha: 'a',
  currentRun: null, openQuestions: null, answers: null,
  rejectFeedback: null, operatorNote: null, preview: null, stage9: null,
  teardownTarget: null, failedFrom: null, terminalReason: null,
  retryRequested: false,
  attempts: { prep: 0, execute: 0 },
  createdAt: 0, updatedAt: 0,
  ...over,
});

describe('isDiscussAllowed (per phase)', () => {
  const allowed: ReadonlySet<Phase> = new Set<Phase>([
    'awaiting_approval', 'ready', 'done', 'abandoned',
    'prep_failed', 'execute_failed', 'preview_failed', 'teardown_failed',
  ]);
  for (const p of ALL_PHASES) {
    it(`phase=${p} → ${allowed.has(p) ? 'allow' : 'deny'}`, () => {
      expect(isDiscussAllowed(seed({ phase: p }))).toBe(allowed.has(p));
    });
  }
});

describe('isDiscussAllowed (edge cases)', () => {
  it('denies when currentRun is non-null even on allowed phase', () => {
    expect(isDiscussAllowed(seed({ phase: 'awaiting_approval', currentRun: seedRun }))).toBe(false);
  });
  it('denies failed phase when retryRequested', () => {
    expect(isDiscussAllowed(seed({ phase: 'prep_failed', retryRequested: true }))).toBe(false);
    expect(isDiscussAllowed(seed({ phase: 'execute_failed', retryRequested: true }))).toBe(false);
    expect(isDiscussAllowed(seed({ phase: 'preview_failed', retryRequested: true }))).toBe(false);
    expect(isDiscussAllowed(seed({ phase: 'teardown_failed', retryRequested: true }))).toBe(false);
  });
  it('allows failed phase when retryRequested is false', () => {
    expect(isDiscussAllowed(seed({ phase: 'prep_failed', retryRequested: false }))).toBe(true);
  });
  it('denies when worktree is null', () => {
    expect(isDiscussAllowed(seed({ phase: 'awaiting_approval', worktree: null }))).toBe(false);
  });
});
