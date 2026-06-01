// Plan-5 Task-11 tests for createDiscussLease + WS server wiring.
// Two surfaces:
//  1. Pre-upgrade gates — exercised through Hono `app.fetch` with `Upgrade:
//     websocket` headers; the middleware short-circuits BEFORE upgradeWebSocket
//     runs, so HTTP statuses (400/401/404/409/503) are observable.
//  2. WS lifecycle — exercised through a real `@hono/node-server` + `ws` server
//     bound to 127.0.0.1:0 with an injected FakePty so we can assert pty.kill,
//     argv, env, supersede, heartbeat, idle, and dispatch-clear semantics.

import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { IPty } from 'node-pty';
import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/control-plane/web/server.js';
import { TaskStore } from '../../src/control-plane/task-store.js';
import { createDiscussLease, type DiscussTerminalCfg } from '../../src/control-plane/web/discuss-ws.js';
import { COOKIE_NAME } from '../../src/control-plane/web/auth.js';
import { nullDiscussLease } from '../../src/control-plane/discuss-lease.js';
import type { LinearReadGateway } from '../../src/control-plane/linear-read.js';

// ---------- Test seams ----------------------------------------------------

const TOKEN = 'tok';
const cookieHeader = `${COOKIE_NAME}=${TOKEN}`;
const linearReadStub: LinearReadGateway = {
  async fetchIssueByIdentifier() { return null; },
  async listComments() { return []; },
};

/** Minimal FakePty matching node-pty's IPty surface we depend on. */
class FakePty extends EventEmitter {
  static last: FakePty | null = null;
  static created: FakePty[] = [];
  static pidSeq = 90000;
  readonly pid: number;
  readonly file: string;
  readonly argv: string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  killed: string[] = [];
  written: string[] = [];
  resized: Array<[number, number]> = [];
  private dataListeners: Array<(s: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  private exited = false;

  constructor(file: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    super();
    this.pid = FakePty.pidSeq++;
    this.file = file;
    this.argv = argv;
    this.cwd = opts.cwd;
    this.env = opts.env;
  }
  onData(cb: (s: string) => void): { dispose(): void } {
    this.dataListeners.push(cb);
    return { dispose: () => { /* noop */ } };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(cb);
    return { dispose: () => { /* noop */ } };
  }
  write(data: string | Buffer): void { this.written.push(typeof data === 'string' ? data : data.toString('utf8')); }
  resize(cols: number, rows: number): void { this.resized.push([cols, rows]); }
  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGHUP');
    // FakePty marks itself dead on first kill — pidLiveness flips to false next probe.
    this.exited = true;
  }
  emitData(s: string): void { for (const cb of this.dataListeners) cb(s); }
  emitExit(exitCode: number): void {
    if (this.exited && this.exitListeners.length === 0) return;
    this.exited = true;
    for (const cb of this.exitListeners) cb({ exitCode });
  }
  get isDead(): boolean { return this.exited; }
}

function fakeSpawner(file: string, argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): IPty {
  const p = new FakePty(file, argv, opts);
  FakePty.last = p; FakePty.created.push(p);
  return p as unknown as IPty;
}

function fakeLiveness(pid: number): boolean {
  return FakePty.created.some((p) => p.pid === pid && !p.isDead);
}

const baseCfg: DiscussTerminalCfg = {
  enabled: true,
  idle_timeout_seconds: 1800,
  heartbeat_seconds: 30,
  pong_grace_seconds: 60,
  max_concurrent_global: 4,
  pty_kill_timeout_ms: 200,
};

// ---------- Filesystem fixtures ------------------------------------------

let root: string;
let store: TaskStore;
let worktreeRoot: string;

