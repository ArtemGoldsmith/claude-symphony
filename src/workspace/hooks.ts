// SPEC.md §9.4 + §15.4 — workspace hook execution.
// PARITY.md row: §9.4 (after_create only in MVP), §15.4.
//
// Run a shell hook script with `bash -lc`, in the workspace cwd, with a
// curated set of environment variables prefixed `SYMPHONY_` describing
// the current issue. Stdout/stderr are captured for the orchestrator to
// log; non-zero exit becomes a thrown error.

import { spawn } from 'node:child_process';

export class HookExecutionError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = 'HookExecutionError';
  }
}

export interface HookEnv {
  /** Linear internal id. */
  ISSUE_ID: string;
  /** Human key (e.g. CHR-123). */
  ISSUE_IDENTIFIER: string;
  ISSUE_TITLE: string;
  ISSUE_URL: string;
  WORKSPACE_PATH: string;
}

export interface HookResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunHookOptions {
  /** Override for tests; defaults to `bash`. Must accept `-lc <script>`. */
  shell?: string;
  /** Process env to inherit. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Cap a runaway hook. Default 10 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Run a hook script. The script is passed as a single argument to `bash -lc`,
 * so `$VAR` interpolation, multi-line bodies, pipelines, etc. all work as
 * the user expects. Errors propagate as HookExecutionError carrying captured
 * output for diagnostics.
 */
export function runHook(
  script: string,
  cwd: string,
  hookEnv: HookEnv,
  options: RunHookOptions = {},
): Promise<HookResult> {
  const shell = options.shell ?? 'bash';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parentEnv = options.env ?? process.env;

  const childEnv: NodeJS.ProcessEnv = {
    ...parentEnv,
    SYMPHONY_ISSUE_ID: hookEnv.ISSUE_ID,
    SYMPHONY_ISSUE_IDENTIFIER: hookEnv.ISSUE_IDENTIFIER,
    SYMPHONY_ISSUE_TITLE: hookEnv.ISSUE_TITLE,
    SYMPHONY_ISSUE_URL: hookEnv.ISSUE_URL,
    SYMPHONY_WORKSPACE_PATH: hookEnv.WORKSPACE_PATH,
  };

  return new Promise<HookResult>((resolve, reject) => {
    const start = Date.now();
    // detached: true creates a new process group on POSIX so we can SIGKILL
    // the whole group on timeout. Without this, killing bash leaves orphan
    // children (e.g. `sleep`) holding the inherited stdio pipes open, which
    // blocks the `close` event from firing.
    const child = spawn(shell, ['-lc', script], {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          // Negative PID = kill the whole process group, taking out any
          // grandchildren (e.g. sleep) that bash might have spawned.
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Group may already be gone; fall back to a direct kill.
          child.kill('SIGKILL');
        }
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new HookExecutionError(
          `hook process failed to spawn: ${err.message}`,
          null,
          null,
          stdout,
          stderr,
        ),
      );
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      if (timedOut) {
        reject(
          new HookExecutionError(
            `hook exceeded timeout of ${timeoutMs} ms`,
            code,
            signal,
            stdout,
            stderr,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new HookExecutionError(
            `hook exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
            code,
            signal,
            stdout,
            stderr,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, durationMs });
    });
  });
}
