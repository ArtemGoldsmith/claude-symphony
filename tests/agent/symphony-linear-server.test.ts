import { describe, expect, it, vi } from 'vitest';

import type { LinearWriteGateway } from '../../src/linear/gateway.js';
import type { Issue } from '../../src/linear/issue.js';
import { createSymphonyLinearMcpServer } from '../../src/agent/symphony-linear-server.js';

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'issue_1',
    identifier: 'CHR-1',
    title: 'Test ticket',
    description: 'desc',
    priority: 1,
    state: 'In Progress',
    branchName: 'agent/chr-1-test',
    url: 'https://linear.app/x/CHR-1',
    labels: ['frontend'],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

interface FakeWritesState {
  comments: Array<{ id: string; body: string }>;
  states: Array<{ id: string; name: string; teamKey: string }>;
  attachments: Array<{ issueId: string; url: string; title?: string }>;
  issueState: string;
  /** Last issue id passed to updateIssueState. */
  lastIssueStateUpdate: { issueId: string; stateId: string } | null;
  fetchIssueByIdentifierResult?: Issue | null | (() => Issue | null);
}

function buildFakeWrites(initial: Partial<FakeWritesState> = {}): {
  writes: LinearWriteGateway;
  state: FakeWritesState;
} {
  const state: FakeWritesState = {
    comments: initial.comments ?? [],
    states: initial.states ?? [],
    attachments: [],
    issueState: 'In Progress',
    lastIssueStateUpdate: null,
    ...(initial.fetchIssueByIdentifierResult !== undefined
      ? { fetchIssueByIdentifierResult: initial.fetchIssueByIdentifierResult }
      : {}),
  };

  let nextCommentId = 1;
  const writes: LinearWriteGateway = {
    fetchIssueByIdentifier: vi.fn(async (identifier: string) => {
      if (typeof state.fetchIssueByIdentifierResult === 'function') {
        return state.fetchIssueByIdentifierResult();
      }
      if (state.fetchIssueByIdentifierResult !== undefined) {
        return state.fetchIssueByIdentifierResult;
      }
      return makeIssue({ identifier });
    }),
    listComments: vi.fn(async () => [...state.comments]),
    createComment: vi.fn(async ({ body }: { issueId: string; body: string }) => {
      const id = `c-${nextCommentId++}`;
      state.comments.push({ id, body });
      return { id };
    }),
    updateComment: vi.fn(
      async ({ commentId, body }: { commentId: string; body: string }) => {
        const idx = state.comments.findIndex((c) => c.id === commentId);
        if (idx < 0) throw new Error(`no comment ${commentId}`);
        state.comments[idx] = { id: commentId, body };
      },
    ),
    findWorkflowStateId: vi.fn(
      async ({ teamKey, stateName }: { teamKey: string; stateName: string }) => {
        return (
          state.states.find((s) => s.teamKey === teamKey && s.name === stateName)?.id ?? null
        );
      },
    ),
    updateIssueState: vi.fn(
      async ({ issueId, stateId }: { issueId: string; stateId: string }) => {
        state.lastIssueStateUpdate = { issueId, stateId };
      },
    ),
    createAttachment: vi.fn(
      async (args: { issueId: string; url: string; title?: string }) => {
        state.attachments.push(args);
      },
    ),
  };

  return { writes, state };
}

function getTools(server: unknown): ToolEntry[] {
  // claude-agent-sdk stores registered tools at instance._registeredTools,
  // keyed by tool name. Each entry carries `{ description, inputSchema,
  // handler, ... }` per the MCP server's runtime contract.
  const reg = (server as { instance?: { _registeredTools?: Record<string, unknown> } }).instance
    ?._registeredTools;
  if (!reg || typeof reg !== 'object') {
    throw new Error('test: cannot locate SDK MCP server _registeredTools');
  }
  const entries: ToolEntry[] = [];
  for (const [name, raw] of Object.entries(reg)) {
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { handler: unknown }).handler === 'function'
    ) {
      const v = raw as {
        description?: unknown;
        inputSchema?: unknown;
        handler: ToolEntry['handler'];
      };
      entries.push({
        name,
        description: String(v.description ?? ''),
        inputSchema: v.inputSchema,
        handler: v.handler,
      });
    }
  }
  if (entries.length === 0) {
    throw new Error('test: SDK MCP server has zero registered tools');
  }
  return entries;
}

