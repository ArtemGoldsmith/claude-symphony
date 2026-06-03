// tests/control-plane/daemon.canpreview.test.ts
// Real `canPreview()` against a real on-disk git worktree (no mocks).
// Regression: the daemon writes per-spawn artefacts under .claude/ that show
// up as untracked in `git status --porcelain` after every agent run; without
// the DAEMON_MANAGED_PATHS filter, every well-behaved agent's task ended up
// in execute_failed after closeout. Caught live on PIN-259.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { canPreview } from '../../src/control-plane/daemon.js';
import type { TaskRecord } from '../../src/control-plane/task-record.js';

const execFileAsync = promisify(execFile);

function seed(overrides: Partial<TaskRecord>): TaskRecord {
  return {
    ticket: 'TEAM-1', rev: 0, phase: 'closing', ownerGen: 'g',
    title: '', url: '', branch: 'b',
    worktree: '/missing', baseSha: 'a',
    currentRun: null, openQuestions: null, answers: null,
    rejectFeedback: null, operatorNote: null, preview: null, stage9: null,
    teardownTarget: null, failedFrom: null, terminalReason: null,
    retryRequested: false,
    attempts: { prep: 0, execute: 0 },
    createdAt: 0, updatedAt: 0,
    ...overrides,
  } as TaskRecord;
}

describe('canPreview', () => {
  let wt: string;
  let baseSha: string;

  beforeEach(async () => {
    wt = await mkdtemp(path.join(tmpdir(), 'cp-canpreview-'));
    await execFileAsync('git', ['-C', wt, 'init', '-q', '-b', 'main']);
    await execFileAsync('git', ['-C', wt, 'config', 'user.email', 't@t']);
    await execFileAsync('git', ['-C', wt, 'config', 'user.name', 't']);
    await writeFile(path.join(wt, 'README.md'), '# base\n', 'utf8');
    await execFileAsync('git', ['-C', wt, 'add', '.']);
    await execFileAsync('git', ['-C', wt, 'commit', '-q', '-m', 'base']);
    const { stdout } = await execFileAsync('git', ['-C', wt, 'rev-parse', 'HEAD']);
    baseSha = stdout.trim();
  });
  afterEach(async () => { await rm(wt, { recursive: true, force: true }); });

  it('false when worktree or baseSha is null', async () => {
    expect(await canPreview(seed({ worktree: null, baseSha }))).toBe(false);
    expect(await canPreview(seed({ worktree: wt, baseSha: null }))).toBe(false);
  });

  it('false when HEAD === baseSha (no agent commits)', async () => {
    expect(await canPreview(seed({ worktree: wt, baseSha }))).toBe(false);
  });

  it('true when HEAD advanced past baseSha on a clean worktree', async () => {
    await writeFile(path.join(wt, 'feature.txt'), 'work\n', 'utf8');
    await execFileAsync('git', ['-C', wt, 'add', '.']);
    await execFileAsync('git', ['-C', wt, 'commit', '-q', '-m', 'feature']);
    expect(await canPreview(seed({ worktree: wt, baseSha }))).toBe(true);
  });

  it('false when a non-daemon file is dirty (regular untracked / modified)', async () => {
    await writeFile(path.join(wt, 'feature.txt'), 'work\n', 'utf8');
    await execFileAsync('git', ['-C', wt, 'add', '.']);
    await execFileAsync('git', ['-C', wt, 'commit', '-q', '-m', 'feature']);
    await writeFile(path.join(wt, 'untracked.txt'), 'oops\n', 'utf8');
    expect(await canPreview(seed({ worktree: wt, baseSha }))).toBe(false);
  });

  it('true when ONLY .claude/settings.json is untracked (daemon-managed)', async () => {
    await writeFile(path.join(wt, 'feature.txt'), 'work\n', 'utf8');
    await execFileAsync('git', ['-C', wt, 'add', '.']);
    await execFileAsync('git', ['-C', wt, 'commit', '-q', '-m', 'feature']);
    await mkdir(path.join(wt, '.claude'), { recursive: true });
    await writeFile(path.join(wt, '.claude', 'settings.json'), '{}\n', 'utf8');
    expect(await canPreview(seed({ worktree: wt, baseSha }))).toBe(true);
  });

  it('false when .claude/settings.json AND another untracked file (real dirt)', async () => {
    await writeFile(path.join(wt, 'feature.txt'), 'work\n', 'utf8');
    await execFileAsync('git', ['-C', wt, 'add', '.']);
    await execFileAsync('git', ['-C', wt, 'commit', '-q', '-m', 'feature']);
    await mkdir(path.join(wt, '.claude'), { recursive: true });
    await writeFile(path.join(wt, '.claude', 'settings.json'), '{}\n', 'utf8');
    await writeFile(path.join(wt, 'untracked.txt'), 'oops\n', 'utf8');
    expect(await canPreview(seed({ worktree: wt, baseSha }))).toBe(false);
  });
});
