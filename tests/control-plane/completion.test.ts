import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { ProcessManager } from '../../src/control-plane/process-manager.js';
import { processStartTime } from '../../src/control-plane/proc.js';

let root: string;
let dir: string;
let pm: ProcessManager;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-comp-'));
  dir = path.join(root, 'PIN-1');
  await mkdir(dir, { recursive: true });
  pm = new ProcessManager({ stateRoot: root, model: 'opus', readTokenEnv: 'LINEAR_READ_TOKEN', extraEnv: [], ownerGen: 'gen-1' });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('captureSessionId', () => {
  it('reads session_id from the first system/init event in a stream-json log', async () => {
    const log = path.join(dir, 'agent.jsonl');
    await writeFile(
      log,
      [
        JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-abc' }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      ].join('\n'),
      'utf8',
    );
    expect(await pm.captureSessionId(log)).toBe('sess-abc');
  });

  it('returns null when no init event is present (NO-SESSION fallback signal)', async () => {
    const log = path.join(dir, 'agent.jsonl');
    await writeFile(log, JSON.stringify({ type: 'assistant', message: {} }), 'utf8');
    expect(await pm.captureSessionId(log)).toBeNull();
  });
});

describe('detectCompletion', () => {
  it('reports completed with the exit code when exit.json is present', async () => {
    await writeFile(
      path.join(dir, 'r1.exit.json'),
      JSON.stringify({ runId: 'r1', attemptId: 1, kind: 'execute', exitCode: 0, finishedAt: 5 }),
      'utf8',
    );
    const res = await pm.detectCompletion({
      stateDir: dir, runId: 'r1', kind: 'execute', logRel: 'agent.jsonl',
      pid: 2_000_000_000, pidStart: 'x', spawnedAt: 0, graceSeconds: 30, now: 100,
    });
    expect(res).toEqual({ status: 'completed', exitCode: 0 });
  });

  it('reports running when the pid is alive (matching start-time) and no exit.json yet', async () => {
    const child = spawn('sh', ['-c', 'sleep 5'], { stdio: 'ignore' });
    try {
      const pidStart = await processStartTime(child.pid!);
      const res = await pm.detectCompletion({
        stateDir: dir, runId: 'rlive', kind: 'prep', logRel: 'prep.jsonl',
        pid: child.pid!, pidStart, spawnedAt: 0, graceSeconds: 30, now: 100,
      });
      expect(res.status).toBe('running');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('reports unknown within the grace window when process gone + no exit.json', async () => {
    const res = await pm.detectCompletion({
      stateDir: dir, runId: 'r3', kind: 'prep', logRel: 'prep.jsonl',
      pid: 2_000_000_000, pidStart: 'x', spawnedAt: 100, graceSeconds: 30, now: 110,
    });
    expect(res.status).toBe('unknown');
  });

  it('after grace with no exit.json, uses completion-evidence (kind artifact) to decide', async () => {
    await writeFile(path.join(dir, 'open-questions.json'), '{"rev":1,"items":[]}', 'utf8');
    const res = await pm.detectCompletion({
      stateDir: dir, runId: 'r4', kind: 'prep', logRel: 'prep.jsonl',
      pid: 2_000_000_000, pidStart: 'x', spawnedAt: 0, graceSeconds: 30, now: 100,
    });
    expect(res.status).toBe('completed-no-exitcode');
  });

  it('after grace with no exit.json and no evidence, reports crashed', async () => {
    const res = await pm.detectCompletion({
      stateDir: dir, runId: 'r5', kind: 'closeout', logRel: 'closeout.jsonl',
      pid: 2_000_000_000, pidStart: 'x', spawnedAt: 0, graceSeconds: 30, now: 100,
    });
    expect(res.status).toBe('crashed');
  });

  it('rejects a stale artifact (mtime < spawnedAt) → crashed', async () => {
    const spawnedAt = Math.floor(Date.now() / 1000);
    const file = path.join(dir, 'open-questions.json');
    await writeFile(file, '{"rev":1,"items":[]}', 'utf8');
    const pastDate = new Date((spawnedAt - 100) * 1000);
    await utimes(file, pastDate, pastDate);
    const res = await pm.detectCompletion({
      stateDir: dir, runId: 'rstale', kind: 'prep', logRel: 'prep.jsonl',
      pid: 2_000_000_000, pidStart: 'x', spawnedAt, graceSeconds: 30, now: spawnedAt + 100,
    });
    expect(res.status).toBe('crashed');
  });

  it('uses hasResultEvent (fresh log result event) → completed-no-exitcode', async () => {
    await writeFile(
      path.join(dir, 'agent.jsonl'),
      [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
        JSON.stringify({ type: 'result' }),
      ].join('\n'),
      'utf8',
    );
    const res = await pm.detectCompletion({
      stateDir: dir, runId: 'rresult', kind: 'execute', logRel: 'agent.jsonl',
      pid: 2_000_000_000, pidStart: 'x', spawnedAt: 0, graceSeconds: 30, now: 100,
    });
    expect(res.status).toBe('completed-no-exitcode');
  });

  it('does NOT use a stale log (mtime < spawnedAt) as evidence → crashed', async () => {
    const spawnedAt = Math.floor(Date.now() / 1000);
    const log = path.join(dir, 'agent.jsonl');
    await writeFile(log, JSON.stringify({ type: 'result' }), 'utf8');
    const pastDate = new Date((spawnedAt - 100) * 1000);
    await utimes(log, pastDate, pastDate);
    const res = await pm.detectCompletion({
      stateDir: dir, runId: 'rstalelog', kind: 'closeout', logRel: 'agent.jsonl',
      pid: 2_000_000_000, pidStart: 'x', spawnedAt, graceSeconds: 30, now: spawnedAt + 100,
    });
    expect(res.status).toBe('crashed');
  });

  it('recovers liveness from the pid file when pid/pidStart are null', async () => {
    const child = spawn('sh', ['-c', 'sleep 5'], { stdio: 'ignore' });
    try {
      const token = await processStartTime(child.pid!);
      await writeFile(path.join(dir, 'rpidfile.pid'), `${child.pid} ${token}`, 'utf8');
      const res = await pm.detectCompletion({
        stateDir: dir, runId: 'rpidfile', kind: 'prep', logRel: 'prep.jsonl',
        pid: null, pidStart: null, spawnedAt: 0, graceSeconds: 30, now: 100,
      });
      expect(res.status).toBe('running');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('logRelForKind + abort', () => {
  it('maps each kind to its log filename, defaulting to run.jsonl', () => {
    expect(pm.logRelForKind('prep')).toBe('prep.jsonl');
    expect(pm.logRelForKind('execute')).toBe('agent.jsonl');
    expect(pm.logRelForKind('review')).toBe('review.jsonl');
    expect(pm.logRelForKind('gapfix')).toBe('gapfix.jsonl');
    expect(pm.logRelForKind('closeout')).toBe('closeout.jsonl');
    expect(pm.logRelForKind('preview')).toBe('preview.log');
    expect(pm.logRelForKind('teardown')).toBe('teardown.log');
  });

  it('abort resolves without throwing for a non-existent group', async () => {
    await expect(pm.abort(2_000_000_000)).resolves.toBeUndefined();
  });
});