async function seedTask(ticket: string, phase: string): Promise<void> {
  const wt = path.join(worktreeRoot, ticket);
  await mkdir(wt, { recursive: true });
  await store.create({ ticket, title: `t-${ticket}`, url: '' });
  // Set worktree first (advance to prepping is the legal transition that allows
  // a mutator to write the worktree field; then walk to the requested phase).
  await store.advance(ticket, { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = wt; r.baseSha = 'b'; } });
  switch (phase) {
    case 'awaiting_approval':
      await store.advance(ticket, { expectRev: 1, to: 'awaiting_approval', mutate: (r) => { r.openQuestions = { rev: 0, items: [] }; } });
      break;
    case 'prepping':
      // already there
      break;
    case 'prep_failed':
      await store.advance(ticket, { expectRev: 1, to: 'prep_failed', mutate: (r) => { r.failedFrom = 'prepping'; } });
      break;
    default:
      throw new Error(`seedTask: unsupported phase ${phase} (extend if needed)`);
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-discuss-ws-'));
  worktreeRoot = path.join(root, 'worktrees');
  store = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => 1 });
  FakePty.last = null; FakePty.created = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// ---------- Pre-upgrade gate helpers --------------------------------------

interface BuildAppOpts {
  cfg?: Partial<DiscussTerminalCfg>;
  useNullLease?: boolean;
}

function buildAppWithLease(opts: BuildAppOpts = {}) {
  const cfg = { ...baseCfg, ...(opts.cfg ?? {}) };
  const lease = opts.useNullLease
    ? nullDiscussLease
    : createDiscussLease({
        store, cfg,
        settingsRoot: path.join(root, '_discuss-settings'),
        denyGuardPath: '/abs/path/to/discuss-deny-guard.sh',
        ptySpawner: fakeSpawner,
        pidLiveness: fakeLiveness,
      });
  const app = createApp({
    store, linearRead: linearReadStub, stateRoot: root, staticRoot: root,
    discussLease: lease, token: TOKEN,
  });
  return { app, lease, cfg };
}

function wsRequest(p: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(`http://x${p}`, {
    headers: {
      Upgrade: 'websocket',
      Connection: 'upgrade',
      cookie: cookieHeader,
      ...extraHeaders,
    },
  });
}

// ---------- Pre-upgrade gates: table-driven -------------------------------

describe('pre-upgrade gates (HTTP-status before WS handshake)', () => {
  it('feature disabled → no route mounted → 404', async () => {
    const { app } = buildAppWithLease({ cfg: { enabled: false } });
    const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
    expect(res.status).toBe(404);
  });

  it('missing cookie → 401 (auth middleware fires first)', async () => {
    const { app } = buildAppWithLease();
    const res = await app.fetch(new Request('http://x/tasks/PIN-1/discuss', {
      headers: { Upgrade: 'websocket', Connection: 'upgrade' },
    }));
    expect(res.status).toBe(401);
  });

  it('bad ticket (lowercase/punctuation) → 400', async () => {
    const { app } = buildAppWithLease();
    for (const bad of ['foo', 'PIN-1!', 'PIN_no_digits', '-1', '../etc']) {
      const res = await app.fetch(wsRequest(`/tasks/${encodeURIComponent(bad)}/discuss`));
      expect(res.status).toBe(400);
    }
  });

  it('unknown ticket → 404', async () => {
    const { app } = buildAppWithLease();
    const res = await app.fetch(wsRequest('/tasks/PIN-99/discuss'));
    expect(res.status).toBe(404);
  });

  it('disallowed phase (prepping) → 409', async () => {
    await seedTask('PIN-1', 'prepping');
    const { app } = buildAppWithLease();
    const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('prepping');
  });

  it('worktree missing on disk → 404', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    // Remove the worktree directory after seeding so stat() fails.
    const t = (await store.get('PIN-1'))!;
    await rm(t.worktree!, { recursive: true, force: true });
    const { app } = buildAppWithLease();
    const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('worktree');
  });

  it('isDispatching=true → 409', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    const { app, lease } = buildAppWithLease();
    await lease.requireClearForDispatch('PIN-1');
    const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
    expect(res.status).toBe(409);
  });

  it('global cap reached (activeCount fakery) → 503', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    // Override activeCount via a fresh lease whose method we monkey-patch.
    const cfg = { ...baseCfg };
    const lease = createDiscussLease({
      store, cfg,
      settingsRoot: path.join(root, '_d'),
      denyGuardPath: '/abs/x.sh',
      ptySpawner: fakeSpawner, pidLiveness: fakeLiveness,
    });
    lease.activeCount = () => cfg.max_concurrent_global; // saturate
    const app = createApp({
      store, linearRead: linearReadStub, stateRoot: root, staticRoot: root,
      discussLease: lease, token: TOKEN,
    });
    const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
    expect(res.status).toBe(503);
  });

  it('happy path reaches upgradeWebSocket (no waiter env in fetch → 500)', async () => {
    // app.fetch() can't complete a real WS handshake (no upgrade waiter is set
    // by the node adapter), so when all middleware passes we land in
    // upgradeWebSocket which throws on the missing WAIT_FOR_WEBSOCKET_SYMBOL —
    // Hono catches → 500. This proves the middleware DIDN'T short-circuit on
    // a happy-path task. The thrown TypeError is suppressed with a console
    // spy so the test log isn't noisy.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await seedTask('PIN-1', 'awaiting_approval');
      const { app } = buildAppWithLease();
      const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
      expect(res.status).toBe(500);
    } finally { errSpy.mockRestore(); }
  });
});

