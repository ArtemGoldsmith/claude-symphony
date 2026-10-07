import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { mountRoutes, type RoutesDeps } from '../../../src/control-plane/web/routes.js';
import { TaskStore } from '../../../src/control-plane/task-store.js';
import type { LinearReadGateway } from '../../../src/control-plane/linear-read.js';
import { nullDiscussLease } from '../../../src/control-plane/discuss-lease.js';
import type { Issue } from '../../../src/linear/issue.js';

let root: string;
let store: TaskStore;
let app: Hono;

const fakeIssue: Issue = {
  id: 'iid', identifier: 'ABC-1', title: 'T', description: null, priority: null,
  state: 'Todo', branchName: null, url: 'http://x', labels: [], blockedBy: [],
  createdAt: null, updatedAt: null,
};

const linearRead: LinearReadGateway = {
  async fetchIssueByIdentifier(id) { return id === 'ABC-1' || id === 'ABC-2' ? { ...fakeIssue, identifier: id } : null; },
  async listComments() { return []; },
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-routes-'));
  store = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => 100 });
  app = new Hono();
  const deps: RoutesDeps = { store, linearRead, stateRoot: root, staticRoot: root, discussLease: nullDiscussLease };
  mountRoutes(app, deps);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function form(obj: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(obj).toString() };
}
/** The task's current rev as a string — transition forms embed it (the CAS guard). */
async function rev(ticket: string): Promise<string> { return String((await store.get(ticket))!.rev); }

