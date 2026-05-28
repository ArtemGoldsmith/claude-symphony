// src/control-plane/web/routes.ts
// Spec §9 API. Every handler CAS-validates source phase + rev and mutates ONLY via
// TaskStore (web is not exempt, §12). The web layer never spawns a process and
// never advances into a ⊕ phase — re-prep loops route through `queued`, /retry is
// a transition-free flag the Engine acts on (§17).

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { isTerminalPhase } from '../phase.js';
import { StaleRevError, TaskExistsError, UnknownTaskError, type TaskStore } from '../task-store.js';
import { taskDir } from '../task-record.js';
import type { LinearReadGateway } from '../linear-read.js';
import { renderBoard, renderDetail } from './views.js';

export interface RoutesDeps {
  store: TaskStore;
  linearRead: LinearReadGateway;
  stateRoot: string;
}

async function readOpt(p: string): Promise<string> {
  try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
}

/**
 * The rev the page was rendered at, embedded in every transition form. Passing it
 * as the store CAS `expectRev` means a STALE page (the task advanced since render)
 * is rejected with StaleRevError → 409. NaN (missing) → guaranteed CAS miss.
 */
function formRev(body: Record<string, unknown>): number {
  return Number.parseInt(String(body.rev ?? ''), 10);
}

/** Map a store error to an HTTP status without leaking task content. */
function statusFor(err: unknown): ContentfulStatusCode {
  if (err instanceof StaleRevError) return 409;
  if (err instanceof TaskExistsError) return 409;
  if (err instanceof UnknownTaskError) return 409;
  return 400;
}