// ---------- WS lifecycle helpers (real server on 127.0.0.1:0) --------------

interface EphemeralServer {
  port: number;
  server: ServerType;
  wss: WebSocketServer;
  lease: ReturnType<typeof createDiscussLease>;
  close: () => Promise<void>;
}

async function bootEphemeral(cfgOverride: Partial<DiscussTerminalCfg> = {}): Promise<EphemeralServer> {
  const cfg = { ...baseCfg, ...cfgOverride };
  const lease = createDiscussLease({
    store, cfg,
    settingsRoot: path.join(root, '_discuss-settings'),
    denyGuardPath: '/abs/path/to/discuss-deny-guard.sh',
    ptySpawner: fakeSpawner, pidLiveness: fakeLiveness,
  });
  const app = createApp({
    store, linearRead: linearReadStub, stateRoot: root, staticRoot: root,
    discussLease: lease, token: TOKEN,
  });
  const wss = new WebSocketServer({ noServer: true });
  // serve() returns the underlying Node server.
  const server = serve({
    fetch: app.fetch,
    hostname: '127.0.0.1',
    port: 0,
    websocket: { server: wss },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port, server, wss, lease,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

function openWs(port: number, ticket: string, opts: { autoPong?: boolean } = {}): WsClient {
  return new WsClient(`ws://127.0.0.1:${port}/tasks/${ticket}/discuss`, {
    headers: { cookie: cookieHeader },
    autoPong: opts.autoPong ?? true,
  });
}

/** Wait for ws to reach OPEN; reject on close/error first. */
function awaitOpen(ws: WsClient): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WsClient.OPEN) return resolve();
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('close', (code, reason) => reject(new Error(`closed ${code} ${reason.toString()}`)));
  });
}

function awaitCloseCode(ws: WsClient): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

/** Spin until predicate holds or timeout. */
async function waitFor(pred: () => boolean, timeoutMs: number, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (!pred()) throw new Error('waitFor timed out');
}

// ---------- WS lifecycle: spawn semantics + IO ----------------------------

