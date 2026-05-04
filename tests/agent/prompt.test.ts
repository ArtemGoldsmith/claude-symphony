import { describe, expect, it } from 'vitest';

import type { Issue } from '../../src/linear/issue.js';
import { PromptRenderError, buildIssueView, renderPrompt } from '../../src/agent/prompt.js';

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue_1',
    identifier: 'CHR-1',
    title: 'Add dashboard widget',
    description: 'A description body.',
    priority: 1,
    state: 'In Progress',
    branchName: 'chr-1-add-dashboard-widget',
    url: 'https://linear.app/x/CHR-1',
    labels: ['frontend', 'p1'],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe('buildIssueView', () => {
  it('joins labels with ", " and coerces nulls to empty strings', () => {
    const view = buildIssueView(
      makeIssue({
        description: null,
        url: null,
        branchName: null,
        labels: ['a', 'b', 'c'],
      }),
    );
    expect(view.description).toBe('');
    expect(view.url).toBe('');
    expect(view.branchName).toBe('');
    expect(view.labels).toBe('a, b, c');
  });
});

describe('renderPrompt', () => {
  it('substitutes simple {{ name.field }} variables', () => {
    const result = renderPrompt(
      'Working on {{ issue.identifier }}: {{ issue.title }}',
      { issue: buildIssueView(makeIssue()), attempt: null },
    );
    expect(result).toBe('Working on CHR-1: Add dashboard widget');
  });

  it('tolerates whitespace inside the braces', () => {
    const result = renderPrompt('A={{issue.identifier}} B={{    issue.identifier   }}', {
      issue: buildIssueView(makeIssue()),
      attempt: null,
    });
    expect(result).toBe('A=CHR-1 B=CHR-1');
  });

  it('renders attempt as the integer when set', () => {
    const result = renderPrompt('attempt={{ attempt }}', {
      issue: buildIssueView(makeIssue()),
      attempt: 3,
    });
    expect(result).toBe('attempt=3');
  });

  it('renders attempt as empty string when null', () => {
    const result = renderPrompt('attempt={{ attempt }}', {
      issue: buildIssueView(makeIssue()),
      attempt: null,
    });
    expect(result).toBe('attempt=');
  });

  it('throws PromptRenderError on an unknown top-level variable', () => {
    expect(() =>
      renderPrompt('{{ foo }}', { issue: buildIssueView(makeIssue()), attempt: null }),
    ).toThrow(PromptRenderError);
  });

  it('throws PromptRenderError on an unknown issue subfield', () => {
    expect(() =>
      renderPrompt('{{ issue.somethingElse }}', {
        issue: buildIssueView(makeIssue()),
        attempt: null,
      }),
    ).toThrow(/somethingElse/);
  });

  it('throws when a top-level object is referenced without a subfield', () => {
    expect(() =>
      renderPrompt('{{ issue }}', { issue: buildIssueView(makeIssue()), attempt: null }),
    ).toThrow(PromptRenderError);
  });

  it('preserves text outside {{ }} markers verbatim', () => {
    const result = renderPrompt(
      'Header line.\n\n{{ issue.title }}\n\nFooter.',
      { issue: buildIssueView(makeIssue({ title: 'Fix bug' })), attempt: null },
    );
    expect(result).toBe('Header line.\n\nFix bug\n\nFooter.');
  });

  it('handles multiple substitutions on the same line', () => {
    const result = renderPrompt(
      '{{ issue.identifier }} | {{ issue.state }} | {{ issue.labels }}',
      {
        issue: buildIssueView(makeIssue({ labels: ['bug', 'p0'] })),
        attempt: null,
      },
    );
    expect(result).toBe('CHR-1 | In Progress | bug, p0');
  });
});
