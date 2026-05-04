import { describe, expect, it, vi } from 'vitest';

import {
  SdkLinearGateway,
  type IssuesQueryArgs,
  type IssuesQueryResult,
  type SdkIssueNode,
} from '../../src/linear/client.js';
import { LinearTrackerError } from '../../src/linear/gateway.js';

function makeNode(overrides: Partial<SdkIssueNode> & Pick<SdkIssueNode, 'id' | 'identifier'>): SdkIssueNode {
  return {
    title: `Title for ${overrides.identifier}`,
    description: null,
    priority: null,
    branchName: null,
    url: null,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    state: Promise.resolve({ name: 'Todo' }),
    labels: () => Promise.resolve({ nodes: [] }),
    inverseRelations: () => Promise.resolve({ nodes: [] }),
    ...overrides,
  };
}

function makeStubClient(pages: IssuesQueryResult[]) {
  const calls: IssuesQueryArgs[] = [];
  let pageIndex = 0;
  const issues = vi.fn(async (args: IssuesQueryArgs): Promise<IssuesQueryResult> => {
    calls.push(args);
    const page = pages[pageIndex];
    if (!page) throw new Error(`stub client: ran out of pages at call ${pageIndex}`);
    pageIndex += 1;
    return page;
  });
  return { issues, calls };
}

describe('SdkLinearGateway — fetchActiveCandidates', () => {
  it('passes the project + state filter from SPEC.md §11.2', async () => {
    const stub = makeStubClient([
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const gateway = new SdkLinearGateway(stub);
    await gateway.fetchActiveCandidates('chronicle', ['Todo', 'In Progress']);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.filter).toEqual({
      project: { slugId: { eq: 'chronicle' } },
      state: { name: { in: ['Todo', 'In Progress'] } },
    });
    expect(stub.calls[0]?.first).toBe(50);
    expect(stub.calls[0]?.after).toBeUndefined();
  });

  it('returns an empty array when activeStates is empty (no API call)', async () => {
    const stub = makeStubClient([]);
    const gateway = new SdkLinearGateway(stub);
    const result = await gateway.fetchActiveCandidates('chronicle', []);
    expect(result).toEqual([]);
    expect(stub.issues).not.toHaveBeenCalled();
  });

  it('paginates across multiple pages', async () => {
    const stub = makeStubClient([
      {
        nodes: [makeNode({ id: 'a', identifier: 'CHR-1' })],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
      },
      {
        nodes: [makeNode({ id: 'b', identifier: 'CHR-2' })],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
      },
      {
        nodes: [makeNode({ id: 'c', identifier: 'CHR-3' })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);
    const gateway = new SdkLinearGateway(stub);
    const result = await gateway.fetchActiveCandidates('chronicle', ['Todo']);

    expect(result.map((i) => i.identifier)).toEqual(['CHR-1', 'CHR-2', 'CHR-3']);
    expect(stub.calls).toHaveLength(3);
    expect(stub.calls[1]?.after).toBe('cursor-1');
    expect(stub.calls[2]?.after).toBe('cursor-2');
  });

  it('materializes nodes via the adapter', async () => {
    const stub = makeStubClient([
      {
        nodes: [
          makeNode({
            id: 'i1',
            identifier: 'CHR-7',
            title: 'Hello',
            priority: 1,
            state: Promise.resolve({ name: 'In Progress' }),
            labels: () => Promise.resolve({ nodes: [{ name: 'Backend' }, { name: 'P1' }] }),
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);
    const gateway = new SdkLinearGateway(stub);
    const [issue] = await gateway.fetchActiveCandidates('chronicle', ['Todo']);

    expect(issue!.identifier).toBe('CHR-7');
    expect(issue!.title).toBe('Hello');
    expect(issue!.priority).toBe(1);
    expect(issue!.state).toBe('In Progress');
    expect(issue!.labels).toEqual(['backend', 'p1']);
    expect(issue!.blockedBy).toEqual([]);
  });

  it('does not call inverseRelations when resolveBlockers is false (MVP default)', async () => {
    const inverseRelations = vi.fn(async () => ({ nodes: [] }));
    const stub = makeStubClient([
      {
        nodes: [
          makeNode({
            id: 'i1',
            identifier: 'CHR-1',
            inverseRelations,
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);
    const gateway = new SdkLinearGateway(stub);
    await gateway.fetchActiveCandidates('chronicle', ['Todo']);
    expect(inverseRelations).not.toHaveBeenCalled();
  });

  it('does call inverseRelations when resolveBlockers is true', async () => {
    const inverseRelations = vi.fn(async () => ({
      nodes: [{ type: 'blocks', issue: { id: 'b', identifier: 'CHR-2', state: { name: 'Todo' } } }],
    }));
    const stub = makeStubClient([
      {
        nodes: [
          makeNode({
            id: 'i1',
            identifier: 'CHR-1',
            inverseRelations,
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);
    const gateway = new SdkLinearGateway(stub, { resolveBlockers: true });
    const [issue] = await gateway.fetchActiveCandidates('chronicle', ['Todo']);
    expect(inverseRelations).toHaveBeenCalledTimes(1);
    expect(issue!.blockedBy).toEqual([
      { id: 'b', identifier: 'CHR-2', state: 'Todo' },
    ]);
  });

  it('wraps SDK errors as LinearTrackerError', async () => {
    const issues = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const gateway = new SdkLinearGateway({ issues });
    await expect(gateway.fetchActiveCandidates('chronicle', ['Todo'])).rejects.toThrow(
      LinearTrackerError,
    );
  });

  it('throws LinearTrackerError when an issue has no resolvable state name', async () => {
    const stub = makeStubClient([
      {
        nodes: [
          makeNode({
            id: 'i1',
            identifier: 'CHR-1',
            state: Promise.resolve({ name: null }),
          }),
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);
    const gateway = new SdkLinearGateway(stub);
    await expect(gateway.fetchActiveCandidates('chronicle', ['Todo'])).rejects.toThrow(
      LinearTrackerError,
    );
  });
});

describe('SdkLinearGateway — fetchIssueByIdentifier', () => {
  it('parses TEAM-NNN into team key and number filters', async () => {
    const stub = makeStubClient([
      {
        nodes: [makeNode({ id: 'i1', identifier: 'CHR-42' })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]);
    const gateway = new SdkLinearGateway(stub);
    const issue = await gateway.fetchIssueByIdentifier('CHR-42');

    expect(issue?.identifier).toBe('CHR-42');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.filter).toEqual({
      team: { key: { eq: 'CHR' } },
      number: { eq: 42 },
    });
    expect(stub.calls[0]?.first).toBe(1);
  });

  it('returns null when no issue matches', async () => {
    const stub = makeStubClient([
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const gateway = new SdkLinearGateway(stub);
    expect(await gateway.fetchIssueByIdentifier('CHR-99')).toBeNull();
  });

  it('rejects malformed identifiers', async () => {
    const stub = makeStubClient([]);
    const gateway = new SdkLinearGateway(stub);
    await expect(gateway.fetchIssueByIdentifier('garbage')).rejects.toThrow(
      LinearTrackerError,
    );
  });

  it('trims whitespace before parsing', async () => {
    const stub = makeStubClient([
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]);
    const gateway = new SdkLinearGateway(stub);
    await gateway.fetchIssueByIdentifier('  PIN-7  ');
    expect(stub.calls[0]?.filter).toMatchObject({ team: { key: { eq: 'PIN' } } });
  });
});
