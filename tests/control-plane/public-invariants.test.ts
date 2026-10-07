import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('public-repo invariants', () => {
  it('the grep guard passes on the current tree (no box specifics in tracked files)', async () => {
    const { stdout } = await exec('bash', [path.join(REPO, 'scripts/check-public-invariants.sh')], { cwd: REPO });
    expect(stdout).toContain('public invariants OK');
  });
});
