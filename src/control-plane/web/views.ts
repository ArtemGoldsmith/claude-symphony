// src/control-plane/web/views.ts
// Server-rendered HTML + htmx partials. projectTask is the field WHITELIST
// (spec §9/§17): only operator-safe fields reach the browser. Markdown files
// are shown inside an escaped <pre> (no markdown-renderer dep — YAGNI).

import { ALL_PHASES, isActiveRunPhase, type Phase } from '../phase.js';
import type { TaskRecord } from '../task-record.js';
import { isDiscussAllowed } from './discuss-ws.js';

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
  operatorNote: string | null;
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
    operatorNote: t.operatorNote,
    stage9: t.stage9,
    preview: t.preview ? { url: t.preview.url, state: t.preview.state } : null,
    failedFrom: t.failedFrom,
    terminalReason: t.terminalReason,
    teardownTarget: t.teardownTarget,
    attempts: t.attempts,
    retryRequested: t.retryRequested,
  };
}

/** Inline SVG favicon (data URI) — three accent-blue bars at different heights
 *  (kanban / equalizer hybrid). Served inline so /favicon.* needs no route + no
 *  auth-middleware special-casing; browsers pick it up via the link tag. */
const FAVICON = `<link rel=icon type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect x='1.5' y='4' width='3' height='9' rx='.6' fill='%237aa2f7'/><rect x='6.5' y='2' width='3' height='11' rx='.6' fill='%239bb5ff'/><rect x='11.5' y='6' width='3' height='7' rx='.6' fill='%237aa2f7'/></svg>">`;

/** Shared HTML head — title varies per page so tabs stay distinguishable in
 *  a crowded browser strip (operator's actual complaint: the tab gets lost). */
export function pageHead(title: string): string {
  return `<!doctype html><meta charset=utf-8>
<title>${esc(title)}</title>
${FAVICON}
<meta name=viewport content="width=device-width,initial-scale=1">
<script src="https://unpkg.com/htmx.org@2.0.3"></script>
<style>` + PAGE_STYLE + `</style>`;
}