describe('WS lifecycle (real server + FakePty)', () => {
  let env: EphemeralServer;
  afterEach(async () => { if (env) await env.close(); });

  it('upgrade succeeds + pty spawned with correct argv/cwd/env (env keys exactly PATH,HOME,TERM,LANG,LC_ALL)', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    await waitFor(() => FakePty.last !== null, 1000);
    const fp = FakePty.last!;
    expect(fp.file).toBe('claude');
    // The worktree for PIN-1 in this test has no prior session on disk under
    // ~/.claude/projects/<encoded>/, so findLatestSessionId returns null and
    // the spawn skips --resume. The argv is just settings + permission-mode.
    expect(fp.argv[0]).toBe('--settings');
    expect(fp.argv[2]).toBe('--permission-mode');
    expect(fp.argv[3]).toBe('dontAsk');
    // Settings file path lives under the configured settingsRoot.
    expect(fp.argv[1]).toContain(path.join(root, '_discuss-settings', 'PIN-1'));
    expect(fp.cwd).toBe(path.join(worktreeRoot, 'PIN-1'));
    const envKeys = Object.keys(fp.env).sort();
    expect(envKeys.every((k) => ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL'].includes(k))).toBe(true);
    // Settings file was actually written.
    await expect(stat(fp.argv[1]!)).resolves.toBeTruthy();
    ws.close();
    await awaitCloseCode(ws);
  });

  it('binary frame from client → pty.write(decoded utf-8)', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    await waitFor(() => FakePty.last !== null, 1000);
    ws.send(Buffer.from('hello\n', 'utf8'));
    await waitFor(() => FakePty.last!.written.length > 0, 500);
    expect(FakePty.last!.written).toEqual(['hello\n']);
    ws.close();
    await awaitCloseCode(ws);
  });

  it('text {"type":"resize"} → pty.resize(cols, rows)', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    await waitFor(() => FakePty.last !== null, 1000);
    ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    await waitFor(() => FakePty.last!.resized.length > 0, 500);
    expect(FakePty.last!.resized).toEqual([[80, 24]]);
    ws.close();
    await awaitCloseCode(ws);
  });

  it('pty.onData → forwarded to WS as binary frame', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    await waitFor(() => FakePty.last !== null, 1000);
    const received: Buffer[] = [];
    ws.on('message', (data) => { received.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)); });
    FakePty.last!.emitData('hi from pty');
    await waitFor(() => received.length > 0, 500);
    expect(received[0]!.toString('utf8')).toBe('hi from pty');
    ws.close();
    await awaitCloseCode(ws);
  });

  it('client closes → pty.kill("SIGTERM") within pty_kill_timeout_ms', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    await waitFor(() => FakePty.last !== null, 1000);
    const fp = FakePty.last!;
    ws.close();
    await awaitCloseCode(ws);
    await waitFor(() => fp.killed.includes('SIGTERM'), 500);
    expect(fp.killed).toContain('SIGTERM');
  });

  it('pty exitCode=1 → WS closes with code 4002', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    await waitFor(() => FakePty.last !== null, 1000);
    FakePty.last!.emitExit(1);
    const { code } = await awaitCloseCode(ws);
    expect(code).toBe(4002);
  });

  it('two tickets simultaneously → activeCount=2, both alive', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    await seedTask('PIN-2', 'awaiting_approval');
    env = await bootEphemeral();
    const wsA = openWs(env.port, 'PIN-1');
    const wsB = openWs(env.port, 'PIN-2');
    await Promise.all([awaitOpen(wsA), awaitOpen(wsB)]);
    // spawnPty runs async after conns.set — wait for BOTH ptys to be created.
    await waitFor(() => FakePty.created.length === 2, 2000);
    expect(env.lease.activeCount()).toBe(2);
    expect(FakePty.created).toHaveLength(2);
    wsA.close(); wsB.close();
    await Promise.all([awaitCloseCode(wsA), awaitCloseCode(wsB)]);
  });

  it('second WS for same ticket → first closes 4001 superseded; activeCount stays 1', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws1 = openWs(env.port, 'PIN-1');
    await awaitOpen(ws1);
    await waitFor(() => FakePty.created.length === 1, 2000);
    const close1 = awaitCloseCode(ws1);
    const ws2 = openWs(env.port, 'PIN-1');
    await awaitOpen(ws2);
    const { code, reason } = await close1;
    expect(code).toBe(4001);
    expect(reason).toContain('superseded');
    // Wait for the supersede's pty to be created (proves onOpen ran for ws2 +
    // priorTeardown resolved). Then activeCount must be 1 (the new rec).
    await waitFor(() => FakePty.created.length === 2, 3000);
    await waitFor(() => env.lease.activeCount() === 1, 3000);
    expect(env.lease.activeCount()).toBe(1);
    ws2.close();
    await awaitCloseCode(ws2);
  });

  it('idle timeout (no IO, but pong replies) → WS close 4004', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    // Tight cfg: 0.3s idle, 2s heartbeat (heartbeat NOT fired in time), 30s pong grace.
    // Actually we need heartbeat fast enough to fire the check; set heartbeat=0.1s, idle=0.3s, pong_grace=10s.
    env = await bootEphemeral({ heartbeat_seconds: 0.1 as unknown as number, idle_timeout_seconds: 0.3 as unknown as number, pong_grace_seconds: 10 });
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    // The browser-equivalent ws client auto-replies to pings.
    const { code } = await awaitCloseCode(ws);
    expect(code).toBe(4004);
  });

  it('pong-timeout (no pong response) → WS close 4005', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral({ heartbeat_seconds: 0.05 as unknown as number, idle_timeout_seconds: 60, pong_grace_seconds: 0.2 as unknown as number });
    // ws@8 client autoPong=true by default; pass autoPong=false so server pings
    // never get answered — heartbeat tick must close with 4005 after pong_grace.
    const ws = openWs(env.port, 'PIN-1', { autoPong: false });
    await awaitOpen(ws);
    const { code } = await awaitCloseCode(ws);
    expect(code).toBe(4005);
  });
});

