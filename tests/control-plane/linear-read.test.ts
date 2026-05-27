import { describe, expect, it } from 'vitest';

import { SdkLinearReadGateway } from '../../src/control-plane/linear-read.js';

function fakeClient() {
  return {
    issues: async (_args: unknown) => ({
      nodes: [
        {
          id: 'iss_1',
          identifier: 'PIN-301',
          title: 'Add change orders tab',
          description: 'body',
          priority: 2,
          branchName: 'pin-301',
          url: 'https://linear.app/x/PIN-301',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-02T00:00:00Z',
          state: Promise.resolve({ name: 'Todo' }),
          labels: async () => ({ nodes: [{ name: 'frontend' }, { name: 'Backend' }] }),
        },
      ],
    }),
    issue: async (_id: string) => ({
      comments: async (_a?: unknown) => ({
        nodes: [
          { id: 'c1', body: 'first comment' },
          { id: 'c2', body: 'scope decision: skip the modal' },
        ],
      }),
    }),
  };
}

describe('SdkLinearReadGateway', () => {
  it('fetchIssueByIdentifier normalises an Issue (lowercased labels)', async () => {
    const gw = new SdkLinearReadGateway(fakeClient() as never);
    const iss = await gw.fetchIssueByIdentifier('PIN-301');
    expect(iss).not.toBeNull();
    expect(iss!.identifier).toBe('PIN-301');
    expect(iss!.state).toBe('Todo');
    expect(iss!.labels).toEqual(['frontend', 'backend']); // adapter lowercases
  });

  it('throws on a malformed identifier', async () => {
    const gw = new SdkLinearReadGateway(fakeClient() as never);
    await expect(gw.fetchIssueByIdentifier('not-a-ticket')).rejects.toThrow();
  });

  it('listComments returns id + body in order', async () => {
    const gw = new SdkLinearReadGateway(fakeClient() as never);
    const comments = await gw.listComments('iss_1');
    expect(comments.map((c) => c.body)).toEqual(['first comment', 'scope decision: skip the modal']);
  });
});
