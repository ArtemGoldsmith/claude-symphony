// src/control-plane/process-manager.ts
// Spec §6: the claude -p process manager. CLAIM the run in task.json BEFORE spawn
// (so a crash right after spawn is reconcilable), then spawn the detached wrapper,
// then backfill pid/pidStart; kill the group if backfill fails (no orphan).
// Completion detection + session capture + abort are added in Task 7.

import { randomUUID } from 'node:crypto';

import { spawnWrapper, processStartTime, killGroup, type SpawnWrapperArgs } from './proc.js';
import { taskDir, type RunRecord, type TaskRecord } from './task-record.js';
import type { TaskStore } from './task-store.js';

/** Env var names always forwarded to a spawned agent (no secrets). */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SHELL', 'TERM',
];

export interface ProcessManagerOptions {
  stateRoot: string;
  model: string;
  /** Env var NAME holding the read-scoped Linear token. */
  readTokenEnv: string;
  /** Extra env var NAMES to forward. */
  extraEnv: readonly string[];
  /** This daemon generation's id — stamped onto every run it spawns. */
  ownerGen: string;
}

export interface DispatchAgentArgs {
  store: TaskStore;
  ticket: string;
  expectRev: number;
  kind: RunRecord['kind'];
  logRel: string;
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Optional phase to advance into as part of this dispatch (else stay). */
  to?: TaskRecord['phase'];
}

export class ProcessManager {
  constructor(private readonly opts: ProcessManagerOptions) {}

  /** Minimal env: allowlist + read-token + configured extras; nothing else. */
  buildAgentEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = {};
    const keep = new Set<string>([...ENV_ALLOWLIST, this.opts.readTokenEnv, ...this.opts.extraEnv]);
    for (const key of keep) {
      const v = source[key];
      if (typeof v === 'string') out[key] = v;
    }
    return out;
  }

  /** Build the `claude -p` argv. Adds --resume when given a session. */
  buildAgentArgv(args: { prompt: string; settingsPath: string; resumeSessionId?: string }): string[] {
    const argv = ['claude', '-p', args.prompt];
    if (args.resumeSessionId) argv.push('--resume', args.resumeSessionId);
    argv.push(
      '--model', this.opts.model,
      '--permission-mode', 'bypassPermissions',
      '--settings', args.settingsPath,
      '--output-format', 'stream-json',
      '--verbose',
    );
    return argv;
  }

  /**
   * Dispatch with the §6 invariant "a spawned process is always reconcilable":
   * (1) CLAIM (pid null) under the per-task queue + rev CAS; (2) spawn the
   * detached wrapper; (3) backfill pid/pidStart, killing the group if that CAS
   * fails (no orphan). A failed CLAIM (stale rev) never spawns.
   */
  async dispatchAgent(args: DispatchAgentArgs): Promise<TaskRecord> {
    const runId = randomUUID();
    const live = await args.store.get(args.ticket);
    if (!live) throw new Error(`dispatchAgent: unknown task ${args.ticket}`);
    const attemptId = (args.kind === 'prep' ? live.attempts.prep : live.attempts.execute) + 1;
    const spawnedAt = Math.floor(Date.now() / 1000);
    const dir = taskDir(this.opts.stateRoot, args.ticket);

    const claimed: RunRecord = {
      runId, attemptId, kind: args.kind, pid: null, pidStart: null,
      spawnedAt, sessionId: null, log: args.logRel, ownerGen: this.opts.ownerGen,
    };
    const claimMutate = (r: TaskRecord): void => {
      r.currentRun = claimed;
      if (args.kind === 'prep') r.attempts.prep = attemptId;
      else if (args.kind === 'execute') r.attempts.execute = attemptId;
    };
    const afterClaim =
      args.to && args.to !== live.phase
        ? await args.store.advance(args.ticket, { expectRev: args.expectRev, to: args.to, mutate: claimMutate })
        : await args.store.updateRun(args.ticket, args.expectRev, claimMutate);

    const child = spawnWrapper({
      stateDir: dir, runId, kind: args.kind, attemptId, logRel: args.logRel,
      command: args.command, cwd: args.cwd, env: args.env,
    } satisfies SpawnWrapperArgs);
    const pid = child.pid ?? null;
    const pidStart = pid !== null ? await processStartTime(pid) : null;

    try {
      return await args.store.updateRun(args.ticket, afterClaim.rev, (r) => {
        if (!r.currentRun || r.currentRun.runId !== runId) {
          throw new Error(`dispatchAgent: currentRun changed under backfill for ${args.ticket}`);
        }
        r.currentRun.pid = pid;
        r.currentRun.pidStart = pidStart;
      });
    } catch (err) {
      if (pid !== null) await killGroup(pid, 'SIGTERM');
      throw err;
    }
  }
}