// ---------- Lease integration: dispatch race + shutdown -------------------

describe('lease integration (dispatch race + shutdown)', () => {
  let env: EphemeralServer;
  afterEach(async () => { if (env) await env.close(); });

  it('requireClearForDispatch closes the live WS with code 4003; isDispatching=true', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    const ws = openWs(env.port, 'PIN-1');
    await awaitOpen(ws);
    await waitFor(() => FakePty.last !== null, 1000);
    const closed = awaitCloseCode(ws);
    await env.lease.requireClearForDispatch('PIN-1');
    expect(env.lease.isDispatching('PIN-1')).toBe(true);
    const { code, reason } = await closed;
    expect(code).toBe(4003);
    expect(reason).toContain('⊕');
    expect(FakePty.last!.killed).toContain('SIGTERM');
  });

  it('releaseDispatching flips the flag back', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    env = await bootEphemeral();
    await env.lease.requireClearForDispatch('PIN-1');
    expect(env.lease.isDispatching('PIN-1')).toBe(true);
    env.lease.releaseDispatching('PIN-1');
    expect(env.lease.isDispatching('PIN-1')).toBe(false);
  });

  it('requireClearForDispatch(PIN-1) does NOT touch PIN-2 WS', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    await seedTask('PIN-2', 'awaiting_approval');
    env = await bootEphemeral();
    const wsA = openWs(env.port, 'PIN-1');
    const wsB = openWs(env.port, 'PIN-2');
    await Promise.all([awaitOpen(wsA), awaitOpen(wsB)]);
    await env.lease.requireClearForDispatch('PIN-1');
    // PIN-1 closed, PIN-2 still open.
    expect(env.lease.isDispatching('PIN-1')).toBe(true);
    expect(env.lease.isDispatching('PIN-2')).toBe(false);
    expect(wsB.readyState).toBe(WsClient.OPEN);
    wsB.close();
    await awaitCloseCode(wsB);
  });

  it('shutdown closes all WS with 1001 and kills all ptys', async () => {
    await seedTask('PIN-1', 'awaiting_approval');
    await seedTask('PIN-2', 'awaiting_approval');
    env = await bootEphemeral();
    const wsA = openWs(env.port, 'PIN-1');
    const wsB = openWs(env.port, 'PIN-2');
    await Promise.all([awaitOpen(wsA), awaitOpen(wsB)]);
    await waitFor(() => env.lease.activeCount() === 2, 1000);
    const closes = Promise.all([awaitCloseCode(wsA), awaitCloseCode(wsB)]);
    await env.lease.shutdown();
    const results = await closes;
    for (const r of results) expect(r.code).toBe(1001);
    expect(env.lease.activeCount()).toBe(0);
    for (const fp of FakePty.created) expect(fp.killed).toContain('SIGTERM');
  });
});

// ---------- Phase coverage of pre-upgrade gate ----------------------------

describe('pre-upgrade gate per allowed phase', () => {
  it('failed phase with retryRequested=true → 409', async () => {
    await seedTask('PIN-1', 'prep_failed');
    await store.updateRun('PIN-1', 2, (r) => { r.retryRequested = true; });
    const { app } = buildAppWithLease();
    const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
    expect(res.status).toBe(409);
  });

  it('failed phase without retryRequested → passes gate (500 from upgrade wrapper)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await seedTask('PIN-1', 'prep_failed');
      const { app } = buildAppWithLease();
      const res = await app.fetch(wsRequest('/tasks/PIN-1/discuss'));
      expect(res.status).toBe(500);
    } finally { errSpy.mockRestore(); }
  });
});
