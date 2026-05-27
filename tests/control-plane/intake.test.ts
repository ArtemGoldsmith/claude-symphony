import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { renderTicketMd, renderCommentsMd, renderContextPathsMd, prepareWorkspace } from '../../src/control-plane/intake.js';
import type { Issue } from '../../src/linear/issue.js';

const exec = promisify(execFile);

const ISSUE: Issue = {
  id: 'iss_1',
  identifier: 'PIN-301',
  title: 'Add change orders tab',
  description: 'Implement the CO tab.',
  priority: 2,
  state: 'Todo',
  branchName: 'pin-301',
  url: 'https://linear.app/x/PIN-301',
  labels: ['frontend'],
  blockedBy: [],
  createdAt: null,
  updatedAt: null,
};

describe('render helpers', () => {
  it('renderTicketMd includes identifier, title, state, url, labels; marks deferred fields', () => {
    const md = renderTicketMd(ISSUE);
    expect(md).toContain('# PIN-301: Add change orders tab');
    expect(md).toContain('Todo');
    expect(md).toContain('https://linear.app/x/PIN-301');
    expect(md).toContain('frontend');
    expect(md).toContain('Implement the CO tab.');
    expect(md).toContain('not fetched in MVP');
  });

  it('renderCommentsMd numbers bodies and handles the empty case', () => {
    expect(renderCommentsMd([])).toContain('(no comments)');
    const md = renderCommentsMd([{ id: 'c1', body: 'hello' }, { id: 'c2', body: 'decision' }]);
    expect(md).toContain('## 1.');
    expect(md).toContain('hello');
    expect(md).toContain('decision');
  });

  it('renderContextPathsMd embeds the code root, AI-proto path, and pull status', () => {
    const md = renderContextPathsMd({ codeRoot: '/wt', aiProto: '/proto', aiProtoPullStatus: 'ok, HEAD=abc' });
    expect(md).toContain('/wt');
    expect(md).toContain('/proto');
    expect(md).toContain('ok, HEAD=abc');
  });
});

describe('prepareWorkspace (real git)', () => {
  let base: string;
  let stateRoot: string;
  let worktreeRoot: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'cp-origin-'));
    stateRoot = await mkdtemp(path.join(tmpdir(), 'cp-state-'));
    worktreeRoot = await mkdtemp(path.join(tmpdir(), 'cp-wt-'));
    await exec('git', ['-C', base, 'init', '-q', '-b', 'development']);
    await exec('git', ['-C', base, 'config', 'user.email', 't@t']);
    await exec('git', ['-C', base, 'config', 'user.name', 't']);
    await writeFile(path.join(base, 'README.md'), 'x', 'utf8');
    await exec('git', ['-C', base, 'add', '.']);
    await exec('git', ['-C', base, 'commit', '-q', '-m', 'init']);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
    await rm(worktreeRoot, { recursive: true, force: true });
  });

  it('creates a worktree off the base branch, writes context files + mode/review-tickets + installs security', async () => {
    const res = await prepareWorkspace({
      repo: base,
      stateRoot,
      worktreeRoot,
      ticket: 'PIN-301',
      issue: ISSUE,
      comments: [{ id: 'c1', body: 'hi' }],
      baseBranch: 'development',
      aiProto: base,
      branch: 'agent/pin-301-co',
    });
    expect(res.worktree).toContain('PIN-301');
    await access(res.worktree);
    const sd = path.join(stateRoot, 'PIN-301');
    expect(await readFile(path.join(sd, 'mode'), 'utf8')).toContain('worktree');
    expect(await readFile(path.join(sd, 'review-tickets'), 'utf8')).toContain('PIN-301');
    await access(path.join(sd, 'ticket.md'));
    await access(path.join(sd, 'comments.md'));
    await access(path.join(sd, 'context-paths.md'));
    await access(path.join(res.worktree, '.claude', 'settings.json'));
    await access(path.join(base, '.git', 'hooks', 'pre-push'));
    expect(res.baseSha.length).toBeGreaterThan(0);
  });

  it('clean-room re-prep resets the worktree to baseSha and discards planted files', async () => {
    const first = await prepareWorkspace({
      repo: base, stateRoot, worktreeRoot, ticket: 'PIN-301', issue: ISSUE,
      comments: [], baseBranch: 'development', aiProto: base, branch: 'agent/pin-301-co',
    });
    // plant an untracked file + a commit in the worktree
    await writeFile(path.join(first.worktree, 'planted.txt'), 'evil', 'utf8');
    await exec('git', ['-C', first.worktree, 'add', '.']);
    await exec('git', ['-C', first.worktree, 'commit', '-q', '-m', 'planted']);
    // re-prep with the recorded baseSha
    const second = await prepareWorkspace({
      repo: base, stateRoot, worktreeRoot, ticket: 'PIN-301', issue: ISSUE,
      comments: [], baseBranch: 'development', aiProto: base, branch: 'agent/pin-301-co',
      baseSha: first.baseSha,
    });
    expect(second.baseSha).toBe(first.baseSha); // back to the original tip
    await expect(access(path.join(second.worktree, 'planted.txt'))).rejects.toBeTruthy();
  });
});
