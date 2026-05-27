import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { TaskStore } from '../../src/control-plane/task-store.js';
import { ProcessManager } from '../../src/control-plane/process-manager.js';

let root: string;
let store: TaskStore;
let now: number;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-pm-'));
  now = 1000;
  store = new TaskStore({ stateRoot: root, ownerGen: 'gen-1', now: () => now });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ProcessManager.buildAgentEnv', () => {
  it('passes only the allowlist + read-token, never the daemon bearer/push secrets', () => {
    const pm = new ProcessManager({
      stateRoot: root,
      model: 'opus',
      readTokenEnv: 'LINEAR_READ_TOKEN',
      extraEnv: ['DOCKER_HOST'],
      ownerGen: 'gen-1',
    });
    const env = pm.buildAgentEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      LINEAR_READ_TOKEN: 'lr_secret',
      DOCKER_HOST: 'unix:///x.sock',
      SYMPHONY_BOARD_TOKEN: 'bearer_secret', // must NOT leak
      GIT_PUSH_TOKEN: 'push_secret', // must NOT leak
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.LINEAR_READ_TOKEN).toBe('lr_secret');
    expect(env.DOCKER_HOST).toBe('unix:///x.sock');
    expect(env.SYMPHONY_BOARD_TOKEN).toBeUndefined();
    expect(env.GIT_PUSH_TOKEN).toBeUndefined();
  });
});

describe('ProcessManager.buildAgentArgv', () => {
  it('builds the claude -p argv with --settings and stream-json, adding --resume for gapfix', () => {
    const pm = new ProcessManager({ stateRoot: root, model: 'opus', readTokenEnv: 'LINEAR_READ_TOKEN', extraEnv: [], ownerGen: 'gen-1' });
    const base = pm.buildAgentArgv({ prompt: 'PROMPT', settingsPath: '/wt/.claude/settings.json' });
    expect(base.slice(0, 3)).toEqual(['claude', '-p', 'PROMPT']);
    expect(base).toContain('--settings');
    expect(base).toContain('/wt/.claude/settings.json');
    expect(base).toContain('--output-format');
    expect(base).toContain('stream-json');
    expect(base).toContain('bypassPermissions');
    expect(base.includes('--resume')).toBe(false);

    const resumed = pm.buildAgentArgv({ prompt: 'P', settingsPath: '/s', resumeSessionId: 'sess-9' });
    const i = resumed.indexOf('--resume');
    expect(i).toBeGreaterThan(0);
    expect(resumed[i + 1]).toBe('sess-9');
  });
});

describe('ProcessManager.dispatchAgent', () => {
  it('persists currentRun (kind/pid/spawnedAt) before spawn and the run completes', async () => {
    await store.create({ ticket: 'PIN-1', title: 'T', url: 'u' });
    await store.advance('PIN-1', { expectRev: 0, to: 'prepping' });

    const pm = new ProcessManager({ stateRoot: root, model: 'opus', readTokenEnv: 'LINEAR_READ_TOKEN', extraEnv: [], ownerGen: 'gen-1' });
    const rec = await pm.dispatchAgent({
      store,
      ticket: 'PIN-1',
      expectRev: 1, // currently prepping at rev 1
      kind: 'prep',
      logRel: 'agent.jsonl',
      command: ['sh', '-c', 'echo seeded > /dev/null; exit 0'],
      cwd: root,
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(rec.currentRun).not.toBeNull();
    expect(rec.currentRun!.kind).toBe('prep');
    expect(rec.currentRun!.pid).toBeGreaterThan(0);
    expect(rec.currentRun!.log).toBe('agent.jsonl');
    expect(rec.currentRun!.ownerGen).toBe('gen-1');

    const runId = rec.currentRun!.runId;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        await readFile(path.join(root, 'PIN-1', `${runId}.exit.json`), 'utf8');
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('exit.json never appeared');
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  });
});
