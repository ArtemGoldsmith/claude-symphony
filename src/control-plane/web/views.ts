// src/control-plane/web/views.ts
// Server-rendered HTML + htmx partials. projectTask is the field WHITELIST
// (spec §9/§17): only operator-safe fields reach the browser. Markdown files
// are shown inside an escaped <pre> (no markdown-renderer dep — YAGNI).

import { ALL_PHASES, type Phase } from '../phase.js';
import type { TaskRecord } from '../task-record.js';

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ProjectedTask {
  ticket: string;
  phase: Phase;
  rev: number;
  title: string;
  url: string;
  branch: string | null;
  createdAt: number;
  updatedAt: number;
  openQuestions: TaskRecord['openQuestions'];
  answers: TaskRecord['answers'];
  rejectFeedback: string | null;
  stage9: TaskRecord['stage9'];
  preview: { url: string; state: string } | null;
  failedFrom: Phase | null;
  terminalReason: TaskRecord['terminalReason'];
  teardownTarget: TaskRecord['teardownTarget'];
  attempts: TaskRecord['attempts'];
  retryRequested: boolean;
}

/** Whitelist projection — NEVER currentRun/ownerGen/worktree/baseSha/env/jsonl. */
export function projectTask(t: TaskRecord): ProjectedTask {
  return {
    ticket: t.ticket,
    phase: t.phase,
    rev: t.rev,
    title: t.title,
    url: t.url,
    branch: t.branch,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    openQuestions: t.openQuestions,
    answers: t.answers,
    rejectFeedback: t.rejectFeedback,
    stage9: t.stage9,
    preview: t.preview ? { url: t.preview.url, state: t.preview.state } : null,
    failedFrom: t.failedFrom,
    terminalReason: t.terminalReason,
    teardownTarget: t.teardownTarget,
    attempts: t.attempts,
    retryRequested: t.retryRequested,
  };
}

const PAGE_HEAD = `<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/htmx.org@2.0.3"></script>
<style>
body{font-family:system-ui;margin:0;background:#0f1115;color:#e6e6e6}
.board{display:flex;gap:.75rem;overflow-x:auto;padding:1rem}
.col{flex:0 0 14rem;background:#171a21;border-radius:.5rem;padding:.5rem}
.col h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#8b93a7;margin:.25rem}
.card{display:block;background:#222732;border-radius:.4rem;padding:.5rem;margin:.4rem 0;color:inherit;text-decoration:none}
.card b{font-size:.8rem}.card .t{font-size:.75rem;color:#aeb6c8}
a{color:#7aa2f7}pre{white-space:pre-wrap;background:#171a21;padding:.75rem;border-radius:.4rem;overflow:auto}
.detail{max-width:48rem;margin:1rem auto;padding:0 1rem}
button{cursor:pointer}
</style>`;

export function renderTaskCard(t: TaskRecord): string {
  const p = projectTask(t);
  return `<a class=card href="/tasks/${esc(p.ticket)}"><b>${esc(p.ticket)}</b><div class=t>${esc(p.title)}</div></a>`;
}

export function renderBoard(tasks: TaskRecord[]): string {
  const byPhase = new Map<Phase, TaskRecord[]>();
  for (const ph of ALL_PHASES) byPhase.set(ph, []);
  for (const t of tasks) byPhase.get(t.phase)!.push(t);
  const cols = ALL_PHASES.map((ph) => {
    const cards = (byPhase.get(ph) ?? []).map(renderTaskCard).join('');
    return `<section class=col><h2>${esc(ph)}</h2>${cards}</section>`;
  }).join('');
  return `${PAGE_HEAD}<h1 style="margin:1rem">symphony board</h1>
<form method=post action=/tasks style="margin:0 1rem"><input name=ticket placeholder="TEAM-NNN"> <button>add</button></form>
<div class=board>${cols}</div>`;
}

export interface DetailFiles { plan: string; recap: string; reviewFresh: string; }

export function renderDetail(t: TaskRecord, files: DetailFiles): string {
  const p = projectTask(t);
  const parts: string[] = [
    `${PAGE_HEAD}<div class=detail><a href="/">&larr; board</a>`,
    `<h1>${esc(p.ticket)} — ${esc(p.title)}</h1>`,
    `<p>phase: <b>${esc(p.phase)}</b> · rev ${p.rev}${p.failedFrom ? ` · failedFrom ${esc(p.failedFrom)}` : ''}</p>`,
    `<p><a href="${esc(p.url)}" target=_blank rel=noopener>Linear ticket</a></p>`,
  ];
  if (files.plan) parts.push(`<h2>plan</h2><pre>${esc(files.plan)}</pre>`);
  if (files.reviewFresh) parts.push(`<h2>AC review (review-fresh.md)</h2><pre>${esc(files.reviewFresh)}</pre>`);
  if (p.phase === 'awaiting_approval' && p.openQuestions) parts.push(renderAnswerForm(p));
  if (p.phase === 'ready') {
    if (p.preview) parts.push(`<h2>preview</h2><p><a href="${esc(p.preview.url)}" target=_blank rel=noopener>open preview (${esc(p.preview.state)})</a></p>`);
    if (files.recap) parts.push(`<h2>recap</h2><pre>${esc(files.recap)}</pre>`);
    if (p.stage9) parts.push(renderStage9(p));
  }
  if (p.phase.endsWith('_failed')) parts.push(renderRetry(p));
  parts.push(`</div>`);
  return parts.join('\n');
}

