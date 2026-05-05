import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseWorkflowConfig } from '../../src/config/schema.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { AgentRunner, type QueryFactory } from '../../src/agent/runner.js';
import type { LinearGateway } from '../../src/linear/gateway.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { startStatusServer, type StatusServer } from '../../src/observability/http-server.js';

function makeOrchestrator(): {
  orchestrator: Orchestrator;
  fetchCalls: { count: number };
} {
  const fetchCalls = { count: 0 };
  const linear: LinearGateway = {
    fetchActiveCandidates: vi.fn(async () => {
      fetchCalls.count += 1;
      return [];
    }),
    fetchIssueByIdentifier: vi.fn(async () => null),
  };
  const workspace = {
    pathFor: (id: string) => `/tmp/${id}`,
    ensureWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;
  const stub: QueryFactory = async function* () {
    /* never used */
  };
  const cfg = parseWorkflowConfig({
    tracker: { kind: 'linear', project_slug: 'chronicle' },
    workspace: { root: '/tmp/workspaces' },
    polling: { interval_ms: 5000 },
    agent: { max_concurrent_agents: 2 },
    claude: { mcp_servers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } },
  });
  const resolved = resolveConfig(cfg, { LINEAR_API_KEY: 'lin_test' });
  const orchestrator = new Orchestrator({
    linear,
    workspace,
    agent: new AgentRunner(stub),
    promptTemplate: 'p',
    config: resolved,
  });
  // Seed some state for the snapshot to show.
  orchestrator.state.claim('issue_1');
  orchestrator.state.markRunning('issue_1');
  orchestrator.state.setSessionId('issue_1', 'sess_abc123def456ghi');
  return { orchestrator, fetchCalls };
}

describe('startStatusServer (Phase 3 P3)', () => {
  let server: StatusServer | null = null;

  beforeEach(() => {
    server = null;
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  it('serves /api/v1/state with the orchestrator snapshot', async () => {
    const { orchestrator } = makeOrchestrator();
    server = await startStatusServer({ port: 0, orchestrator });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/state`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.project_slug).toBe('chronicle');
    expect(body.state.issues['issue_1']).toMatchObject({
      state: 'running',
      attemptCount: 1,
      sessionId: 'sess_abc123def456ghi',
    });
  });

  it('serves /api/v1/issues/:id with a single record', async () => {
    const { orchestrator } = makeOrchestrator();
    server = await startStatusServer({ port: 0, orchestrator });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/issues/issue_1`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issueId).toBe('issue_1');
    expect(body.state).toBe('running');
  });

  it('returns 404 for unknown issue ids', async () => {
    const { orchestrator } = makeOrchestrator();
    server = await startStatusServer({ port: 0, orchestrator });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/issues/nope`);
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/refresh triggers an orchestrator tick', async () => {
    const { orchestrator, fetchCalls } = makeOrchestrator();
    server = await startStatusServer({ port: 0, orchestrator });
    const before = fetchCalls.count;
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/refresh`, {
      method: 'POST',
    });
    expect(res.status).toBe(202);
    // refreshNow runs in the background — give the I/O a moment to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(fetchCalls.count).toBeGreaterThan(before);
  });

  it('serves the HTML dashboard at /', async () => {
    const { orchestrator } = makeOrchestrator();
    server = await startStatusServer({ port: 0, orchestrator });
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('claude-symphony');
    expect(body).toContain('/api/v1/state');
  });

  it('returns 404 for unknown routes', async () => {
    const { orchestrator } = makeOrchestrator();
    server = await startStatusServer({ port: 0, orchestrator });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/v999/whatever`);
    expect(res.status).toBe(404);
  });
});