const PAGE_STYLE = `
body{font-family:system-ui;margin:0;background:#0f1115;color:#e6e6e6}
h1{margin:1rem;font-size:1.1rem;letter-spacing:.02em;color:#aeb6c8}
.board{display:flex;gap:.75rem;overflow-x:auto;padding:1rem}
.col{flex:0 0 14rem;background:#171a21;border-radius:.5rem;padding:.5rem}
.col h2{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#8b93a7;margin:.25rem}
.card{display:block;background:#222732;border-radius:.4rem;padding:.5rem;margin:.4rem 0;color:inherit;text-decoration:none}
.card b{font-size:.8rem}.card .t{font-size:.75rem;color:#aeb6c8}
a{color:#7aa2f7}pre{white-space:pre-wrap;background:#171a21;padding:.75rem;border-radius:.4rem;overflow:auto}
.detail{max-width:48rem;margin:1rem auto;padding:0 1rem}
button{cursor:pointer}
/* Add-ticket form card — styled, multi-field. Operator note feeds the prep agent. */
.add-form{background:linear-gradient(180deg,#1a1f2a 0%,#171a21 100%);border:1px solid #232938;border-radius:.6rem;padding:1rem 1.25rem;margin:1rem;max-width:42rem;display:flex;flex-direction:column;gap:.75rem;box-shadow:0 1px 2px rgba(0,0,0,.4)}
.add-form h2{margin:0;font-size:.95rem;color:#e6e6e6;font-weight:600;letter-spacing:.01em}
.add-form .hint{margin:0;font-size:.78rem;color:#8b93a7;line-height:1.4}
.add-form .lbl{display:block;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#8b93a7;margin-bottom:.3rem}
.add-form .lbl .opt{text-transform:none;font-size:.7rem;color:#5f677a;letter-spacing:0;margin-left:.3rem}
.add-form input.add-id{width:14rem;padding:.55rem .75rem;background:#0f1115;border:1px solid #2a3144;border-radius:.4rem;color:#e6e6e6;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.95rem;letter-spacing:.02em}
.add-form textarea.add-note{width:100%;box-sizing:border-box;padding:.65rem .8rem;background:#0f1115;border:1px solid #2a3144;border-radius:.4rem;color:#e6e6e6;font-family:inherit;font-size:.85rem;line-height:1.5;resize:vertical;min-height:5rem}
.add-form input:focus,.add-form textarea:focus{outline:none;border-color:#7aa2f7;box-shadow:0 0 0 2px rgba(122,162,247,.18)}
.add-form .add-actions{display:flex;justify-content:flex-end;align-items:center;gap:.6rem}
.add-form button{background:#7aa2f7;color:#0f1115;border:none;padding:.55rem 1.1rem;border-radius:.4rem;font-weight:600;font-size:.85rem;cursor:pointer;transition:background .15s}
.add-form button:hover{background:#9bb5ff}
/* Operator-note callout on detail page */
.op-note{background:#1a1f2a;border-left:3px solid #7aa2f7;padding:.55rem .8rem;border-radius:.3rem;margin:.6rem 0}
.op-note h3{margin:0 0 .35rem;font-size:.68rem;text-transform:uppercase;letter-spacing:.05em;color:#8b93a7}
.op-note .body{margin:0;font-family:inherit;white-space:pre-wrap;color:#e6e6e6;font-size:.88rem;line-height:1.45}
/* Live feed — htmx-polled tail of the running agent/script log */
.live-block{background:#171a21;border-radius:.4rem;padding:.6rem .8rem;margin:.6rem 0}
.live-block h3{margin:0 0 .4rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#8b93a7;display:flex;align-items:center;gap:.4rem}
.live-block h3 .dot{width:.5rem;height:.5rem;border-radius:50%;background:#7aa2f7;animation:pulse 1.6s ease-in-out infinite}
.live-meta{display:flex;justify-content:space-between;gap:1rem;font-size:.78rem;margin:0 0 .5rem;padding:.4rem .55rem;border-radius:.3rem;border-left:3px solid #7ee787;background:#0f1115}
.live-meta[data-health=idle]{border-left-color:#e3b341}
.live-meta[data-health=stuck]{border-left-color:#f85149}
.live-now{color:#c4cbdb;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.live-heartbeat{color:#8b93a7;font-variant-numeric:tabular-nums}
.live-meta[data-health=stuck] .live-heartbeat{color:#f85149}
.card-elapsed{display:inline-block;margin-left:.4rem;padding:.05rem .35rem;background:#222732;color:#8b93a7;border-radius:.25rem;font-size:.7rem;font-weight:400;font-variant-numeric:tabular-nums}
.card-now{margin-top:.3rem;font-size:.72rem;color:#7ee787;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-left:2px solid #7ee787;padding-left:.4rem}
.card-now[data-health=idle]{color:#e3b341;border-left-color:#e3b341}
.card-now[data-health=stuck]{color:#f85149;border-left-color:#f85149}
.detail-now{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:0 0 .8rem;padding:.55rem .75rem;background:#0f1115;border-left:3px solid #7ee787;border-radius:.3rem;font-size:.82rem}
.detail-now[data-health=idle]{border-left-color:#e3b341}
.detail-now[data-health=stuck]{border-left-color:#f85149}
.detail-now-label{color:#8b93a7;text-transform:uppercase;font-size:.65rem;letter-spacing:.06em;font-weight:600}
.detail-now-text{color:#c4cbdb;font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail-now-elapsed{color:#8b93a7;font-variant-numeric:tabular-nums;font-size:.76rem}
.detail-now-heartbeat{color:#8b93a7;font-variant-numeric:tabular-nums;font-size:.76rem}
.detail-now[data-health=stuck] .detail-now-heartbeat{color:#f85149}
@keyframes pulse{0%,100%{opacity:.35}50%{opacity:1}}
.live-feed{background:#0f1115;border:1px solid #232938;border-radius:.3rem;padding:.55rem .7rem;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem;line-height:1.45;max-height:24rem;overflow-y:auto;margin:0;color:#c4cbdb;white-space:pre-wrap;word-break:break-word}
.feed-empty{color:#5f677a;font-size:.82rem;font-style:italic;margin:0}
/* Awaiting-approval gate — three-card layout (questions | approve | reject) with clear hierarchy */
.gate-block{margin:1.25rem 0}
.gate-block h2{margin:0 0 .25rem;font-size:1.05rem;color:#e6e6e6}
.gate-block h2 .phase-hint{font-size:.7rem;font-weight:normal;color:#5f677a;text-transform:uppercase;letter-spacing:.05em;margin-left:.5rem}
.gate-hint{margin:0 0 1rem;color:#aeb6c8;font-size:.88rem;line-height:1.5;background:#1a1f2a;border-left:3px solid #7aa2f7;padding:.6rem .85rem;border-radius:.3rem}
.gate-card{background:#171a21;border:1px solid #232938;border-radius:.5rem;padding:.85rem 1rem;margin:.75rem 0}
.gate-card h3{margin:0 0 .35rem;font-size:.92rem;color:#e6e6e6;font-weight:600}
.gate-card h3 .rev{font-size:.7rem;color:#5f677a;font-weight:normal;margin-left:.3rem}
.gate-card .gate-sub{margin:0 0 .65rem;color:#8b93a7;font-size:.8rem;line-height:1.4}
.gate-card .gate-sub code{background:#0f1115;padding:.05rem .35rem;border-radius:.2rem;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.78rem}
.gate-q{margin:.55rem 0}
.gate-q-text{display:block;font-size:.85rem;color:#c4cbdb;margin-bottom:.3rem}
.gate-q .req{color:#f7768e}
.gate-input{width:100%;box-sizing:border-box;padding:.5rem .7rem;background:#0f1115;border:1px solid #2a3144;border-radius:.35rem;color:#e6e6e6;font-family:inherit;font-size:.85rem;line-height:1.45}
.gate-input:focus{outline:none;border-color:#7aa2f7;box-shadow:0 0 0 2px rgba(122,162,247,.18)}
.ack-label{display:flex;align-items:center;gap:.4rem;font-size:.85rem;color:#c4cbdb;margin-bottom:.5rem;cursor:pointer}
.ack-label input{cursor:pointer}
.btn-primary{background:#7aa2f7;color:#0f1115;border:none;padding:.55rem 1.1rem;border-radius:.4rem;font-weight:600;font-size:.85rem;cursor:pointer;transition:background .15s}
.btn-primary:hover{background:#9bb5ff}
.btn-secondary{background:#222732;color:#c4cbdb;border:1px solid #2a3144;padding:.5rem 1rem;border-radius:.4rem;font-size:.83rem;cursor:pointer;transition:all .15s;margin-top:.45rem}
.btn-secondary:hover{background:#2a3144;border-color:#3a4258}
`;

