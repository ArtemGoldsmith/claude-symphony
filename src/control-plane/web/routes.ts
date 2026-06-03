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
import type { DiscussLease } from '../discuss-lease.js';
import { renderBoard, renderDetail, esc } from './views.js';
import { mountStaticAssets } from './static-assets.js';

export interface RoutesDeps {
  store: TaskStore;
  linearRead: LinearReadGateway;
  stateRoot: string;
  staticRoot: string;
  discussLease: DiscussLease;
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

/** Reply that tells htmx to do a full page reload — used after mutation routes
 *  so the operator's view immediately reflects the new phase / state without
 *  manual refresh. The 303 redirect pattern (set HX-Refresh header, then
 *  c.redirect(...)) does NOT work in htmx 2.x — the redirect is followed and
 *  swapped via hx-target=body, but the page is NOT actually reloaded (htmx
 *  treats it as a normal swap, not a refresh). Replacing the redirect with a
 *  bare 200 + HX-Refresh header is the htmx-canonical pattern: htmx sees the
 *  header on any success response and calls location.reload(). Non-htmx clients
 *  see a 200 OK with empty body (no functional impact — only htmx submits these). */
function hxRefresh(c: import('hono').Context): Response {
  c.header('HX-Refresh', 'true');
  return c.body(null, 200);
}

/** Truncate a string for live-feed display. */
function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Summarise tool_use input for the live feed — readable, never the full args. */
function summariseToolInput(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && typeof input.command === 'string') return trunc(input.command, 90);
  if ((name === 'Read' || name === 'Edit' || name === 'Write') && typeof input.file_path === 'string') {
    return path.basename(input.file_path);
  }
  if (name === 'Grep' && typeof input.pattern === 'string') return `/${trunc(input.pattern, 60)}/`;
  if (name === 'Glob' && typeof input.pattern === 'string') return input.pattern;
  if (name === 'TodoWrite') return '<todos>';
  if (name === 'Task' && typeof input.description === 'string') return trunc(input.description, 80);
  const k = Object.keys(input).slice(0, 2);
  return k.length > 0 ? k.join(',') : '';
}

interface ClaudeStreamEvent {
  type?: string; subtype?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: Array<{ type?: string; text?: string }> }> };
  model?: string; cwd?: string;
  duration_ms?: number; num_turns?: number; total_cost_usd?: number;
}

/** One JSONL event → 0..N human-readable lines for the live feed. */
function formatEvent(ev: ClaudeStreamEvent): string[] {
  const out: string[] = [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    out.push(`▶ session start · model=${ev.model ?? '?'} · cwd=${path.basename(ev.cwd ?? '')}`);
    return out;
  }
  if (ev.type === 'result') {
    const cost = typeof ev.total_cost_usd === 'number' ? `$${ev.total_cost_usd.toFixed(3)}` : '?';
    const dur = ev.duration_ms ? `${Math.round(ev.duration_ms / 1000)}s` : '?';
    out.push(`✓ done · turns=${ev.num_turns ?? '?'} · ${cost} · ${dur}`);
    return out;
  }
  if (ev.type === 'assistant' && ev.message?.content) {
    for (const item of ev.message.content) {
      if (item.type === 'text' && item.text) {
        const text = item.text.trim().replace(/\s+/g, ' ');
        if (text) out.push(`💭 ${trunc(text, 160)}`);
      } else if (item.type === 'tool_use') {
        out.push(`🔧 ${item.name ?? '?'} ${summariseToolInput(item.name ?? '', item.input ?? {})}`);
      }
    }
    return out;
  }
  if (ev.type === 'user' && ev.message?.content) {
    for (const item of ev.message.content) {
      if (item.type === 'tool_result' && item.content) {
        const text = item.content.map((c) => c.text ?? '').join(' ').trim().replace(/\s+/g, ' ');
        if (text) out.push(`  ↳ ${trunc(text, 120)}`);
      }
    }
    return out;
  }
  return out;
}

/** Last N human-readable lines from a claude stream-json log file. */
async function tailClaudeStream(logPath: string, maxLines: number): Promise<string> {
  let raw: string;
  try { raw = await fs.readFile(logPath, 'utf8'); } catch { return ''; }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const out: string[] = [];
  // Parse a generous window from the end (events expand to multi-line, so over-read).
  for (let i = Math.max(0, lines.length - maxLines * 3); i < lines.length; i++) {
    try { out.push(...formatEvent(JSON.parse(lines[i]!) as ClaudeStreamEvent)); } catch { /* skip non-JSON */ }
  }
  return out.slice(-maxLines).join('\n');
}

/** Last N raw lines from a plain-text log (preview-up / preview-down output). */
async function tailPlain(logPath: string, maxLines: number): Promise<string> {
  let raw: string;
  try { raw = await fs.readFile(logPath, 'utf8'); } catch { return ''; }
  return raw.split('\n').filter((l) => l.length > 0).slice(-maxLines).join('\n');
}

export function mountRoutes(app: Hono, deps: RoutesDeps): void {
  const { store, linearRead, stateRoot } = deps;

  mountStaticAssets(app, deps.staticRoot);
  deps.discussLease.mountRoutes?.(app); // optional — nullDiscussLease omits this method

  app.get('/', async (c) => c.html(renderBoard(await store.list())));

  /**
   * Live feed for a task's currently-running agent/script. Polled by htmx every
   * few seconds from the detail page (only while phase ∈ ACTIVE_RUN_PHASES).
   * Returns a small <pre> with the tail of the run's log:
   *  - claude-agent kinds (prep/execute/review/gapfix/closeout): parses
   *    stream-json into human-readable lines (thoughts, tool uses, results).
   *  - script kinds (preview/teardown): plain tail of the .log file.
   * Returns "no active run" when currentRun is null.
   */
  app.get('/tasks/:id/live', async (c) => {
    const t = await store.get(c.req.param('id'));
    if (!t) return c.text('not found', 404);
    if (!t.currentRun) return c.html('<p class=feed-empty>no active run</p>');
    const logPath = path.join(taskDir(stateRoot, t.ticket), t.currentRun.log);
    const isScript = t.currentRun.kind === 'preview' || t.currentRun.kind === 'teardown';
    const body = isScript ? await tailPlain(logPath, 40) : await tailClaudeStream(logPath, 25);
    if (body.length === 0) return c.html('<p class=feed-empty>log not started yet</p>');
    return c.html(`<pre class=live-feed>${esc(body)}</pre>`);
  });

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
    return hxRefresh(c);
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
    return hxRefresh(c);
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
    return hxRefresh(c);
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
    return hxRefresh(c);
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
    return hxRefresh(c);
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
    return hxRefresh(c);
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
    return hxRefresh(c);
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
    return hxRefresh(c);
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
    return hxRefresh(c);
  });
}
