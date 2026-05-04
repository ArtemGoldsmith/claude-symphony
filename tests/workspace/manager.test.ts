import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Issue } from '../../src/linear/issue.js';
import { UnsafePathError } from '../../src/util/path-safety.js';
import { HookExecutionError } from '../../src/workspace/hooks.js';
import { WorkspaceManager } from '../../src/workspace/manager.js';

function makeIssue(overrides: Partial<Issue> & Pick<Issue, 'identifier'>): Issue {
  return {
    id: 'i-default',
    title: 'Default title',
    description: null,
    priority: null,
    state: 'Todo',
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('WorkspaceManager', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'wsmgr-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('pathFor composes <root>/<identifier> without touching disk', () => {
    const mgr = new WorkspaceManager({ root });
    const computed = mgr.pathFor('CHR-1');
    expect(computed).toBe(path.join(path.resolve(root), 'CHR-1'));
  });

  it('rejects unsafe identifiers in pathFor', () => {
    const mgr = new WorkspaceManager({ root });
    expect(() => mgr.pathFor('CHR/1')).toThrow(UnsafePathError);
  });

  it('creates the per-issue directory on first call (created=true)', async () => {
    const mgr = new WorkspaceManager({ root });
    const loc = await mgr.ensureWorkspace(makeIssue({ identifier: 'CHR-1' }));

    expect(loc.created).toBe(true);
    expect(loc.path).toBe(path.join(path.resolve(root), 'CHR-1'));
    const stat = await fs.stat(loc.path);
    expect(stat.isDirectory()).toBe(true);
    expect(loc.hookResult).toBeNull();
  });

  it('reuses the existing directory on second call (created=false)', async () => {
    const mgr = new WorkspaceManager({ root });
    const issue = makeIssue({ identifier: 'CHR-2' });
    await mgr.ensureWorkspace(issue);
    const second = await mgr.ensureWorkspace(issue);

    expect(second.created).toBe(false);
    expect(second.hookResult).toBeNull();
  });

  it('runs the after_create hook only on first creation', async () => {
    const mgr = new WorkspaceManager({
      root,
      afterCreateHook: 'echo created-marker > marker.txt',
    });
    const issue = makeIssue({ identifier: 'CHR-3' });

    const first = await mgr.ensureWorkspace(issue);
    expect(first.created).toBe(true);
    expect(first.hookResult).not.toBeNull();
    const markerOnFirst = await fs.readFile(path.join(first.path, 'marker.txt'), 'utf8');
    expect(markerOnFirst.trim()).toBe('created-marker');

    // Replace marker so we can detect a re-run.
    await fs.writeFile(path.join(first.path, 'marker.txt'), 'unchanged');
    const second = await mgr.ensureWorkspace(issue);
    expect(second.created).toBe(false);
    expect(second.hookResult).toBeNull();
    const markerOnSecond = await fs.readFile(path.join(second.path, 'marker.txt'), 'utf8');
    expect(markerOnSecond).toBe('unchanged');
  });

  it('passes SYMPHONY_* env vars from the issue into the hook', async () => {
    const mgr = new WorkspaceManager({
      root,
      afterCreateHook: 'printf "%s|%s|%s" "$SYMPHONY_ISSUE_ID" "$SYMPHONY_ISSUE_IDENTIFIER" "$SYMPHONY_ISSUE_TITLE" > info.txt',
    });
    const issue = makeIssue({
      id: 'i-007',
      identifier: 'CHR-7',
      title: 'A real ticket',
    });
    const loc = await mgr.ensureWorkspace(issue);
    const info = await fs.readFile(path.join(loc.path, 'info.txt'), 'utf8');
    expect(info).toBe('i-007|CHR-7|A real ticket');
  });

  it('propagates hook failures as HookExecutionError', async () => {
    const mgr = new WorkspaceManager({ root, afterCreateHook: 'exit 13' });
    await expect(
      mgr.ensureWorkspace(makeIssue({ identifier: 'CHR-9' })),
    ).rejects.toThrow(HookExecutionError);

    // Directory should still exist for operator inspection (no rollback).
    const stat = await fs.stat(path.join(path.resolve(root), 'CHR-9'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('rejects unsafe identifiers in ensureWorkspace before any disk access', async () => {
    const mgr = new WorkspaceManager({ root });
    await expect(
      mgr.ensureWorkspace(makeIssue({ identifier: '../escape-1' })),
    ).rejects.toThrow(UnsafePathError);

    // Nothing should have been created.
    const entries = await fs.readdir(root);
    expect(entries).toEqual([]);
  });
});
