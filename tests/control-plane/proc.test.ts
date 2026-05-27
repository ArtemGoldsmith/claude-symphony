// tests/control-plane/proc.test.ts
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  spawnWrapper,
  processStartTime,
  isProcessAlive,
  readPidFile,
  readExitJson,
  killGroup,
} from '../../src/control-plane/proc.js';

let sd: string;
beforeEach(async () => {
  sd = await mkdtemp(path.join(tmpdir(), 'cp-proc-'));
});
afterEach(async () => {
  await rm(sd, { recursive: true, force: true });
});

// Poll a predicate until true or timeout — the wrapper writes exit.json async.
async function until(fn: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('proc primitives', () => {
  it('spawnWrapper runs the argv command and writes pid + atomic exit.json', async () => {
    const child = spawnWrapper({
      stateDir: sd,
      runId: 'r1',
      kind: 'execute',
      attemptId: 2,
      logRel: 'agent.jsonl',
      command: ['sh', '-c', 'echo hello; exit 7'],
      cwd: sd,
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(typeof child.pid).toBe('number');

    await until(async () => (await readExitJson(sd, 'r1')) !== null);
    const exit = await readExitJson(sd, 'r1');
    expect(exit).toMatchObject({ runId: 'r1', attemptId: 2, kind: 'execute', exitCode: 7 });
    expect(typeof exit!.finishedAt).toBe('number');

    // pid file: "<pgid> <start-token>"
    const pidRec = await readPidFile(sd, 'r1');
    expect(pidRec).not.toBeNull();
    expect(pidRec!.pid).toBeGreaterThan(0);
    expect(pidRec!.pidStart.length).toBeGreaterThan(0);

    // log captured
    const log = await readFile(path.join(sd, 'agent.jsonl'), 'utf8');
    expect(log).toContain('hello');
  });

  it('readExitJson returns null when absent and ignores a half-written tmp file', async () => {
    expect(await readExitJson(sd, 'missing')).toBeNull();
    await writeFile(path.join(sd, 'r2.exit.json.tmp.123'), '{ partial', 'utf8');
    expect(await readExitJson(sd, 'r2')).toBeNull(); // only the final file counts
  });

  it('isProcessAlive is true for self with the matching start-time and false for a bogus token', async () => {
    const myStart = await processStartTime(process.pid);
    expect(myStart).not.toBeNull();
    expect(await isProcessAlive(process.pid, myStart!)).toBe(true);
    // a non-matching start token => treat as a different (reused) pid => not alive
    expect(await isProcessAlive(process.pid, 'Thu Jan  1 00:00:00 2000')).toBe(false);
    // a pid that cannot exist
    expect(await isProcessAlive(2_000_000_000, myStart!)).toBe(false);
  });

  describe('killGroup', () => {
    it('does not throw when the PGID does not exist', async () => {
      await expect(killGroup(2_000_000_000)).resolves.toBeUndefined();
    });

    it(
      'kills a real process group and isProcessAlive becomes false',
      async () => {
        const child = spawnWrapper({
          stateDir: sd,
          runId: 'kg1',
          kind: 'execute',
          attemptId: 1,
          logRel: 'agent.jsonl',
          command: ['sh', '-c', 'sleep 30'],
          cwd: sd,
          env: { PATH: process.env.PATH ?? '' },
        });
        expect(typeof child.pid).toBe('number');

        // Wait until the wrapper has written its pid file.
        await until(async () => (await readPidFile(sd, 'kg1')) !== null, 8000);
        const pidRec = await readPidFile(sd, 'kg1');
        expect(pidRec).not.toBeNull();
        const { pid, pidStart } = pidRec!;

        await killGroup(pid);

        // The group should die quickly; poll until liveness check confirms it.
        await until(async () => !(await isProcessAlive(pid, pidStart)), 8000);
        expect(await isProcessAlive(pid, pidStart)).toBe(false);
      },
      20_000,
    );
  });
});
