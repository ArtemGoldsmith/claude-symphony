// src/control-plane/proc.ts
// Spec §6 low-level process primitives. OS-touching but kept tiny + pure-ish so
// the ProcessManager + Engine compose them. The wrapper (scripts/run-wrapper.sh)
// owns pid/exit.json on disk; this module spawns it and reads those artifacts
// back, plus a PID-reuse-safe liveness check via kernel process-start time.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// scripts/run-wrapper.sh sits at the repo root's scripts/ dir. Walk up from the
// compiled module's directory so this works regardless of whether we're running
// via tsx (src/…) or from the build output (dist/src/…).
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveWrapperPath(): string {
  let dir = MODULE_DIR;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'scripts', 'run-wrapper.sh');
    if (fsSync.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the dev-layout path so the export is always a string.
  return path.resolve(MODULE_DIR, '../../scripts/run-wrapper.sh');
}

export const WRAPPER_PATH = resolveWrapperPath();

export interface SpawnWrapperArgs {
  stateDir: string;
  runId: string;
  kind: string;
  attemptId: number;
  /** Log path relative to stateDir (e.g. "agent.jsonl"). */
  logRel: string;
  /** argv: [cmd, ...args]. Passed positionally — never shell-eval'd. */
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Spawn the run wrapper detached (its own session/PGID) so it survives a daemon
 * restart. Returns the ChildProcess; `.pid` is the wrapper pid = the PGID.
 */
export function spawnWrapper(args: SpawnWrapperArgs): ChildProcess {
  const argv = [
    WRAPPER_PATH,
    args.stateDir,
    args.runId,
    args.kind,
    String(args.attemptId),
    args.logRel,
    '--',
    ...args.command,
  ];
  const child = spawn('bash', argv, {
    cwd: args.cwd,
    env: args.env,
    detached: true,
    stdio: 'ignore',
  });
  // Don't keep the event loop alive for this child — the wrapper is autonomous.
  child.unref();
  return child;
}

/** Kernel process-start time as a stable string token, or null if no such pid. */
export async function processStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const token = stdout.replace(/\s+/g, ' ').trim();
    return token.length > 0 ? token : null;
  } catch {
    return null; // ps exits non-zero when the pid is gone
  }
}

/**
 * Liveness = pid currently maps to a process whose kernel start-time matches the
 * recorded token. A bare "pid alive" check is insufficient — PID reuse would
 * make a recycled pid look like our run.
 */
export async function isProcessAlive(pid: number, pidStart: string): Promise<boolean> {
  const current = await processStartTime(pid);
  return current !== null && current === pidStart;
}

export interface PidRecord {
  pid: number;
  pidStart: string;
}

/** Read the wrapper's "<pgid> <start-token>" file; null if absent/malformed. */
export async function readPidFile(stateDir: string, runId: string): Promise<PidRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(stateDir, `${runId}.pid`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const line = raw.trim();
  const sp = line.indexOf(' ');
  if (sp <= 0) return null;
  const pid = Number.parseInt(line.slice(0, sp), 10);
  const pidStart = line.slice(sp + 1).trim();
  if (!Number.isFinite(pid) || pid <= 0 || pidStart.length === 0) return null;
  return { pid, pidStart };
}

export interface ExitRecord {
  runId: string;
  attemptId: number;
  kind: string;
  exitCode: number;
  finishedAt: number;
}

/** Read the final <runId>.exit.json; null if absent or malformed (tmp ignored). */
export async function readExitJson(stateDir: string, runId: string): Promise<ExitRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(stateDir, `${runId}.exit.json`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const p = JSON.parse(raw) as Partial<ExitRecord>;
    if (
      typeof p.runId === 'string' &&
      typeof p.attemptId === 'number' &&
      typeof p.kind === 'string' &&
      typeof p.exitCode === 'number' &&
      typeof p.finishedAt === 'number'
    ) {
      return p as ExitRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/** Kill the whole process group led by `pgid` (negative pid = group). */
export async function killGroup(pgid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    // ESRCH = already gone; that's success for an abort.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}
