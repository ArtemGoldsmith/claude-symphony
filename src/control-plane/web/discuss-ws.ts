// src/control-plane/web/discuss-ws.ts
// Spec: 2026-06-01-web-terminal-discuss-design.md §3-§7.
// isDiscussAllowed gate + createDiscussLease factory: per-ticket conns Map +
// dispatching Set + supersede + heartbeat + idle + pty spawn
// (`claude --continue --settings <RO> --permission-mode dontAsk`) + Hono
// pre-upgrade middleware + WS lifecycle handlers. The factory owns the
// engine port (DiscussLease) so the daemon never imports the web layer.

import { upgradeWebSocket } from '@hono/node-server';
import type { Hono, Context } from 'hono';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IPty } from 'node-pty';
import { spawn as ptySpawnReal } from 'node-pty';
import type { WebSocket as RawWS } from 'ws';

import type { Phase } from '../phase.js';
import type { TaskRecord } from '../task-record.js';
import type { TaskStore } from '../task-store.js';
import { assertSafeIssueIdentifier } from '../../util/path-safety.js';
import { buildDiscussSettingsJson, buildDiscussEnv } from '../settings-policy.js';
import type { DiscussLease } from '../discuss-lease.js';

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

/** Per-connection bookkeeping (one record per active discuss WS). */
interface ConnRec {
  rawWs: RawWS;
  pty: IPty | null;
  closed: boolean;
  ticket: string;
  /** Set when this conn supersedes an earlier one — spawnPty awaits prior tear-down
   *  before starting its own pty so we never leak two ptys for one ticket. */
  priorTeardown?: Promise<void>;
  lastPong: number;
  lastActivity: number;
  hbTimer?: NodeJS.Timeout;
}

export interface DiscussTerminalCfg {
  enabled: boolean;
  idle_timeout_seconds: number;
  heartbeat_seconds: number;
  pong_grace_seconds: number;
  max_concurrent_global: number;
  pty_kill_timeout_ms: number;
}

