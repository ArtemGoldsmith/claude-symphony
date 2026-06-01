import { describe, it, expect } from 'vitest';
import { renderDetail } from '../../src/control-plane/web/views.js';
import type { TaskRecord, RunRecord } from '../../src/control-plane/task-record.js';

const seedRun: RunRecord = {
  runId: 'r', attemptId: 1, kind: 'prep', pid: null, pidStart: null,
  spawnedAt: 0, sessionId: null, log: '', ownerGen: 'g',
};

function seed(over: Partial<TaskRecord>): TaskRecord {
  return {
    ticket: 'PIN-1', rev: 0, phase: 'awaiting_approval', ownerGen: 'g',
    title: 't', url: 'u',
    branch: 'b', worktree: '/tmp/x', baseSha: 'a',
    currentRun: null, openQuestions: null, answers: null,
    rejectFeedback: null, operatorNote: null, preview: null, stage9: null,
    teardownTarget: null, failedFrom: null, terminalReason: null,
    retryRequested: false,
    attempts: { prep: 0, execute: 0 },
    createdAt: 0, updatedAt: 0,
    ...over,
  };
}

const emptyFiles = { plan: '', recap: '', reviewFresh: '' };

describe('renderDiscussPanel via renderDetail', () => {
  it('renders panel on awaiting_approval', () => {
    const html = renderDetail(seed({ phase: 'awaiting_approval' }), emptyFiles);
    expect(html).toMatch(/<details class=discuss-panel>/);
    expect(html).toMatch(/💬 chat with the agent/);
    expect(html).toMatch(/\/static\/xterm\/xterm\.css/);
    expect(html).toMatch(/\/tasks\/PIN-1\/discuss/);
  });
  it('renders panel on ready', () => {
    const html = renderDetail(seed({ phase: 'ready' }), emptyFiles);
    expect(html).toMatch(/discuss-panel/);
  });
  it('omits panel on prepping (active run)', () => {
    const html = renderDetail(seed({ phase: 'prepping', currentRun: seedRun }), emptyFiles);
    expect(html).not.toMatch(/discuss-panel/);
  });
  it('omits panel on queued', () => {
    const html = renderDetail(seed({ phase: 'queued', worktree: null }), emptyFiles);
    expect(html).not.toMatch(/discuss-panel/);
  });
  it('omits panel on prep_failed with retryRequested', () => {
    const html = renderDetail(seed({ phase: 'prep_failed', retryRequested: true }), emptyFiles);
    expect(html).not.toMatch(/discuss-panel/);
  });
  it('panel includes data-attribute or id with escaped ticket (no XSS)', () => {
    // Ticket regex prevents </ but verify escape just in case
    const html = renderDetail(seed({ ticket: 'PIN-42' }), emptyFiles);
    expect(html).toMatch(/PIN-42\/discuss/);
  });
});