export function mountRoutes(app: Hono, deps: RoutesDeps): void {
  const { store, linearRead, stateRoot } = deps;

  app.get('/', async (c) => c.html(renderBoard(await store.list())));

  app.get('/tasks/:id', async (c) => {
    const t = await store.get(c.req.param('id'));
    if (!t) return c.text('not found', 404);
    const dir = taskDir(stateRoot, t.ticket);
    return c.html(renderDetail(t, {
      plan: await readOpt(path.join(dir, 'plan.md')),
      recap: await readOpt(path.join(dir, 'recap.md')),
      reviewFresh: await readOpt(path.join(dir, 'review-fresh.md')),
    }));
  });

  app.post('/tasks', async (c) => {
    const body = await c.req.parseBody();
    const ticket = typeof body.ticket === 'string' ? body.ticket.trim().toUpperCase() : '';
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(ticket)) return c.text('bad ticket', 400);
    // Free-text operator note (optional) — trimmed; empty/whitespace → null.
    const noteRaw = typeof body.note === 'string' ? body.note.trim() : '';
    const operatorNote = noteRaw.length > 0 ? noteRaw : null;

    // Fetch FIRST: a Linear miss must 404 WITHOUT having archived a prior terminal task.
    const issue = await linearRead.fetchIssueByIdentifier(ticket);
    if (!issue) return c.text('ticket not found', 404);

    try {
      const existing = await store.get(ticket);
      if (existing) {
        if (!isTerminalPhase(existing.phase)) return c.text('already tracked', 409);
        await store.archive(ticket); // terminal re-add (archive + create in ONE try)
      }
      await store.create({ ticket, title: issue.title, url: issue.url ?? '', operatorNote });
    } catch (err) {
      // Concurrent re-add: a racing request may have already archived (UnknownTaskError)
      // or created (TaskExistsError) the ticket → 409, never a 500.
      return c.text('create failed', statusFor(err));
    }
    return c.redirect('/', 303);
  });

  app.post('/tasks/:id/answers', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    if (t.phase !== 'awaiting_approval' || !t.openQuestions) return c.text('not awaiting approval', 409);
    const body = await c.req.parseBody();
    const questionsRev = Number.parseInt(String(body.questionsRev ?? ''), 10);
    if (questionsRev !== t.openQuestions.rev) return c.text('stale questions rev', 409);
    const values: Record<string, string> = {};
    for (const q of t.openQuestions.items) {
      const v = body[`q_${q.id}`];
      if (typeof v === 'string' && v.length > 0) values[q.id] = v;
    }
    try {
      await store.updateRun(id, t.rev, (r) => {
        r.answers = { questionsRev, planAckRev: r.answers?.planAckRev ?? null, values };
      });
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.text('saved', 200);
  });

  app.post('/tasks/:id/approve', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    if (t.phase !== 'awaiting_approval' || !t.openQuestions) return c.text('not awaiting approval', 409);
    const body = await c.req.parseBody();
    const planAckRev = Number.parseInt(String(body.planAckRev ?? ''), 10);
    const oqRev = t.openQuestions.rev;
    if (planAckRev !== oqRev) return c.text('plan ack rev mismatch', 422);
    const answeredRev = t.answers?.questionsRev === oqRev ? t.answers : null;
    const allRequired = t.openQuestions.items.filter((q) => q.required)
      .every((q) => answeredRev !== null && typeof answeredRev.values[q.id] === 'string');
    if (!allRequired) return c.text('answer all required questions first', 422);
    try {
      await store.advance(id, { expectRev: formRev(body), to: 'approved',
        mutate: (r) => { if (r.answers) r.answers.planAckRev = oqRev; } });
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.redirect(`/tasks/${id}`, 303);
  });

  app.post('/tasks/:id/reject', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    if (t.phase !== 'awaiting_approval') return c.text('not awaiting approval', 409);
    const body = await c.req.parseBody();
    const feedback = typeof body.feedback === 'string' ? body.feedback : '';
    try {
      await store.advance(id, { expectRev: formRev(body), to: 'queued',
        mutate: (r) => { r.answers = null; r.rejectFeedback = feedback; } });
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.redirect(`/tasks/${id}`, 303);
  });

  app.post('/tasks/:id/ack', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    if (t.phase !== 'ready' || !t.stage9) return c.text('not ready', 409);
    const body = await c.req.parseBody();
    const items = String(body.items ?? '').split(',').map((n) => Number.parseInt(n.trim(), 10)).filter((n) => Number.isFinite(n));
    try {
      await store.updateRun(id, t.rev, (r) => {
        if (!r.stage9) return;
        for (const it of r.stage9.items) if (items.includes(it.n)) it.acked = true;
      });
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.redirect(`/tasks/${id}`, 303);
  });

  app.post('/tasks/:id/approve-preview', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    if (t.phase !== 'ready' || !t.stage9) return c.text('not ready', 409);
    if (!t.stage9.items.every((it) => it.acked)) return c.text('acknowledge all stage-9 items first', 422);
    const body = await c.req.parseBody();
    try {
      await store.advance(id, { expectRev: formRev(body), to: 'tearing_down',
        mutate: (r) => { r.teardownTarget = 'done'; r.terminalReason = 'approved'; } });
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.redirect(`/tasks/${id}`, 303);
  });

  app.post('/tasks/:id/request-changes', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    if (t.phase !== 'ready') return c.text('not ready', 409);
    const body = await c.req.parseBody();
    const feedback = typeof body.feedback === 'string' ? body.feedback : '';
    try {
      await store.advance(id, { expectRev: formRev(body), to: 'tearing_down',
        mutate: (r) => { r.teardownTarget = 'queued'; r.stage9 = null; r.answers = null; r.rejectFeedback = feedback; } });
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.redirect(`/tasks/${id}`, 303);
  });

  app.post('/tasks/:id/teardown', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    const isFailed = t.phase.endsWith('_failed');
    if (t.phase !== 'ready' && !isFailed) return c.text('not tearable', 409);
    const body = await c.req.parseBody();
    const livePreview = !!t.preview && ['up', 'starting', 'failed', 'tearing_down'].includes(t.preview.state);
    try {
      if (isFailed && !livePreview) {
        await store.advance(id, { expectRev: formRev(body), to: 'abandoned', mutate: (r) => { r.terminalReason = 'abandoned'; } });
      } else {
        await store.advance(id, { expectRev: formRev(body), to: 'tearing_down', mutate: (r) => { r.teardownTarget = 'abandoned'; } });
      }
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.redirect(`/tasks/${id}`, 303);
  });

  app.post('/tasks/:id/retry', async (c) => {
    const id = c.req.param('id');
    const t = await store.get(id);
    if (!t) return c.text('not found', 404);
    const RETRYABLE = new Set(['prep_failed', 'execute_failed', 'preview_failed', 'teardown_failed']);
    if (!RETRYABLE.has(t.phase)) return c.text('retry not available for this phase', 409);
    const body = await c.req.parseBody();
    try {
      await store.updateRun(id, formRev(body), (r) => { r.retryRequested = true; });
    } catch (err) { return c.text('conflict', statusFor(err)); }
    return c.redirect(`/tasks/${id}`, 303);
  });
}