async function callTool(
  server: unknown,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const tool = getTools(server).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  const result = (await tool.handler(args, {})) as {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  return {
    text: result.content[0]!.text,
    isError: result.isError === true,
  };
}

describe('createSymphonyLinearMcpServer — server registration', () => {
  it('registers a server named symphony_linear with all 6 tools', () => {
    const { writes } = buildFakeWrites();
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle-test',
    });
    const tools = getTools(server);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'attach_pr_url',
        'create_or_update_workpad',
        'get_current_issue',
        'get_workpad',
        'post_comment',
        'transition_state',
      ].sort(),
    );
  });

  it('honours disabledTools to suppress specific tool registrations (Phase 3 P10)', () => {
    const { writes } = buildFakeWrites();
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle-test',
      disabledTools: ['transition_state', 'post_comment'],
    });
    const names = getTools(server)
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      ['attach_pr_url', 'create_or_update_workpad', 'get_current_issue', 'get_workpad'].sort(),
    );
  });
});

describe('symphony_linear tool — get_current_issue', () => {
  it('refetches the issue and returns JSON', async () => {
    const { writes, state } = buildFakeWrites();
    state.fetchIssueByIdentifierResult = makeIssue({ state: 'Human Review' });
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'get_current_issue', {});
    expect(out.isError).toBe(false);
    expect(JSON.parse(out.text).state).toBe('Human Review');
  });

  it('reports error when the issue disappeared', async () => {
    const { writes, state } = buildFakeWrites();
    state.fetchIssueByIdentifierResult = null;
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'get_current_issue', {});
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not found/);
  });
});

describe('symphony_linear tool — get_workpad', () => {
  it('returns "no workpad yet" when there is no Codex Workpad comment', async () => {
    const { writes } = buildFakeWrites({
      comments: [{ id: 'c1', body: 'unrelated comment' }],
    });
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'get_workpad', {});
    expect(out.text).toBe('no workpad yet');
  });

  it('returns the existing workpad when present', async () => {
    const { writes } = buildFakeWrites({
      comments: [
        { id: 'c1', body: 'random' },
        { id: 'c2', body: '## Codex Workpad\n\nplan goes here' },
      ],
    });
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'get_workpad', {});
    const parsed = JSON.parse(out.text);
    expect(parsed.id).toBe('c2');
    expect(parsed.body).toMatch(/plan goes here/);
  });
});

describe('symphony_linear tool — create_or_update_workpad', () => {
  it('creates a fresh workpad when none exists', async () => {
    const { writes, state } = buildFakeWrites();
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'create_or_update_workpad', {
      body: '## Codex Workpad\n\n- [ ] step',
    });
    expect(out.isError).toBe(false);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]!.body).toMatch(/step/);
  });

  it('updates the existing workpad in place rather than creating a duplicate', async () => {
    const { writes, state } = buildFakeWrites({
      comments: [{ id: 'c-pad', body: '## Codex Workpad\n\nold' }],
    });
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'create_or_update_workpad', {
      body: '## Codex Workpad\n\nnew',
    });
    expect(out.isError).toBe(false);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]!.body).toMatch(/new/);
  });

  it('rejects bodies that do not start with the workpad header', async () => {
    const { writes } = buildFakeWrites();
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'create_or_update_workpad', {
      body: 'Plan: ...',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/must start with/);
  });
});

describe('symphony_linear tool — transition_state', () => {
  it('looks up the state by team+name and updates the issue', async () => {
    const { writes, state } = buildFakeWrites({
      states: [
        { id: 's-hr', name: 'Human Review', teamKey: 'CHR' },
        { id: 's-todo', name: 'Todo', teamKey: 'CHR' },
      ],
    });
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'transition_state', { to_state: 'Human Review' });
    expect(out.isError).toBe(false);
    expect(state.lastIssueStateUpdate).toEqual({ issueId: 'issue_1', stateId: 's-hr' });
  });

  it('reports error on unknown state name', async () => {
    const { writes } = buildFakeWrites({ states: [] });
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'transition_state', { to_state: 'NotAState' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/no workflow state named/);
  });
});

describe('symphony_linear tool — attach_pr_url', () => {
  it('attaches a URL to the issue', async () => {
    const { writes, state } = buildFakeWrites();
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'attach_pr_url', {
      url: 'https://github.com/x/y/pull/9',
      title: 'Fix typo',
    });
    expect(out.isError).toBe(false);
    expect(state.attachments).toEqual([
      { issueId: 'issue_1', url: 'https://github.com/x/y/pull/9', title: 'Fix typo' },
    ]);
  });
});

describe('symphony_linear tool — post_comment', () => {
  it('posts a regular comment', async () => {
    const { writes, state } = buildFakeWrites();
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'post_comment', {
      body: 'Blocker: API key missing',
    });
    expect(out.isError).toBe(false);
    expect(state.comments).toEqual([{ id: 'c-1', body: 'Blocker: API key missing' }]);
  });

  it('refuses bodies that look like a workpad', async () => {
    const { writes } = buildFakeWrites();
    const server = createSymphonyLinearMcpServer({
      currentIssue: makeIssue(),
      writes,
      projectSlug: 'chronicle',
    });
    const out = await callTool(server, 'post_comment', {
      body: '## Codex Workpad\n\nshould not duplicate',
    });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/workpad/);
  });
});
