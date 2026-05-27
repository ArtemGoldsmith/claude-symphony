import { describe, expect, it } from 'vitest';
import { projectTask, renderBoard, renderDetail, esc } from '../../../src/control-plane/web/views.js';
import { newTaskRecord } from '../../../src/control-plane/task-record.js';

function sample() {
  const r = newTaskRecord({ ticket: 'PIN-1', title: 'A <b>title</b>', url: 'http://x', ownerGen: 'gen-secret', now: 1 });
  r.worktree = '/abs/secret/worktree';
  r.baseSha = 'deadbeefsha';
  r.branch = 'agent/pin-1-x';
  r.currentRun = { runId: 'rid', attemptId: 1, kind: 'prep', pid: 999, pidStart: 's', spawnedAt: 0, sessionId: 'sess-SECRET', log: 'prep.jsonl', ownerGen: 'gen-secret' };
  r.phase = 'awaiting_approval';
  r.openQuestions = { rev: 1, items: [{ id: 'q1', text: 'pick one', kind: 'choice', required: true, options: ['a', 'b'] }] };
  return r;
}

describe('projectTask whitelist', () => {
  it('exposes whitelisted fields and NO sensitive ones', () => {
    const p = projectTask(sample()) as unknown as Record<string, unknown>;
    expect(p.ticket).toBe('PIN-1');
    expect(p.phase).toBe('awaiting_approval');
    expect(p.branch).toBe('agent/pin-1-x');
    expect(p.openQuestions).toBeTruthy();
    for (const k of ['currentRun', 'ownerGen', 'worktree', 'baseSha']) {
      expect(k in p).toBe(false);
    }
    const json = JSON.stringify(p);
    expect(json).not.toContain('sess-SECRET');
    expect(json).not.toContain('gen-secret');
    expect(json).not.toContain('/abs/secret/worktree');
    expect(json).not.toContain('deadbeefsha');
  });
});

describe('esc', () => {
  it('escapes HTML metacharacters', () => {
    expect(esc('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;');
  });
});

describe('renderBoard / renderDetail', () => {
  it('board groups tasks by phase column and escapes the title', () => {
    const html = renderBoard([sample()]);
    expect(html).toContain('awaiting_approval');
    expect(html).toContain('PIN-1');
    expect(html).toContain('&lt;b&gt;title'); // escaped, not raw <b>
    expect(html).not.toContain('sess-SECRET');
  });
  it('detail shows the open-questions form and never leaks secrets', () => {
    const html = renderDetail(sample(), { plan: '', recap: '', reviewFresh: '' });
    expect(html).toContain('pick one');
    expect(html).not.toContain('/abs/secret/worktree');
    expect(html).not.toContain('sess-SECRET');
  });
  it('renders review-fresh.md when present, escaped', () => {
    const html = renderDetail(sample(), { plan: '', recap: '', reviewFresh: 'AC1: <missing>' });
    expect(html).toContain('AC review');
    expect(html).toContain('AC1: &lt;missing&gt;'); // escaped
  });
});
