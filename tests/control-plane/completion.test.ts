import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
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
});
