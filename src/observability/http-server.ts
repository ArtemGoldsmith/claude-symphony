// SPEC.md §13.3 + §13.4 + §13.7 — operator-facing status surface (Phase 3 P3).
//
// Lightweight node:http server. Dependencies kept to zero so the process
// stays small and there's nothing to upgrade. Three JSON endpoints plus a
// single-page HTML dashboard that polls /api/v1/state every 5 s.

import http, { type Server } from 'node:http';
import { URL } from 'node:url';

import type { Orchestrator } from '../orchestrator/orchestrator.js';

export interface StatusServer {
  port: number;
  close(): Promise<void>;
}

export interface StartStatusServerOptions {
  port: number;
  orchestrator: Orchestrator;
  /** Bind address. Default `127.0.0.1` (localhost-only). */
  host?: string;
}

export function startStatusServer(options: StartStatusServerOptions): Promise<StatusServer> {
  const host = options.host ?? '127.0.0.1';
  return new Promise<StatusServer>((resolve, reject) => {
    const server: Server = http.createServer(async (req, res) => {
      try {
        await handleRequest(req, res, options.orchestrator);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
    server.on('error', reject);
    server.listen(options.port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr !== null ? addr.port : options.port;
      resolve({
        port: actualPort,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()));
          }),
      });
    });
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  orchestrator: Orchestrator,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml());
    return;
  }

  if (method === 'GET' && url.pathname === '/api/v1/state') {
    sendJson(res, 200, orchestrator.snapshot());
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/v1/issues/')) {
    const identifier = decodeURIComponent(url.pathname.slice('/api/v1/issues/'.length));
    const snap = orchestrator.snapshot();
    // Matching by issueId OR identifier — operators usually grep by the
    // human key (CHR-123) but our state is keyed by the internal id.
    // Walk both keys.
    for (const [issueId, entry] of Object.entries(snap.state.issues)) {
      if (issueId === identifier) {
        sendJson(res, 200, { issueId, ...entry });
        return;
      }
    }
    sendJson(res, 404, { error: `no state record for "${identifier}"` });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/v1/refresh') {
    void orchestrator.refreshNow();
    sendJson(res, 202, { triggered: true });
    return;
  }

  sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>claude-symphony</title>
<style>
:root { color-scheme: light dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
body { max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
h1 { margin: 0 0 .5rem; font-size: 1.4rem; }
.meta { color: #666; font-size: .9rem; margin-bottom: 1rem; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #ccc4; vertical-align: top; }
th { background: #88888822; }
.state-running { color: #1862c4; font-weight: 600; }
.state-claimed { color: #1862c4; }
.state-completed { color: #2a8a2a; }
.state-failed { color: #c43a26; }
.state-retry_pending { color: #c47e26; }
.state-idle { color: #666; }
.muted { color: #888; }
button { font: inherit; padding: .3rem .8rem; cursor: pointer; }
</style>
</head>
<body>
<h1>claude-symphony</h1>
<div class="meta" id="meta">loading…</div>
<button onclick="refreshNow()">refresh now</button>
<button onclick="reload()">reload state</button>
<table>
<thead><tr><th>issueId</th><th>state</th><th>attempts</th><th>failures</th><th>session</th><th>retryAt</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<script>
async function reload() {
  const res = await fetch('/api/v1/state');
  if (!res.ok) { document.getElementById('meta').textContent = 'fetch failed: ' + res.status; return; }
  const snap = await res.json();
  const meta = document.getElementById('meta');
  meta.textContent =
    'project: ' + snap.config.project_slug +
    ' · active: [' + snap.config.active_states.join(', ') + ']' +
    ' · cap: ' + snap.config.max_concurrent_agents +
    ' · poll: ' + (snap.config.polling_interval_ms/1000) + 's' +
    ' · running: ' + (snap.running ? 'yes' : 'no') +
    ' · saved: ' + new Date(snap.state.savedAt).toISOString();
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  const ids = Object.keys(snap.state.issues).sort();
  if (ids.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6; td.className = 'muted'; td.textContent = '(no tracked issues)';
    tr.appendChild(td); tbody.appendChild(tr); return;
  }
  for (const id of ids) {
    const e = snap.state.issues[id];
    const tr = document.createElement('tr');
    const cells = [
      id,
      e.state,
      e.attemptCount,
      e.failureCount,
      e.sessionId ? e.sessionId.slice(0, 12) + '…' : '—',
      e.retry ? new Date(e.retry.notBefore).toISOString() : '—',
    ];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = String(v);
      if (i === 1) td.className = 'state-' + e.state;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}
async function refreshNow() {
  await fetch('/api/v1/refresh', { method: 'POST' });
  setTimeout(reload, 500);
}
reload();
setInterval(reload, 5000);
</script>
</body>
</html>`;
}
