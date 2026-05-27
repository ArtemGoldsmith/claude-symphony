// src/control-plane/pre-push.ts
// Spec §11 C2: hardened pre-push. Unlike the skill's hook it refuses EVERY ref
// and ignores any SYMPHONY_ALLOW_PUSH override — under the control plane an
// agent must never push. Installed once at the shared $REPO/.git/hooks/pre-push
// (worktrees inherit it). The non-marker-collision check mirrors the skill's:
// never clobber a human's existing hook.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PRE_PUSH_MARKER = '# symphony-control-plane:';

export const HARDENED_PRE_PUSH = `#!/bin/sh
${PRE_PUSH_MARKER} refuse ALL pushes. The control plane never publishes branches.
# This hook is installed by claude-symphony and intentionally has no override.
printf 'symphony-control-plane: pushing is disabled for agent worktrees\\n' >&2
exit 1
`;

export class PrePushCollisionError extends Error {
  constructor(hookPath: string) {
    super(`a non-symphony pre-push hook already exists at ${hookPath}; refusing to overwrite`);
    this.name = 'PrePushCollisionError';
  }
}

/**
 * Install the hardened hook at `<gitDir>/hooks/pre-push`. No-op if our marker is
 * already present in the first 5 lines; throws PrePushCollisionError on a foreign
 * hook (never clobber a human's). `gitDir` is the shared repo .git dir.
 */
export async function installPrePush(gitDir: string): Promise<void> {
  const hookPath = path.join(gitDir, 'hooks', 'pre-push');
  let existing: string | null = null;
  try {
    existing = await fs.readFile(hookPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing !== null) {
    const firstFive = existing.split('\n').slice(0, 5).join('\n');
    if (firstFive.includes(PRE_PUSH_MARKER)) return; // ours — leave alone
    throw new PrePushCollisionError(hookPath);
  }
  await fs.mkdir(path.dirname(hookPath), { recursive: true });
  await fs.writeFile(hookPath, HARDENED_PRE_PUSH, { encoding: 'utf8', mode: 0o755 });
  await fs.chmod(hookPath, 0o755);
}

/**
 * Belt-and-suspenders: point the push URL of `origin` at a dead value so even a
 * direct `git push origin` cannot reach the real remote. Idempotent. Runs in the
 * worktree (worktrees share the repo's remote config).
 */
export async function neuterPushUrl(worktree: string, remote = 'origin'): Promise<void> {
  await execFileAsync('git', ['-C', worktree, 'remote', 'set-url', '--push', remote, 'DISABLED'], {
    // A repo with no such remote is fine — treat failure as non-fatal upstream.
  }).catch(() => undefined);
}
