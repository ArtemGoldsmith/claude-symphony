// src/control-plane/process-manager.ts
// Spec §6: the claude -p process manager. CLAIM the run in task.json BEFORE spawn
// (so a crash right after spawn is reconcilable), then spawn the detached wrapper,
// then backfill pid/pidStart; kill the group if backfill fails (no orphan).
// Completion detection + session capture + abort are added in Task 7.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isProcessAlive, readExitJson, readPidFile, spawnWrapper, processStartTime, killGroup, type SpawnWrapperArgs } from './proc.js';
import { taskDir, type RunRecord, type TaskRecord } from './task-record.js';
import type { TaskStore } from './task-store.js';

/** Env var names always forwarded to a spawned agent (no secrets). */
const ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'SHELL', 'TERM',
];

// Spec §6 completion-evidence: the file each agent kind writes on success. Used
// only when the process is gone AND no exit.json exists AND grace has elapsed.
const EVIDENCE_ARTIFACT: Record<RunRecord['kind'], string | null> = {
  prep: 'open-questions.json',
  execute: 'summary.md',
  review: 'review-fresh.md',
  gapfix: 'summary.md',
  closeout: 'stage9.json',
  preview: null,
  teardown: null,
};

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
  /** Extra fields to set in the SAME claim advance (e.g. intake branch/worktree/baseSha). */
  extraMutate?: (record: TaskRecord) => void;
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
      r.retryRequested = false; // a dispatch consumes any pending retry request (spec §17)
      if (args.kind === 'prep') r.attempts.prep = attemptId;
      else if (args.kind === 'execute') r.attempts.execute = attemptId;
      if (args.extraMutate) args.extraMutate(r);
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

  /**
   * Parse session_id from the first {type:"system",subtype:"init"} event of a
   * stream-json log. Returns null if absent (→ NO-SESSION fallback, spec §6).
   */
  async captureSessionId(logPath: string): Promise<string | null> {
    let raw: string;
    try {
      raw = await fs.readFile(logPath, 'utf8');
    } catch {
      return null;
    }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      try {
        const ev = JSON.parse(t) as { type?: string; subtype?: string; session_id?: unknown };
        if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
          return ev.session_id;
        }
      } catch {
        // ignore non-JSON lines
      }
    }
    return null;
  }

  /**
   * Does the stream-json log end with a final `result` event AND was it written by
   * THIS attempt? The mtime gate rejects a stale log from a prior attempt that
   * reused the same path.
   */
  private async hasResultEvent(logPath: string, spawnedAt: number): Promise<boolean> {
    let raw: string;
    try {
      const st = await fs.stat(logPath);
      if (st.mtimeMs < spawnedAt * 1000) return false; // stale (prior attempt)
      raw = await fs.readFile(logPath, 'utf8');
    } catch {
      return false;
    }
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const ev = JSON.parse(lines[i]!) as { type?: string };
        if (ev.type === 'result') return true;
      } catch {
        /* skip */
      }
    }
    return false;
  }

  /**
   * Decide whether a run is still running, completed, or crashed (spec §6).
   */
  async detectCompletion(args: {
    stateDir: string;
    runId: string;
    kind: RunRecord['kind'];
    /** The run's actual log path (currentRun.log) — NOT derived from kind. */
    logRel: string;
    pid: number | null;
    pidStart: string | null;
    spawnedAt: number;
    graceSeconds: number;
    now: number; // unix seconds
  }): Promise<{ status: 'completed'; exitCode: number } | { status: 'running' | 'unknown' | 'completed-no-exitcode' | 'crashed' }> {
    const exit = await readExitJson(args.stateDir, args.runId);
    if (exit) return { status: 'completed', exitCode: exit.exitCode };

    // Liveness. If pid/pidStart were never backfilled (daemon died between spawn
    // and backfill), recover them from the wrapper's authoritative <runId>.pid
    // file before judging — never mis-crash a still-running long agent.
    let pid = args.pid;
    let pidStart = args.pidStart;
    if (pid === null || pidStart === null) {
      const fromFile = await readPidFile(args.stateDir, args.runId);
      if (fromFile) {
        pid = fromFile.pid;
        pidStart = fromFile.pidStart;
      }
    }
    if (pid !== null && pidStart !== null && (await isProcessAlive(pid, pidStart))) {
      return { status: 'running' };
    }

    if (args.now - args.spawnedAt < args.graceSeconds) {
      return { status: 'unknown' };
    }

    // Past grace, process gone, no exit.json → inspect completion-evidence.
    // Evidence MUST be attempt-scoped: require log AND artifact mtime ≥ spawnedAt.
    const logPath = path.join(args.stateDir, args.logRel);
    if (await this.hasResultEvent(logPath, args.spawnedAt)) return { status: 'completed-no-exitcode' };
    const artifact = EVIDENCE_ARTIFACT[args.kind];
    if (artifact) {
      try {
        const st = await fs.stat(path.join(args.stateDir, artifact));
        if (st.mtimeMs >= args.spawnedAt * 1000) return { status: 'completed-no-exitcode' };
      } catch {
        /* no artifact */
      }
    }
    return { status: 'crashed' };
  }

  /** Per-kind log filename — the Engine/daemon uses this as the dispatch logRel. */
  logRelForKind(kind: RunRecord['kind']): string {
    switch (kind) {
      case 'prep': return 'prep.jsonl';
      case 'execute': return 'agent.jsonl';
      case 'review': return 'review.jsonl';
      case 'gapfix': return 'gapfix.jsonl';
      case 'closeout': return 'closeout.jsonl';
      default: return 'run.jsonl';
    }
  }

  /** Abort a running ⊕ task by killing its recorded process group (spec §6). */
  async abort(pgid: number): Promise<void> {
    await killGroup(pgid, 'SIGTERM');
  }
}