describe('POST /tasks', () => {
  it('creates a queued task from a valid ticket', async () => {
    const res = await app.request('/tasks', form({ ticket: 'ABC-1' }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    expect((await store.get('ABC-1'))!.phase).toBe('queued');
  });
  it('404s an unknown ticket', async () => {
    const res = await app.request('/tasks', form({ ticket: 'ABC-999' }));
    expect(res.status).toBe(404);
  });
  it('409s a ticket already tracked in a non-terminal phase', async () => {
    await store.create({ ticket: 'ABC-1', title: 'T', url: 'u' });
    const res = await app.request('/tasks', form({ ticket: 'ABC-1' }));
    expect(res.status).toBe(409);
  });
  it('archives + re-adds a terminal ticket', async () => {
    await store.create({ ticket: 'ABC-1', title: 'T', url: 'u' });
    await store.advance('ABC-1', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('ABC-1', { expectRev: 1, to: 'prep_failed', mutate: (r) => { r.failedFrom = 'prepping'; } });
    await store.advance('ABC-1', { expectRev: 2, to: 'abandoned', mutate: (r) => { r.terminalReason = 'abandoned'; } });
    const res = await app.request('/tasks', form({ ticket: 'ABC-1' }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    expect((await store.get('ABC-1'))!.phase).toBe('queued');
  });
  it('a Linear miss does NOT archive the prior terminal task', async () => {
    await store.create({ ticket: 'ABC-3', title: 'T', url: 'u' });
    await store.advance('ABC-3', { expectRev: 0, to: 'prep_failed', mutate: (r) => { r.failedFrom = 'prepping'; } });
    await store.advance('ABC-3', { expectRev: 1, to: 'abandoned', mutate: (r) => { r.terminalReason = 'abandoned'; } });
    const res = await app.request('/tasks', form({ ticket: 'ABC-3' })); // ABC-3 unknown to Linear
    expect(res.status).toBe(404);
    // still present (not archived) — the abandoned task remains gettable
    expect((await store.get('ABC-3'))!.phase).toBe('abandoned');
  });
});

describe('answers + approve guards', () => {
  async function awaitingTask(ticket: string) {
    await store.create({ ticket, title: 'T', url: 'u' });
    await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval', mutate: (r) => {
      r.openQuestions = { rev: 1, items: [{ id: 'q1', text: 'pick', kind: 'bool', required: true }] };
    } });
  }

  it('answers only from awaiting_approval, bound to openQuestions.rev', async () => {
    await awaitingTask('ABC-1');
    const ok = await app.request('/tasks/ABC-1/answers', form({ questionsRev: '1', q_q1: 'yes' }));
    expect(ok.status).toBe(200);
    expect((await store.get('ABC-1'))!.answers!.values.q1).toBe('yes');
    const stale = await app.request('/tasks/ABC-1/answers', form({ questionsRev: '0', q_q1: 'yes' }));
    expect(stale.status).toBe(409);
  });

  it('blocks a vacuous approve (required question unanswered)', async () => {
    await awaitingTask('ABC-1');
    const res = await app.request('/tasks/ABC-1/approve', form({ planAckRev: '1' }));
    expect(res.status).toBe(422);
    expect((await store.get('ABC-1'))!.phase).toBe('awaiting_approval');
  });

  it('approves when planAckRev matches and all required answered', async () => {
    await awaitingTask('ABC-1');
    await app.request('/tasks/ABC-1/answers', form({ questionsRev: '1', q_q1: 'yes' }));
    const res = await app.request('/tasks/ABC-1/approve', form({ planAckRev: '1', rev: await rev('ABC-1') }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    expect((await store.get('ABC-1'))!.phase).toBe('approved');
  });

  it('rejects a stale-rev approve (the page advanced under the operator)', async () => {
    await awaitingTask('ABC-1');
    await app.request('/tasks/ABC-1/answers', form({ questionsRev: '1', q_q1: 'yes' }));
    const stale = String(Number(await rev('ABC-1')) - 1);
    const res = await app.request('/tasks/ABC-1/approve', form({ planAckRev: '1', rev: stale }));
    expect(res.status).toBe(409);
    expect((await store.get('ABC-1'))!.phase).toBe('awaiting_approval');
  });

  it('reject routes to queued and clears answers', async () => {
    await awaitingTask('ABC-1');
    await app.request('/tasks/ABC-1/answers', form({ questionsRev: '1', q_q1: 'yes' }));
    const res = await app.request('/tasks/ABC-1/reject', form({ feedback: 'redo', rev: await rev('ABC-1') }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    const t = (await store.get('ABC-1'))!;
    expect(t.phase).toBe('queued');
    expect(t.answers).toBeNull();
    expect(t.rejectFeedback).toBe('redo');
  });

  it('answers/approve are rejected from a non-awaiting phase', async () => {
    await store.create({ ticket: 'ABC-2', title: 'T', url: 'u' });
    const res = await app.request('/tasks/ABC-2/approve', form({ planAckRev: '0' }));
    expect(res.status).toBe(409);
  });
});

describe('ready gates', () => {
  async function readyTask(ticket: string) {
    await store.create({ ticket, title: 'T', url: 'u' });
    await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; r.baseSha = 's'; } });
    await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval' });
    await store.advance(ticket, { expectRev: 2, to: 'approved' });
    await store.advance(ticket, { expectRev: 3, to: 'executing' });
    await store.advance(ticket, { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance(ticket, { expectRev: 7, to: 'ready', mutate: (r) => {
      r.preview = { url: 'http://p', gitSha: 's', state: 'up' };
      r.stage9 = { attemptId: 1, gitSha: 's', items: [
        { n: 1, tag: 'CUT', text: 'high', acked: false },
        { n: 2, tag: 'DEFERRED', text: 'low', acked: false },
      ] };
    } });
  }

  it('ack marks items acked; approve-preview blocked until all acked', async () => {
    await readyTask('ABC-1');
    const blocked = await app.request('/tasks/ABC-1/approve-preview', form({ rev: await rev('ABC-1') }));
    expect(blocked.status).toBe(422);
    await app.request('/tasks/ABC-1/ack', form({ items: '1' }));
    await app.request('/tasks/ABC-1/ack', form({ items: '2' }));
    const ok = await app.request('/tasks/ABC-1/approve-preview', form({ rev: await rev('ABC-1') }));
    expect(ok.status).toBe(200); expect(ok.headers.get('HX-Refresh')).toBe('true');
    const t = (await store.get('ABC-1'))!;
    expect(t.phase).toBe('tearing_down');
    expect(t.teardownTarget).toBe('done');
  });

  it('request-changes → tearing_down(queued) and clears stage9+answers', async () => {
    await readyTask('ABC-1');
    const res = await app.request('/tasks/ABC-1/request-changes', form({ feedback: 'fix', rev: await rev('ABC-1') }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    const t = (await store.get('ABC-1'))!;
    expect(t.phase).toBe('tearing_down');
    expect(t.teardownTarget).toBe('queued');
    expect(t.stage9).toBeNull();
  });

  it('teardown from ready → tearing_down(abandoned)', async () => {
    await readyTask('ABC-1');
    const res = await app.request('/tasks/ABC-1/teardown', form({ rev: await rev('ABC-1') }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    expect((await store.get('ABC-1'))!.teardownTarget).toBe('abandoned');
  });
});

describe('retry', () => {
  it('sets retryRequested transition-free on a *_failed task', async () => {
    await store.create({ ticket: 'ABC-1', title: 'T', url: 'u' });
    await store.advance('ABC-1', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('ABC-1', { expectRev: 1, to: 'prep_failed', mutate: (r) => { r.failedFrom = 'prepping'; } });
    const res = await app.request('/tasks/ABC-1/retry', form({ rev: await rev('ABC-1') }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    const t = (await store.get('ABC-1'))!;
    expect(t.phase).toBe('prep_failed'); // unchanged
    expect(t.retryRequested).toBe(true);
  });
  it('retry on preview_failed sets retryRequested (303)', async () => {
    await store.create({ ticket: 'ABC-1', title: 'T', url: 'u' });
    await store.advance('ABC-1', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('ABC-1', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('ABC-1', { expectRev: 2, to: 'approved' });
    await store.advance('ABC-1', { expectRev: 3, to: 'executing' });
    await store.advance('ABC-1', { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('ABC-1', { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('ABC-1', { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('ABC-1', { expectRev: 7, to: 'preview_failed', mutate: (r) => { r.failedFrom = 'previewing'; } });
    const res = await app.request('/tasks/ABC-1/retry', form({ rev: await rev('ABC-1') }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    expect((await store.get('ABC-1'))!.retryRequested).toBe(true);
  });

  it('retry on teardown_failed sets retryRequested (303)', async () => {
    await store.create({ ticket: 'ABC-1', title: 'T', url: 'u' });
    await store.advance('ABC-1', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = '/wt'; } });
    await store.advance('ABC-1', { expectRev: 1, to: 'awaiting_approval' });
    await store.advance('ABC-1', { expectRev: 2, to: 'approved' });
    await store.advance('ABC-1', { expectRev: 3, to: 'executing' });
    await store.advance('ABC-1', { expectRev: 4, to: 'reviewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('ABC-1', { expectRev: 5, to: 'closing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('ABC-1', { expectRev: 6, to: 'previewing', mutate: (r) => { r.currentRun = null; } });
    await store.advance('ABC-1', { expectRev: 7, to: 'ready', mutate: (r) => { r.preview = { url: 'u', gitSha: 's', state: 'up' }; } });
    await store.advance('ABC-1', { expectRev: 8, to: 'tearing_down', mutate: (r) => { r.teardownTarget = 'done'; } });
    await store.advance('ABC-1', { expectRev: 9, to: 'teardown_failed', mutate: (r) => { r.failedFrom = 'tearing_down'; } });
    const res = await app.request('/tasks/ABC-1/retry', form({ rev: await rev('ABC-1') }));
    expect(res.status).toBe(200); expect(res.headers.get("HX-Refresh")).toBe("true");
    expect((await store.get('ABC-1'))!.retryRequested).toBe(true);
  });
});
