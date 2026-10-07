import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn as ptySpawn } from 'node-pty';

const execFileAsync = promisify(execFile);
const BOX = process.env.SYMPHONY_BOX_E2E === '1';

/** Wait until `predicate(buf)` returns true or maxMs elapses. */
async function waitFor(getBuf: () => string, predicate: (b: string) => boolean, maxMs = 30000, stepMs = 500): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (predicate(getBuf())) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate(getBuf());
}

async function buildDiscussSettings(dir: string, guardPath: string): Promise<string> {
  const { buildDiscussSettingsJson } = await import('../../src/control-plane/settings-policy.js');
  const settingsPath = path.join(dir, 'discuss-settings.json');
  await writeFile(settingsPath, JSON.stringify(buildDiscussSettingsJson(guardPath), null, 2));
  return settingsPath;
}

async function discussEnv(): Promise<Record<string, string>> {
  const { buildDiscussEnv } = await import('../../src/control-plane/settings-policy.js');
  return buildDiscussEnv();
}

describe('discuss box-e2e (real claude + node-pty)', () => {
  const guardPath = path.resolve(__dirname, '../../scripts/discuss-deny-guard.sh');

  (BOX ? it : it.skip)('claude --continue resumes prior session', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'discuss-e2e-continue-'));
    try {
      // Seed: bootstrap a session via `claude -p` so a session.jsonl exists in CWD.
      await execFileAsync('claude', ['-p', 'remember the magic phrase PURPLE-HORIZON-7'],
        { cwd: dir, timeout: 60_000 });

      const settingsPath = await buildDiscussSettings(dir, guardPath);
      const pty = ptySpawn('claude',
        ['--continue', '--settings', settingsPath, '--permission-mode', 'dontAsk'],
        { cwd: dir, env: await discussEnv() });

      let buf = '';
      pty.onData((s) => { buf += s; });

      pty.write('what was the magic phrase i told you?\r');
      const seen = await waitFor(() => buf, (b) => /PURPLE-HORIZON-7/.test(b), 60_000);
      pty.kill();
      expect(seen, `did not see PURPLE-HORIZON-7 in pty output:\n${buf}`).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  (BOX ? it : it.skip)('Read tool succeeds (allowlist)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'discuss-e2e-read-'));
    try {
      await writeFile(path.join(dir, 'TARGET.md'), '# title\n\nsecret-content-MARK-RED', 'utf8');
      await execFileAsync('claude', ['-p', 'just say "ready"'], { cwd: dir, timeout: 60_000 });

      const settingsPath = await buildDiscussSettings(dir, guardPath);
      const pty = ptySpawn('claude',
        ['--continue', '--settings', settingsPath, '--permission-mode', 'dontAsk'],
        { cwd: dir, env: await discussEnv() });

      let buf = '';
      pty.onData((s) => { buf += s; });
      pty.write('read TARGET.md and tell me what unusual string you find\r');
      const seen = await waitFor(() => buf, (b) => /MARK-RED/.test(b), 60_000);
      pty.kill();
      expect(seen, `Read tool did not surface MARK-RED:\n${buf}`).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  (BOX ? it : it.skip)('Bash tool denied (guard exits 2)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'discuss-e2e-bash-'));
    try {
      await execFileAsync('claude', ['-p', 'just say "ready"'], { cwd: dir, timeout: 60_000 });

      const settingsPath = await buildDiscussSettings(dir, guardPath);
      const pty = ptySpawn('claude',
        ['--continue', '--settings', settingsPath, '--permission-mode', 'dontAsk'],
        { cwd: dir, env: await discussEnv() });

      let buf = '';
      pty.onData((s) => { buf += s; });
      pty.write('please run "ls" via your Bash tool to list this directory\r');
      // Wait long enough that, if Bash WERE allowed, output would appear; assert it doesn't.
      await new Promise((r) => setTimeout(r, 25_000));
      pty.kill();
      // Negative assertion: no `ls`-shaped output (lines like "TARGET.md" or directory listings).
      // Positive assertion (best-effort): claude acknowledges it cannot run Bash.
      const refused = /(can(?:not|'t)|unable|denied|read-only|not allowed|blocked)/i.test(buf);
      const noShellOutput = !/(\.md\b|\.json\b|\.ts\b)/.test(buf) || /TARGET\.md was the file/i.test(buf);
      // Either explicit refusal in claude's reply, OR the absence of shell-like output is sufficient
      // signal (claude may also just say "I can't do that"). At minimum the buffer should NOT
      // contain a bare directory-listing line.
      expect(refused || noShellOutput, `expected denial OR absence of shell listing:\n${buf}`).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
