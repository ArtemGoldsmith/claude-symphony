import { describe, expect, it } from 'vitest';

import { adaptIssue, type RawLinearIssue } from '../../src/linear/adapter.js';

function rawFixture(overrides: Partial<RawLinearIssue> = {}): RawLinearIssue {
  return {
    id: 'issue_123',
    identifier: 'CHR-1',
    title: 'Add dashboard widget',
    description: 'Body of the ticket',
    priority: 2,
    state: { name: 'In Progress' },
    branchName: 'chr-1-add-dashboard-widget',
    url: 'https://linear.app/smirnov-labs/issue/CHR-1',
    labels: { nodes: [{ name: 'Frontend' }, { name: 'BUG' }] },
    inverseRelations: {
      nodes: [
        {
          type: 'blocks',
          issue: { id: 'issue_999', identifier: 'CHR-99', state: { name: 'Done' } },
        },
      ],
    },
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-02T12:00:00.000Z',
    ...overrides,
  };
}

describe('adaptIssue — happy path', () => {
  it('produces a fully normalized Issue from a complete raw payload', () => {
    const issue = adaptIssue(rawFixture());
    expect(issue.id).toBe('issue_123');
    expect(issue.identifier).toBe('CHR-1');
    expect(issue.title).toBe('Add dashboard widget');
    expect(issue.description).toBe('Body of the ticket');
    expect(issue.priority).toBe(2);
    expect(issue.state).toBe('In Progress');
    expect(issue.branchName).toBe('chr-1-add-dashboard-widget');
    expect(issue.url).toBe('https://linear.app/smirnov-labs/issue/CHR-1');
    expect(issue.labels).toEqual(['frontend', 'bug']);
    expect(issue.blockedBy).toEqual([
      { id: 'issue_999', identifier: 'CHR-99', state: 'Done' },
    ]);
    expect(issue.createdAt).toBe('2026-04-01T12:00:00.000Z');
    expect(issue.updatedAt).toBe('2026-04-02T12:00:00.000Z');
  });
});

describe('adaptIssue — labels normalization (SPEC.md §11.3)', () => {
  it('lowercases all label names', () => {
    const issue = adaptIssue(
      rawFixture({ labels: { nodes: [{ name: 'Backend' }, { name: 'P1' }, { name: 'BUG' }] } }),
    );
    expect(issue.labels).toEqual(['backend', 'p1', 'bug']);
  });

  it('handles missing labels block', () => {
    const issue = adaptIssue(rawFixture({ labels: null }));
    expect(issue.labels).toEqual([]);
  });

  it('handles empty labels nodes', () => {
    const issue = adaptIssue(rawFixture({ labels: { nodes: [] } }));
    expect(issue.labels).toEqual([]);
  });

  it('skips labels with empty or non-string names', () => {
    const issue = adaptIssue(
      rawFixture({
        labels: {
          nodes: [
            { name: 'Valid' },
            { name: '' },
            { name: undefined as unknown as string },
          ],
        },
      }),
    );
    expect(issue.labels).toEqual(['valid']);
  });
});

describe('adaptIssue — blockedBy normalization (SPEC.md §11.3)', () => {
  it('keeps only inverse relations of type "blocks"', () => {
    const issue = adaptIssue(
      rawFixture({
        inverseRelations: {
          nodes: [
            { type: 'blocks', issue: { id: 'a', identifier: 'CHR-2', state: { name: 'Todo' } } },
            { type: 'related', issue: { id: 'b', identifier: 'CHR-3', state: { name: 'Done' } } },
            { type: 'duplicate', issue: { id: 'c', identifier: 'CHR-4', state: { name: 'Done' } } },
          ],
        },
      }),
    );
    expect(issue.blockedBy).toEqual([
      { id: 'a', identifier: 'CHR-2', state: 'Todo' },
    ]);
  });

  it('handles missing relation block as empty array', () => {
    const issue = adaptIssue(rawFixture({ inverseRelations: null }));
    expect(issue.blockedBy).toEqual([]);
  });

  it('falls back to nulls when relation issue fields are missing', () => {
    const issue = adaptIssue(
      rawFixture({
        inverseRelations: {
          nodes: [{ type: 'blocks', issue: null }, { type: 'blocks', issue: { id: 'x' } }],
        },
      }),
    );
    expect(issue.blockedBy).toEqual([
      { id: null, identifier: null, state: null },
      { id: 'x', identifier: null, state: null },
    ]);
  });
});

