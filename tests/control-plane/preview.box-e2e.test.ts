// tests/control-plane/preview.box-e2e.test.ts
// Box-only: SYMPHONY_BOX_E2E=1 on the Mac box (docker/colima + ~/symphony-preview scripts).
// Drives the real Engine: ensureRunning dispatches preview-up via the wrapper, routeExit
// routes the synchronous exit to `ready` (loading task.preview), then an approve advances
// to tearing_down, ensureRunning dispatches preview-down, routeExit advances to `done`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { Engine, type Dispatcher } from '../../src/control-plane/engine.js';
import { SlotCounter } from '../../src/control-plane/slots.js';
import { TaskStore } from '../../src/control-plane/task-store.js';
import { ProcessManager } from '../../src/control-plane/process-manager.js';
import { canPreview, readPreviewOutcome, loadStage9 } from '../../src/control-plane/daemon.js';
import { taskDir, type TaskRecord } from '../../src/control-plane/task-record.js';

const BOX = process.env.SYMPHONY_BOX_E2E === '1';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('preview lifecycle via the Engine (box-only)', () => {
  (BOX ? it : it.skip)('closeout-state → preview-up → ready → approve → teardown → done', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cp-box-'));
    const upScript = process.env.SYMPHONY_PREVIEW_UP ?? `${process.env.HOME}/symphony-preview/preview-up.sh`;
    const downScript = process.env.SYMPHONY_PREVIEW_DOWN ?? `${process.env.HOME}/symphony-preview/preview-down-compute.sh`;
    const worktree = process.env.SYMPHONY_BOX_WORKTREE!; // committed, buildable
    expect(worktree).toBeTruthy();

    const ownerGen = 'box-gen';
    const pm = new ProcessManager({ stateRoot: root, model: 'opus', readTokenEnv: 'LINEAR_READ_TOKEN', extraEnv: [], ownerGen });
    const store = new TaskStore({ stateRoot: root, ownerGen });

    // A dispatcher mirroring daemon.dispatchForKind's preview/teardown branch. It
    // omits forceDownAgentStack (a synthetic worktree has no agent stack to kill) —
    // that path is box-validated separately; here we exercise the happy lifecycle.
    const dispatcher: Dispatcher = {
      async dispatch(args) {
        const task = (await store.get(args.ticket))!;
        const env = pm.buildScriptEnv(['DOCKER_HOST']);
        if (args.kind === 'preview') {
          await pm.dispatchAgent({ store, ticket: args.ticket, expectRev: args.expectRev, kind: 'preview', logRel: pm.logRelForKind('preview'), command: [upScript, args.ticket, task.worktree!], cwd: task.worktree!, env, to: args.to });
        } else if (args.kind === 'teardown') {
          await pm.dispatchAgent({ store, ticket: args.ticket, expectRev: args.expectRev, kind: 'teardown', logRel: pm.logRelForKind('teardown'), command: [downScript, args.ticket], cwd: task.worktree ?? root, env, to: args.to });
        } else {
          throw new Error(`box-e2e dispatcher: unexpected kind ${args.kind}`);
        }
      },
    };

    const probeExit = async (task: TaskRecord): Promise<{ ok: boolean } | null> => {
      const run = task.currentRun;
      if (!run) return { ok: true };
      const res = await pm.detectCompletion({
        stateDir: taskDir(root, task.ticket), runId: run.runId, kind: run.kind, logRel: run.log,
        pid: run.pid, pidStart: run.pidStart, spawnedAt: run.spawnedAt, graceSeconds: 30,
        now: Math.floor(Date.now() / 1000),
      });
      if (res.status === 'running' || res.status === 'unknown') return null;
      if (res.status === 'completed') return { ok: res.exitCode === 0 };
      if (res.status === 'completed-no-exitcode') return { ok: true };
      return { ok: false };
    };

    const engine = new Engine({
      store, slots: new SlotCounter(2), dispatcher, reviewHasGaps: async () => false,
      stateRoot: root, ownerGen, probeExit, canPreview,
      readPreviewOutcome: (t) => readPreviewOutcome(t, root),
      loadStage9: (t) => loadStage9(t, root),
    });

    // Seed a task directly into `previewing` (post-closeout shape); the synthetic
    // worktree stands in for a finished execute/closeout.
    await store.create({ ticket: 'PIN-1', title: 'box', url: 'u' });
    await store.advance('PIN-1', { expectRev: 0, to: 'prepping', mutate: (r) => { r.worktree = worktree; r.baseSha = 'base-unused'; } });
    for (const to of ['awaiting_approval', 'approved', 'executing'] as const) {
      await store.advance('PIN-1', { expectRev: (await store.get('PIN-1'))!.rev, to });
    }
    for (const to of ['reviewing', 'closing', 'previewing'] as const) {
      await store.advance('PIN-1', { expectRev: (await store.get('PIN-1'))!.rev, to, mutate: (r) => { r.currentRun = null; } });
    }

    // Tick until preview-up completes and routes to ready (synchronous script ~minutes).
    for (let i = 0; i < 600 && (await store.get('PIN-1'))!.phase === 'previewing'; i++) {
      await engine.tick();
      await sleep(1000);
    }
    const ready = (await store.get('PIN-1'))!;
    expect(ready.phase).toBe('ready');
    expect(ready.preview!.state).toBe('up');
    expect(ready.preview!.url.startsWith('https://')).toBe(true);

    // Operator approve-preview (the web mutation): ready → tearing_down(done).
    await store.advance('PIN-1', { expectRev: ready.rev, to: 'tearing_down', mutate: (r) => { r.teardownTarget = 'done'; r.terminalReason = 'approved'; } });

    // Tick until teardown completes and routes to done.
    for (let i = 0; i < 120 && (await store.get('PIN-1'))!.phase === 'tearing_down'; i++) {
      await engine.tick();
      await sleep(1000);
    }
    const done = (await store.get('PIN-1'))!;
    expect(done.phase).toBe('done');
    expect(done.terminalReason).toBe('approved');
    expect(done.preview).toBeNull(); // compute reclaimed

    await rm(root, { recursive: true, force: true });
  }, 700_000);
});