export interface CreateDiscussLeaseOpts {
  store: TaskStore;
  cfg: DiscussTerminalCfg;
  /** Where `<ticket>/discuss-settings.json` is written per spawn (absolute path). */
  settingsRoot: string;
  /** Absolute path to scripts/discuss-deny-guard.sh — passed into the RO settings. */
  denyGuardPath: string;
  /** Test seam — default is the real `node-pty.spawn`. */
  ptySpawner?: (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => IPty;
  /** Test seam — default is `process.kill(pid, 0)` liveness probe. */
  pidLiveness?: (pid: number) => boolean;
}

export function createDiscussLease(opts: CreateDiscussLeaseOpts): DiscussLease {
  const conns = new Map<string, ConnRec>();
  const dispatching = new Set<string>();
  const pidLiveness = opts.pidLiveness ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  });

  /** Spawn the discuss pty for `task`, writing a fresh RO settings file per spawn.
   *  Awaits any prior teardown so a supersede sequence never overlaps two ptys. */
  async function spawnPty(rec: ConnRec, task: TaskRecord): Promise<void> {
    if (rec.priorTeardown) {
      try { await rec.priorTeardown; } catch { /* prior teardown errors are non-fatal */ }
    }
    if (rec.closed) return; // close-before-spawn race: client closed during wait
    const settingsDir = path.join(opts.settingsRoot, task.ticket);
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, 'discuss-settings.json');
    await writeFile(
      settingsPath,
      JSON.stringify(buildDiscussSettingsJson(opts.denyGuardPath), null, 2),
    );
    if (rec.closed) return; // re-check after the await (client may have closed)
    const spawner = opts.ptySpawner ?? ptySpawnReal;
    const argv = ['--continue', '--settings', settingsPath, '--permission-mode', 'dontAsk'];
    const pty = spawner('claude', argv, {
      cwd: task.worktree!,
      env: buildDiscussEnv() as NodeJS.ProcessEnv,
    });
    rec.pty = pty;
    pty.onData((s: string) => {
      if (rec.closed) return;
      rec.lastActivity = Date.now();
      try { rec.rawWs.send(Buffer.from(s, 'utf8'), { binary: true }); } catch { /* socket already closed */ }
    });
    pty.onExit(({ exitCode }) => {
      void closeRec(rec, exitCode === 0 ? 1000 : 4002, `pty exit ${exitCode ?? '?'}`);
    });
  }

  /** Per-connection heartbeat. Pings on the WS; if no pong arrives within
   *  pong_grace_seconds, close 4005. If no IO activity within idle_timeout_seconds,
   *  close 4004. Runs as a self-rescheduling setTimeout chain (no global interval). */
  function startHeartbeat(rec: ConnRec): void {
    const tick = (): void => {
      if (rec.closed) return;
      const now = Date.now();
      if (now - rec.lastPong > opts.cfg.pong_grace_seconds * 1000) {
        void closeRec(rec, 4005, 'pong timeout');
        return;
      }
      if (now - rec.lastActivity > opts.cfg.idle_timeout_seconds * 1000) {
        void closeRec(rec, 4004, 'idle');
        return;
      }
      try { rec.rawWs.ping(); } catch { /* socket likely closing */ }
      rec.hbTimer = setTimeout(tick, opts.cfg.heartbeat_seconds * 1000);
    };
    rec.hbTimer = setTimeout(tick, opts.cfg.heartbeat_seconds * 1000);
  }

  /** Idempotent close: marks rec closed, removes from conns (if it's still the
   *  current record for that ticket — supersede may have already replaced it),
   *  reaps the pty (SIGTERM then SIGKILL after pty_kill_timeout_ms), and closes
   *  the WS. Safe to call multiple times. */
  async function closeRec(rec: ConnRec, code: number, reason: string): Promise<void> {
    if (rec.closed) return;
    rec.closed = true;
    // Only delete the conns entry if WE are still the one mapped there.
    // A supersede has already swapped in the replacement — don't blow it away.
    if (conns.get(rec.ticket) === rec) conns.delete(rec.ticket);
    if (rec.hbTimer) clearTimeout(rec.hbTimer);
    if (rec.pty) {
      const pid = rec.pty.pid;
      try { rec.pty.kill('SIGTERM'); } catch { /* already exited */ }
      const killBy = Date.now() + opts.cfg.pty_kill_timeout_ms;
      while (Date.now() < killBy) {
        if (!pidLiveness(pid)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (pidLiveness(pid)) {
        try { rec.pty.kill('SIGKILL'); } catch { /* race; ignore */ }
      }
    }
    try { rec.rawWs.close(code, reason); } catch { /* already closed */ }
  }

  const lease: DiscussLease = {
    activeCount: () => conns.size,
    isDispatching: (t) => dispatching.has(t),
    releaseDispatching: (t) => { dispatching.delete(t); },
    async requireClearForDispatch(ticket) {
      dispatching.add(ticket);
      const rec = conns.get(ticket);
      if (rec) await closeRec(rec, 4003, 'task entering ⊕ phase');
    },
    async shutdown() {
      const all = [...conns.values()];
      await Promise.all(all.map((r) => closeRec(r, 1001, 'daemon shutdown')));
    },
    mountRoutes(app: Hono): void {
      if (!opts.cfg.enabled) return;

      // Pre-upgrade middleware: validate ticket + load task + check gates BEFORE
      // the WS handshake — failures return plain HTTP status codes so a browser
      // sees the 409/404/503 immediately rather than a generic ws-close.
      app.use('/tasks/:ticket/discuss', async (c, next) => {
        const ticket = c.req.param('ticket');
        try { assertSafeIssueIdentifier(ticket); }
        catch { return c.text('bad ticket', 400); }
        const t = await opts.store.get(ticket);
        if (!t) return c.text('not found', 404);
        if (!isDiscussAllowed(t)) return c.text(`discuss unavailable in ${t.phase}`, 409);
        if (t.worktree === null) return c.text('worktree missing', 404);
        try { await stat(t.worktree); }
        catch { return c.text('worktree missing', 404); }
        if (lease.isDispatching(ticket)) return c.text('task is entering ⊕ phase', 409);
        if (lease.activeCount() >= opts.cfg.max_concurrent_global) return c.text('global cap reached', 503);
        // Stash the loaded task for the upgradeWebSocket handler; using untyped
        // `set` because Hono's Variables generic would require threading a typed
        // app through createApp just for this one key.
        (c as unknown as { set(k: string, v: unknown): void }).set('discussTask', t);
        return next();
      });

      app.get('/tasks/:ticket/discuss', upgradeWebSocket((c: Context) => {
        // Pre-upgrade middleware guarantees discussTask is set + valid.
        const task = (c as unknown as { get(k: string): unknown }).get('discussTask') as TaskRecord;
        const ticket = task.ticket;
        // `createEvents` is invoked per-connection — its closure is unique to
        // THIS WS, so capturing `rec` here lets onMessage/onClose/onError act
        // on the right ConnRec even after a supersede has swapped the entry
        // in `conns.get(ticket)` to a newer record.
        let rec: ConnRec | null = null;
        return {
          onOpen(_evt, ws) {
            // @hono/node-server exposes the underlying ws.WebSocket as `raw`.
            const rawWs = (ws.raw as unknown as RawWS | undefined);
            if (!rawWs) return;
            const prior = conns.get(ticket);
            rec = {
              rawWs, pty: null, closed: false, ticket,
              lastPong: Date.now(), lastActivity: Date.now(),
              ...(prior ? { priorTeardown: closeRec(prior, 4001, 'superseded') } : {}),
            };
            conns.set(ticket, rec);
            // Pong listener tracks heartbeat liveness.
            rawWs.on('pong', () => { if (rec) rec.lastPong = Date.now(); });
            void spawnPty(rec, task);
            startHeartbeat(rec);
          },
          onMessage(evt, _ws) {
            if (!rec || rec.closed) return;
            rec.lastActivity = Date.now();
            const data = evt.data;
            if (typeof data === 'string') {
              // Control channel (JSON): {type:'resize', cols, rows}.
              try {
                const msg = JSON.parse(data) as { type?: unknown; cols?: unknown; rows?: unknown };
                if (msg && msg.type === 'resize'
                    && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
                  rec.pty?.resize(msg.cols as number, msg.rows as number);
                }
              } catch { /* malformed JSON ignored */ }
            } else if (data instanceof ArrayBuffer) {
              const buf = Buffer.from(new Uint8Array(data));
              rec.pty?.write(buf.toString('utf8'));
            } else if (Buffer.isBuffer(data)) {
              rec.pty?.write(data.toString('utf8'));
            }
          },
          onClose() {
            if (rec) void closeRec(rec, 1000, 'client close');
          },
          onError() {
            if (rec) void closeRec(rec, 1011, 'ws error');
          },
        };
      }));
    },
  };

  return lease;
}
