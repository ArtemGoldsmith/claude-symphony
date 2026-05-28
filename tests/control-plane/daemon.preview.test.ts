import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { readPreviewOutcome, previewUrl, loadOpenQuestions, loadStage9 } from '../../src/control-plane/daemon.js';
import type { TaskRecord } from '../../src/control-plane/task-record.js';

const exec = promisify(execFile);

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'cp-dprev-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function fakeTask(over: Partial<TaskRecord>): TaskRecord {
  return {
    ticket: 'PIN-1', rev: 1, phase: 'previewing', ownerGen: 'g', title: 'T', url: 'u',
    branch: 'b', worktree: '', baseSha: 'base', currentRun: null, openQuestions: null,
    answers: null, rejectFeedback: null, preview: null, stage9: null, teardownTarget: null,
    failedFrom: null, terminalReason: null, retryRequested: false,
    attempts: { prep: 1, execute: 1 }, createdAt: 0, updatedAt: 0, ...over,
  } as TaskRecord;
}

describe('previewUrl', () => {
  it('derives https://<caddyVhost> (preview.json has no url field)', () => {
    expect(previewUrl({ caddyVhost: 'pin-1.preview.internal' })).toBe('https://pin-1.preview.internal');
  });
});

describe('readPreviewOutcome', () => {
  it('reads preview.json + compares HEAD to gitSha in a real worktree', async () => {
    // a tiny git worktree with one commit = HEAD
    const wt = path.join(root, 'wt');
    await mkdir(wt, { recursive: true });
    await exec('git', ['-C', wt, 'init', '-q']);
    await exec('git', ['-C', wt, 'config', 'user.email', 't@t']);
    await exec('git', ['-C', wt, 'config', 'user.name', 't']);
    await writeFile(path.join(wt, 'f'), 'x', 'utf8');
    await exec('git', ['-C', wt, 'add', '.']);
    await exec('git', ['-C', wt, 'commit', '-qm', 'c1']);
    const head = (await exec('git', ['-C', wt, 'rev-parse', 'HEAD'])).stdout.trim();

    const stateDir = path.join(root, 'PIN-1');
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'preview.json'),
      JSON.stringify({ state: 'up', gitSha: head, caddyVhost: 'pin-1.preview.internal' }), 'utf8');

    const out = await readPreviewOutcome(fakeTask({ worktree: wt }), root);
    expect(out).toEqual({ state: 'up', gitSha: head, url: 'https://pin-1.preview.internal', headMatches: true });
  });

  it('returns headMatches=false when preview.json gitSha differs from HEAD', async () => {
    const wt = path.join(root, 'wt2');
    await mkdir(wt, { recursive: true });
    await exec('git', ['-C', wt, 'init', '-q']);
    await exec('git', ['-C', wt, 'config', 'user.email', 't@t']);
    await exec('git', ['-C', wt, 'config', 'user.name', 't']);
    await writeFile(path.join(wt, 'f'), 'x', 'utf8');
    await exec('git', ['-C', wt, 'add', '.']); await exec('git', ['-C', wt, 'commit', '-qm', 'c1']);
    const stateDir = path.join(root, 'PIN-1');
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, 'preview.json'),
      JSON.stringify({ state: 'failed', gitSha: 'deadbeef', caddyVhost: 'v' }), 'utf8');
    const out = await readPreviewOutcome(fakeTask({ worktree: wt }), root);
    expect(out!.headMatches).toBe(false);
    expect(out!.state).toBe('failed');
  });

  it('returns null when preview.json is absent', async () => {
    const out = await readPreviewOutcome(fakeTask({ worktree: root }), root);
    expect(out).toBeNull();
  });
});

describe('loadOpenQuestions / loadStage9', () => {
  it('loadOpenQuestions accepts a bare array and validates items', async () => {
    const dir = path.join(root, 'PIN-1'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'open-questions.json'),
      JSON.stringify([{ id: 'q1', text: 'pick', kind: 'bool', required: true }]), 'utf8');
    const items = await loadOpenQuestions(fakeTask({}), root);
    expect(items).toEqual([{ id: 'q1', text: 'pick', kind: 'bool', required: true }]);
  });

  it('loadOpenQuestions accepts {items:[...]} and returns null on malformed', async () => {
    const dir = path.join(root, 'PIN-1'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'open-questions.json'), JSON.stringify({ items: [{ id: 'q', text: 't', kind: 'free', required: false }] }), 'utf8');
    expect(await loadOpenQuestions(fakeTask({}), root)).toHaveLength(1);
    await writeFile(path.join(dir, 'open-questions.json'), JSON.stringify([{ id: 5, kind: 'nope' }]), 'utf8');
    expect(await loadOpenQuestions(fakeTask({}), root)).toBeNull();
  });

  it('loadStage9 parses a valid stage9.json and rejects malformed', async () => {
    const dir = path.join(root, 'PIN-1'); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'stage9.json'),
      JSON.stringify({ attemptId: 2, gitSha: 'abc', items: [{ n: 1, tag: 'CUT', text: 'x', acked: false }] }), 'utf8');
    const s9 = await loadStage9(fakeTask({}), root);
    expect(s9!.items[0]!.tag).toBe('CUT');
    await writeFile(path.join(dir, 'stage9.json'), '{"bad":true}', 'utf8');
    expect(await loadStage9(fakeTask({}), root)).toBeNull();
  });
});