describe('adaptIssue — priority normalization (SPEC.md §11.3)', () => {
  it('keeps integer priorities', () => {
    expect(adaptIssue(rawFixture({ priority: 0 })).priority).toBe(0);
    expect(adaptIssue(rawFixture({ priority: 4 })).priority).toBe(4);
  });

  it('rejects non-integer numbers as null', () => {
    expect(adaptIssue(rawFixture({ priority: 1.5 })).priority).toBeNull();
    expect(adaptIssue(rawFixture({ priority: Number.NaN })).priority).toBeNull();
  });

  it('handles null and undefined priority', () => {
    expect(adaptIssue(rawFixture({ priority: null })).priority).toBeNull();
    expect(adaptIssue(rawFixture({ priority: undefined })).priority).toBeNull();
  });
});

describe('adaptIssue — timestamps (SPEC.md §11.3)', () => {
  it('passes through valid ISO-8601 strings', () => {
    const issue = adaptIssue(rawFixture({ createdAt: '2026-01-15T08:30:00.000Z' }));
    expect(issue.createdAt).toBe('2026-01-15T08:30:00.000Z');
  });

  it('converts Date objects to ISO strings', () => {
    const date = new Date('2026-02-01T00:00:00.000Z');
    const issue = adaptIssue(rawFixture({ updatedAt: date }));
    expect(issue.updatedAt).toBe('2026-02-01T00:00:00.000Z');
  });

  it('returns null for invalid date strings', () => {
    const issue = adaptIssue(rawFixture({ createdAt: 'not a date at all' }));
    expect(issue.createdAt).toBeNull();
  });

  it('returns null for invalid Date instances', () => {
    const issue = adaptIssue(rawFixture({ updatedAt: new Date('not a date') }));
    expect(issue.updatedAt).toBeNull();
  });

  it('returns null for missing timestamps', () => {
    const issue = adaptIssue(rawFixture({ createdAt: null, updatedAt: undefined }));
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
  });
});

describe('adaptIssue — defaulting and required fields', () => {
  it('coerces missing optional string fields to null or empty', () => {
    const issue = adaptIssue({
      id: 'i',
      identifier: 'CHR-1',
      title: 'T',
      state: { name: 'Todo' },
    });
    expect(issue.description).toBeNull();
    expect(issue.priority).toBeNull();
    expect(issue.branchName).toBeNull();
    expect(issue.url).toBeNull();
    expect(issue.labels).toEqual([]);
    expect(issue.blockedBy).toEqual([]);
  });

  it('throws when raw.id is missing', () => {
    expect(() =>
      adaptIssue({
        id: '',
        identifier: 'CHR-1',
        title: 't',
        state: { name: 'Todo' },
      }),
    ).toThrow(/raw\.id/);
  });

  it('throws when raw.identifier is missing', () => {
    expect(() =>
      adaptIssue({
        id: 'i',
        identifier: '',
        title: 't',
        state: { name: 'Todo' },
      }),
    ).toThrow(/raw\.identifier/);
  });

  it('throws when raw.state.name is missing', () => {
    expect(() =>
      adaptIssue({
        id: 'i',
        identifier: 'CHR-1',
        title: 't',
        state: { name: undefined as unknown as string },
      }),
    ).toThrow(/raw\.state\.name/);
  });
});
