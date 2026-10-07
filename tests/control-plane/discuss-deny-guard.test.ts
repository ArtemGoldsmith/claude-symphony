import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runScript(scriptPath: string, input: string, timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += String(b)));
    child.stderr.on('data', (b) => (stderr += String(b)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runScript timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // execFileAsync silently ignores `input`; spawn requires explicit
    // stdin.write/end. Without end(), `cat` in the script blocks forever.
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe('discuss-deny-guard.sh', () => {
  const script = path.resolve(__dirname, '../../scripts/discuss-deny-guard.sh');

  it('is executable (mode bits)', () => {
    expect(statSync(script).mode & 0o111).not.toBe(0);
  });

  it('exits 2 on any input and prints discuss-mode to stderr', async () => {
    const res = await runScript(script, '{"tool_name":"Bash"}');
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/discuss-mode/);
  });

  it('drains stdin without hanging on a large payload', async () => {
    const blob = '{}'.padEnd(1024 * 1024, ' '); // 1 MiB
    const res = await runScript(script, blob, 5000);
    expect(res.exitCode).toBe(2);
  });
});