function renderAnswerForm(p: ProjectedTask): string {
  const oq = p.openQuestions!;
  const fields = oq.items.map((q) => {
    const name = `q_${esc(q.id)}`;
    let input: string;
    if (q.kind === 'choice' && q.options) {
      input = `<select name="${name}">${q.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}</select>`;
    } else if (q.kind === 'bool') {
      input = `<select name="${name}"><option value=yes>yes</option><option value=no>no</option></select>`;
    } else {
      input = `<textarea name="${name}" rows=2 style="width:100%"></textarea>`;
    }
    return `<p><label>${esc(q.text)}${q.required ? ' *' : ''}<br>${input}</label></p>`;
  }).join('');
  return `<h2>open questions (rev ${oq.rev})</h2>
<form hx-post="/tasks/${esc(p.ticket)}/answers" hx-swap=none>
<input type=hidden name=questionsRev value="${oq.rev}">${fields}<button>save answers</button></form>
<form hx-post="/tasks/${esc(p.ticket)}/approve" hx-target=body style="margin-top:.5rem">
<input type=hidden name=rev value="${p.rev}"><input type=hidden name=planAckRev value="${oq.rev}">
<label><input type=checkbox name=ack required> I have reviewed the plan</label>
<button>approve</button></form>
<form hx-post="/tasks/${esc(p.ticket)}/reject" hx-target=body style="margin-top:.5rem">
<input type=hidden name=rev value="${p.rev}"><input name=feedback placeholder="why reject" style="width:100%"><button>reject &amp; re-prep</button></form>`;
}

function renderStage9(p: ProjectedTask): string {
  const s = p.stage9!;
  const HIGH = new Set(['MISSED', 'CUT', 'PRODUCT']);
  const rows = s.items.map((it) => {
    const high = HIGH.has(it.tag);
    if (it.acked) return `<li>[${it.n}] (${esc(it.tag)}) ${esc(it.text)} — <b>acked</b></li>`;
    const btn = `<button hx-post="/tasks/${esc(p.ticket)}/ack" hx-vals='{"items":[${it.n}]}' hx-target=body>${high ? 'read & leave it' : 'ack'}</button>`;
    return `<li>[${it.n}] ${high ? '<b>(HIGH)</b> ' : ''}(${esc(it.tag)}) ${esc(it.text)} ${btn}</li>`;
  }).join('');
  const allAcked = s.items.every((it) => it.acked);
  return `<h2>stage 9 — disclosed shortcomings</h2><ul>${rows}</ul>
<form hx-post="/tasks/${esc(p.ticket)}/approve-preview" hx-target=body>
<input type=hidden name=rev value="${p.rev}"><button ${allAcked ? '' : 'disabled'}>approve preview</button></form>
<form hx-post="/tasks/${esc(p.ticket)}/request-changes" hx-target=body style="margin-top:.5rem">
<input type=hidden name=rev value="${p.rev}"><input name=feedback placeholder="what to change" style="width:100%"><button>request changes</button></form>
<form hx-post="/tasks/${esc(p.ticket)}/teardown" hx-target=body style="margin-top:.5rem"><input type=hidden name=rev value="${p.rev}"><button>teardown (abandon)</button></form>`;
}

function renderRetry(p: ProjectedTask): string {
  const canRetry = p.phase === 'prep_failed' || p.phase === 'execute_failed';
  return `<h2>failed</h2><p>attempts: prep ${p.attempts.prep} / execute ${p.attempts.execute}</p>
${canRetry ? `<form hx-post="/tasks/${esc(p.ticket)}/retry" hx-target=body><input type=hidden name=rev value="${p.rev}"><button>retry</button></form>` : '<p>preview/teardown retry is Plan 4</p>'}
<form hx-post="/tasks/${esc(p.ticket)}/teardown" hx-target=body style="margin-top:.5rem"><input type=hidden name=rev value="${p.rev}"><button>teardown (abandon)</button></form>`;
}