/** Human-friendly elapsed seconds: <60 → "Xs", <1h → "Xm", ≥1h → "Xh Ym". */
function fmtElapsedShort(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** "Now-doing" + heartbeat per ticket, supplied by the board route from
 *  synthesiseActivity so board cards can surface live status alongside the
 *  elapsed badge. Tickets without an active run are simply absent from the
 *  map. */
export interface CardActivity {
  now: string;
  lastActivitySec: number;
  health: 'fresh' | 'idle' | 'stuck';
}

export function renderTaskCard(t: TaskRecord, activity?: CardActivity): string {
  const p = projectTask(t);
  // Elapsed badge for active-run phases — at-a-glance "is this taking long?".
  const elapsedBadge = isActiveRunPhase(t.phase) && t.currentRun
    ? ` <span class=card-elapsed>${fmtElapsedShort(Math.max(0, Math.floor(Date.now() / 1000) - t.currentRun.spawnedAt))}</span>`
    : '';
  // Synthesised "now: ..." line — only on active-run phases with an activity
  // sample available. Coloured by the health classifier (fresh / idle / stuck).
  const nowLine = activity
    ? `<div class=card-now data-health="${activity.health}">${esc(activity.now)}</div>`
    : '';
  return `<a class=card href="/tasks/${esc(p.ticket)}"><b>${esc(p.ticket)}${elapsedBadge}</b><div class=t>${esc(p.title)}</div>${nowLine}</a>`;
}

export function renderBoard(tasks: TaskRecord[], activities?: ReadonlyMap<string, CardActivity>): string {
  const byPhase = new Map<Phase, TaskRecord[]>();
  for (const ph of ALL_PHASES) byPhase.set(ph, []);
  for (const t of tasks) byPhase.get(t.phase)!.push(t);
  const cols = ALL_PHASES.map((ph) => {
    const cards = (byPhase.get(ph) ?? []).map((t) => renderTaskCard(t, activities?.get(t.ticket))).join('');
    return `<section class=col><h2>${esc(ph)}</h2>${cards}</section>`;
  }).join('');
  // .board polls itself every 8s — htmx hx-select picks the new .board out of the
  // fresh full-page response and outerHTML-swaps THIS .board. Add-form sits OUTSIDE
  // .board so the operator's typing is never wiped by the swap.
  return `${pageHead('symphony')}<h1>symphony board</h1>
<form class=add-form method=post action=/tasks>
  <h2>+ new ticket</h2>
  <p class=hint>The prep agent fetches the Linear ticket and any comments on its own. Use the note below to nudge it: a focus area, what NOT to touch, a reference, an edge case, a recent slack thread — anything the bare Linear ticket wouldn't tell it. The Hard rules in the prep prompt stay authoritative; this is treated as untrusted operator input.</p>
  <label>
    <span class=lbl>Linear ticket</span>
    <input class=add-id name=ticket placeholder="PIN-NNN" required autocomplete=off>
  </label>
  <label>
    <span class=lbl>Note for the prep agent<span class=opt>(optional)</span></span>
    <textarea class=add-note name=note rows=5 placeholder="e.g.&#10;focus on the role-aware redirect (workflow doc §3.2)&#10;skip the audit-log work for now, defer to a follow-up&#10;reuse the upload component from TEAM-NNN instead of building new"></textarea>
  </label>
  <div class=add-actions><button type=submit>add to board ▸</button></div>
</form>
<div class=board hx-get="/" hx-trigger="every 8s" hx-select=".board" hx-swap=outerHTML>${cols}</div>`;
}

export interface DetailFiles {
  plan: string;
  recap: string;
  reviewFresh: string;
}

export function renderDetail(t: TaskRecord, files: DetailFiles, activity?: CardActivity): string {
  const p = projectTask(t);
  // Auto-refresh the detail every 8s while phase is active-run (agent owns the
  // transitions there — operator doesn't have forms to lose). For phases with
  // forms (awaiting_approval / ready / *_failed retry button) polling is OFF so
  // user input isn't wiped; manual button clicks set HX-Refresh server-side to
  // force a reload immediately after the mutation.
  const detailPoll = isActiveRunPhase(p.phase)
    ? ` hx-get="/tasks/${esc(p.ticket)}" hx-trigger="every 8s" hx-select=".detail" hx-swap=outerHTML`
    : '';
  // Activity strip directly under the phase line — surfaces "waiting on codex
  // review", elapsed since spawn, and last-activity heartbeat right at the
  // header so the operator doesn't have to scroll into the live-feed to know
  // what the agent is currently doing.
  const elapsedActive = isActiveRunPhase(p.phase) && t.currentRun
    ? fmtElapsedShort(Math.max(0, Math.floor(Date.now() / 1000) - t.currentRun.spawnedAt))
    : null;
  const activityStrip = activity
    ? `<div class=detail-now data-health="${activity.health}"><span class=detail-now-label>now</span><span class=detail-now-text>${esc(activity.now)}</span>${elapsedActive ? `<span class=detail-now-elapsed>${esc(elapsedActive)} active</span>` : ''}<span class=detail-now-heartbeat>last activity ${esc(activity.lastActivitySec < 60 ? `${activity.lastActivitySec}s` : `${Math.floor(activity.lastActivitySec / 60)}m ${activity.lastActivitySec % 60}s`)} ago</span></div>`
    : '';
  const parts: string[] = [
    `${pageHead(`${p.ticket} · ${p.phase} — symphony`)}<div class=detail${detailPoll}><a href="/">&larr; board</a>`,
    `<h1>${esc(p.ticket)} — ${esc(p.title)}</h1>`,
    `<p>phase: <b>${esc(p.phase)}</b> · rev ${p.rev}${p.failedFrom && p.phase.endsWith('_failed') ? ` · failedFrom ${esc(p.failedFrom)}` : ''}</p>`,
    activityStrip,
    p.operatorNote ? `<div class=op-note><h3>operator note</h3><div class=body>${esc(p.operatorNote)}</div></div>` : '',
    isActiveRunPhase(p.phase) ? `<div class=live-block><h3><span class=dot></span> live · ${esc(p.phase)}</h3><div id=live-feed hx-get="/tasks/${esc(p.ticket)}/live" hx-trigger="load, every 4s" hx-swap=innerHTML><p class=feed-empty>connecting…</p></div></div>` : '',
    renderDiscussPanel(t),
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
  const hasItems = oq.items.length > 0;
  // Pre-fill inputs from previously-saved answers (if their rev matches the
  // current questions rev — stale answers from a prior re-prep are ignored).
  const savedValues: Record<string, string> =
    p.answers && p.answers.questionsRev === oq.rev ? p.answers.values : {};
  const fields = oq.items.map((q) => {
    const name = `q_${esc(q.id)}`;
    const saved = savedValues[q.id] ?? '';
    let input: string;
    if (q.kind === 'choice' && q.options) {
      input = `<select class=gate-input name="${name}">${q.options.map((o) =>
        `<option value="${esc(o)}"${o === saved ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (q.kind === 'bool') {
      input = `<select class=gate-input name="${name}"><option value=yes${saved === 'yes' ? ' selected' : ''}>yes</option><option value=no${saved === 'no' ? ' selected' : ''}>no</option></select>`;
    } else {
      input = `<textarea class=gate-input name="${name}" rows=2>${esc(saved)}</textarea>`;
    }
    return `<p class=gate-q><label><span class=gate-q-text>${esc(q.text)}${q.required ? ' <span class=req>*</span>' : ''}</span>${input}</label></p>`;
  }).join('');
  const answeredCount = Object.keys(savedValues).length;
  const savedNote = answeredCount > 0
    ? ` <span class=rev>(${answeredCount}/${oq.items.length} answered)</span>`
    : '';

  // "What do I do now?" guidance — shown above the gates because the operator
  // landing on awaiting_approval needs a clear next-step framing.
  const noQuestionsHint = !hasItems
    ? `<p class=gate-hint>The agent flagged <b>no specific questions</b> for you — read the plan above, then either <b>approve</b> to send it to execute, or <b>reject &amp; re-prep</b> with feedback if the plan is off direction.</p>`
    : `<p class=gate-hint>The agent asked the questions below. Answer the required ones (*) before approving, or <b>reject &amp; re-prep</b> with feedback if the whole direction is off.</p>`;

  // Three gates, visually separated as cards.
  const questionsCard = hasItems
    ? `<div class=gate-card>
  <h3>1. answer open questions <span class=rev>(rev ${oq.rev})</span>${savedNote}</h3>
  <form hx-post="/tasks/${esc(p.ticket)}/answers" hx-target=body>
    <input type=hidden name=questionsRev value="${oq.rev}">${fields}
    <button class=btn-secondary>save answers</button>
  </form>
</div>`
    : '';

  const approveCard = `<div class=gate-card>
  <h3>${hasItems ? '2. ' : ''}approve plan</h3>
  <p class=gate-sub>Confirms you reviewed the plan at <code>rev ${oq.rev}</code>; sends the task to <code>executing</code>.</p>
  <form hx-post="/tasks/${esc(p.ticket)}/approve" hx-target=body>
    <input type=hidden name=rev value="${p.rev}"><input type=hidden name=planAckRev value="${oq.rev}">
    <label class=ack-label><input type=checkbox name=ack required> I have reviewed the plan above</label>
    <button class=btn-primary>approve →</button>
  </form>
</div>`;

  const rejectCard = `<div class=gate-card>
  <h3>${hasItems ? '3. ' : ''}reject &amp; re-prep</h3>
  <p class=gate-sub>Sends the task back to <code>queued</code>; the prep agent re-plans incorporating your feedback below.</p>
  <form hx-post="/tasks/${esc(p.ticket)}/reject" hx-target=body>
    <input type=hidden name=rev value="${p.rev}">
    <textarea class=gate-input name=feedback rows=3 placeholder="why reject — what to change in the next plan"></textarea>
    <button class=btn-secondary>reject &amp; re-prep</button>
  </form>
</div>`;

  return `<div class=gate-block>
  <h2>your decision <span class=phase-hint>(phase: awaiting_approval)</span></h2>
  ${noQuestionsHint}
  ${questionsCard}
  ${approveCard}
  ${rejectCard}
</div>`;
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

/**
 * Detail-page panel for the embedded discuss-with-agent terminal. Server-renders
 * a collapsible <details>; the inline <script> lazy-loads vendored xterm.js +
 * addon-fit on first open, connects WS, and fully tears down on close.
 *
 * Hidden by isDiscussAllowed when the phase / state forbids discussion (see
 * spec §6).
 *
 * Loader strategy: vendored xterm.js is a UMD bundle (attaches window.Terminal
 * and window.FitAddon as side effects), so we inject classic <script> tags
 * instead of using ES dynamic import() — UMD does not export anything an ESM
 * import can bind to.
 */
export function renderDiscussPanel(t: TaskRecord): string {
  if (!isDiscussAllowed(t)) return '';
  const ticket = esc(t.ticket);
  const panelId = `discuss-term-${ticket}`;
  return `<details class=discuss-panel style="margin-top:12px;border:1px solid #2a3140;border-left:3px solid #4a9eff;border-radius:6px;background:#13171f;padding:10px 14px">
  <summary style="cursor:pointer;font-weight:600;color:#9ab4d4;user-select:none">💬 chat with the agent</summary>
  <link rel=stylesheet href="/static/xterm/xterm.css">
  <div id="${panelId}" style="height:480px;background:#0b0e13;margin-top:10px;border:1px solid #2a3140;border-radius:4px;padding:6px"></div>
  <script>(() => {
    const root = document.currentScript.parentElement;
    let booted = false, term = null, fit = null, ws = null, resizeHandler = null;

    function loadScript(src) {
      return new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = src; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }

    async function boot() {
      booted = true;
      await Promise.all([
        loadScript('/static/xterm/xterm.js'),
        loadScript('/static/xterm/addon-fit.js'),
      ]);
      term = new window.Terminal({ fontSize: 13, theme: { background: '#0b0e13' } });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(document.getElementById('${panelId}'));
      fit.fit();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(\`\${proto}//\${location.host}/tasks/${ticket}/discuss\`);
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data)); };
      term.onData((data) => { if (ws && ws.readyState === 1) ws.send(new TextEncoder().encode(data)); });
      const sendResize = () => {
        if (!fit || !ws) return;
        fit.fit();
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };
      ws.onopen = sendResize;
      resizeHandler = sendResize;
      window.addEventListener('resize', resizeHandler);
    }

    function teardown() {
      if (ws && ws.readyState !== 3) { try { ws.close(); } catch (_) {} }
      if (resizeHandler) { window.removeEventListener('resize', resizeHandler); }
      if (term) { try { term.dispose(); } catch (_) {} }
      term = fit = ws = resizeHandler = null;
      booted = false;
    }

    root.addEventListener('toggle', () => {
      if (root.open && !booted) boot().catch((e) => console.error('discuss-panel boot:', e));
      else if (!root.open && booted) teardown();
    });
    window.addEventListener('beforeunload', () => { if (booted) teardown(); });
  })();</script>
</details>`;
}

function renderRetry(p: ProjectedTask): string {
  const canRetry = p.phase === 'prep_failed' || p.phase === 'execute_failed'
    || p.phase === 'preview_failed' || p.phase === 'teardown_failed';
  return `<h2>failed (${esc(p.phase)})</h2><p>attempts: prep ${p.attempts.prep} / execute ${p.attempts.execute}</p>
${canRetry ? `<form hx-post="/tasks/${esc(p.ticket)}/retry" hx-target=body><input type=hidden name=rev value="${p.rev}"><button>retry</button></form>` : ''}
<form hx-post="/tasks/${esc(p.ticket)}/teardown" hx-target=body style="margin-top:.5rem"><input type=hidden name=rev value="${p.rev}"><button>teardown (abandon)</button></form>`;
}
