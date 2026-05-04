import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HookExecutionError, runHook, type HookEnv } from '../../src/workspace/hooks.js';

const ENV: HookEnv = {
  ISSUE_ID: 'issue_123',
  ISSUE_IDENTIFIER: 'CHR-1',
  ISSUE_TITLE: 'Test ticket',
  ISSUE_URL: 'https://linear.app/x/CHR-1',
  WORKSPACE_PATH: '/tmp/placeholder',
};

describe('runHook', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('runs a successful script and returns captured stdout/stderr', async () => {
    const result = await runHook('echo hello-out; echo hello-err 1>&2', cwd, ENV);
    expect(result.stdout.trim()).toBe('hello-out');
    expect(result.stderr.trim()).toBe('hello-err');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs the script in the given cwd', async () => {
    const result = await runHook('pwd', cwd, ENV);
    // macOS may resolve symlinks; compare via realpath.
    const expected = await fs.realpath(cwd);
    expect(result.stdout.trim()).toBe(expected);
  });

  it('exposes SYMPHONY_* env vars to the hook', async () => {
    const result = await runHook(
      'echo "$SYMPHONY_ISSUE_IDENTIFIER|$SYMPHONY_ISSUE_TITLE|$SYMPHONY_WORKSPACE_PATH"',
      cwd,
      { ...ENV, WORKSPACE_PATH: cwd },
    );
    // Env vars are passed through verbatim — no realpath resolution. We
    // expect the literal string we set in WORKSPACE_PATH.
    expect(result.stdout.trim()).toBe(`CHR-1|Test ticket|${cwd}`);
  });

  it('inherits parent process env by default', async () => {
    const result = await runHook(
      'echo "$SYMPHONY_TEST_INHERIT"',
      cwd,
      ENV,
      { env: { ...process.env, SYMPHONY_TEST_INHERIT: 'inherited-value' } },
    );
    expect(result.stdout.trim()).toBe('inherited-value');
  });

  it('throws HookExecutionError on non-zero exit, preserving captured output', async () => {
    let caught: HookExecutionError | undefined;
    try {
      await runHook('echo before-fail; echo err 1>&2; exit 7', cwd, ENV);
    } catch (err) {
      caught = err as HookExecutionError;
    }
    expect(caught).toBeInstanceOf(HookExecutionError);
    expect(caught?.exitCode).toBe(7);
    expect(caught?.stdout).toContain('before-fail');
    expect(caught?.stderr).toContain('err');
  });

  it('kills the script and throws on timeout', async () => {
    let caught: HookExecutionError | undefined;
    try {
      await runHook('sleep 5; echo too-late', cwd, ENV, { timeoutMs: 100 });
    } catch (err) {
      caught = err as HookExecutionError;
    }
    expect(caught).toBeInstanceOf(HookExecutionError);
    expect(caught?.message).toMatch(/timeout/);
  });

  it('rejects when the shell binary cannot be spawned', async () => {
    let caught: HookExecutionError | undefined;
    try {
      await runHook('echo never', cwd, ENV, { shell: '/nonexistent/shell' });
    } catch (err) {
      caught = err as HookExecutionError;
    }
    expect(caught).toBeInstanceOf(HookExecutionError);
    expect(caught?.message).toMatch(/spawn/);
  });
});
