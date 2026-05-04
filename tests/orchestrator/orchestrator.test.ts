import { describe, expect, it, vi } from 'vitest';

import {
  AgentRunner,
  type AgentRunInput,
  type AgentRunResult,
  type QueryFactory,
  type AgentSdkMessage,
} from '../../src/agent/runner.js';
import { parseWorkflowConfig } from '../../src/config/schema.js';
import { resolveConfig, type ResolvedWorkflowConfig } from '../../src/config/resolve.js';
import type { LinearGateway } from '../../src/linear/gateway.js';
import type { Issue } from '../../src/linear/issue.js';
import type { WorkspaceManager } from '../../src/workspace/manager.js';
import { Orchestrator, type OrchestratorEvent } from '../../src/orchestrator/orchestrator.js';

function makeIssue(overrides: Partial<Issue> & Pick<Issue, 'id' | 'identifier'>): Issue {
  return {
    title: `Title ${overrides.identifier}`,
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

function makeConfig(overrides?: { maxConcurrent?: number }): ResolvedWorkflowConfig {
  const cfg = parseWorkflowConfig({
    tracker: { kind: 'linear', project_slug: 'chronicle' },
    workspace: { root: '/tmp/workspaces' },
    polling: { interval_ms: 5_000 },
    agent: { max_concurrent_agents: overrides?.maxConcurrent ?? 2 },
    claude: {
      mcp_servers: { linear: { url: 'https://mcp.linear.app/mcp' } },
    },
  });
  return resolveConfig(cfg, { LINEAR_API_KEY: 'lin_test' });
}

interface Fakes {
  linear: LinearGateway;
  workspace: WorkspaceManager;
  agent: AgentRunner;
  events: OrchestratorEvent[];
  agentInputs: AgentRunInput[];
  workspaceCalls: string[];
  fetchCalls: number;
}

function buildFakes(opts: {
  candidates?: Issue[];
  fetchError?: Error;
  agentResult?: AgentRunResult | ((input: AgentRunInput) => AgentRunResult);
  workspaceFails?: boolean;
}): Fakes {
  const events: OrchestratorEvent[] = [];
  const agentInputs: AgentRunInput[] = [];
  const workspaceCalls: string[] = [];
  let fetchCalls = 0;

  const linear: LinearGateway = {
    fetchActiveCandidates: vi.fn(async () => {
      fetchCalls += 1;
      if (opts.fetchError) throw opts.fetchError;
      return opts.candidates ?? [];
    }),
    fetchIssueByIdentifier: vi.fn(async () => null),
  };

  const workspace = {
    pathFor: (identifier: string) => `/tmp/workspaces/${identifier}`,
    ensureWorkspace: vi.fn(async (issue: Issue) => {
      workspaceCalls.push(issue.identifier);
      if (opts.workspaceFails) throw new Error(`workspace failed for ${issue.identifier}`);
      return {
        path: `/tmp/workspaces/${issue.identifier}`,
        created: true,
        hookResult: null,
      };
    }),
  } as unknown as WorkspaceManager;

  const successResult: AgentRunResult = {
    exitReason: 'completed',
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.01,
    },
    durationMs: 10,
    finalText: 'ok',
    numTurns: 1,
    errorMessage: null,
  };
  const stub: QueryFactory = async function* () {
    const fakeMsg: AgentSdkMessage = {
      type: 'result',
      subtype: 'success',
      result: 'ok',
      usage: { input_tokens: 100, output_tokens: 50 },
      total_cost_usd: 0.01,
      num_turns: 1,
    };
    yield fakeMsg;
  };
  const realRunner = new AgentRunner(stub);
  // Replace `run` to capture inputs and synthesize the configured result.
  realRunner.run = vi.fn(async (input: AgentRunInput) => {
    agentInputs.push(input);
    const out =
      typeof opts.agentResult === 'function'
        ? opts.agentResult(input)
        : opts.agentResult ?? successResult;
    return out;
  });

  return {
    linear,
    workspace,
    agent: realRunner,
    events,
    agentInputs,
    workspaceCalls,
    get fetchCalls() {
      return fetchCalls;
    },
  } as Fakes;
}

describe('Orchestrator.tick — happy path', () => {
  it('dispatches each candidate up to the concurrency cap', async () => {
    const candidates = [
      makeIssue({ id: 'i1', identifier: 'CHR-1' }),
      makeIssue({ id: 'i2', identifier: 'CHR-2' }),
      makeIssue({ id: 'i3', identifier: 'CHR-3' }),
    ];
    const fakes = buildFakes({ candidates });

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'Issue {{ issue.identifier }}',
      config: makeConfig({ maxConcurrent: 2 }),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    expect(fakes.workspaceCalls).toEqual(['CHR-1', 'CHR-2']);
    expect(fakes.agentInputs).toHaveLength(2);
    expect(fakes.agentInputs[0]?.prompt).toBe('Issue CHR-1');
    expect(fakes.agentInputs[1]?.prompt).toBe('Issue CHR-2');
    expect(orchestrator.state.stateOf('i1')).toBe('completed');
    expect(orchestrator.state.stateOf('i2')).toBe('completed');
    expect(orchestrator.state.stateOf('i3')).toBe('idle');
  });

  it('emits dispatch_started and dispatch_completed events', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates });

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig({ maxConcurrent: 1 }),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    const types = fakes.events.map((e) => e.type);
    expect(types).toContain('tick_started');
    expect(types).toContain('dispatch_started');
    expect(types).toContain('dispatch_completed');
    expect(types).toContain('tick_completed');
  });

  it('does not redispatch a completed issue on a subsequent tick', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates });

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(fakes.workspaceCalls).toEqual(['CHR-1']);

    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(fakes.workspaceCalls).toEqual(['CHR-1']);
  });
});

describe('Orchestrator.tick — failure handling', () => {
  it('schedules a retry after a single failure', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const failResult: AgentRunResult = {
      exitReason: 'error',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: null,
      },
      durationMs: 5,
      finalText: '',
      numTurns: null,
      errorMessage: 'simulated',
    };
    const fakes = buildFakes({ candidates, agentResult: failResult });

    let nowMs = 1_000_000;
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
      now: () => nowMs,
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    expect(orchestrator.state.stateOf('i1')).toBe('retry_pending');
    expect(orchestrator.state.attemptCount('i1')).toBe(1);
    const scheduled = fakes.events.find((e) => e.type === 'retry_scheduled');
    expect(scheduled?.retryAt).toBe(nowMs + 30_000);
  });

  it('does not redispatch an issue still in retry cooldown', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const failResult: AgentRunResult = {
      exitReason: 'error',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: null,
      },
      durationMs: 5,
      finalText: '',
      numTurns: null,
      errorMessage: 'simulated',
    };
    const fakes = buildFakes({ candidates, agentResult: failResult });

    let nowMs = 1_000_000;
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
      now: () => nowMs,
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    nowMs += 5_000; // still inside the 30s cooldown
    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(fakes.workspaceCalls).toEqual(['CHR-1']);
    expect(fakes.events.filter((e) => e.type === 'retry_skipped').length).toBeGreaterThan(0);
  });

  it('redispatches once cooldown has elapsed and marks failed after the second failure', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const failResult: AgentRunResult = {
      exitReason: 'error',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: null,
      },
      durationMs: 5,
      finalText: '',
      numTurns: null,
      errorMessage: 'simulated',
    };
    const fakes = buildFakes({ candidates, agentResult: failResult });

    let nowMs = 1_000_000;
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
      now: () => nowMs,
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    nowMs += 31_000; // past the 30s cooldown
    await orchestrator.tick();
    await orchestrator.state.drain();

    expect(orchestrator.state.attemptCount('i1')).toBe(2);
    expect(orchestrator.state.stateOf('i1')).toBe('failed');
  });

  it('treats a workspace ensure failure as a dispatch failure', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates, workspaceFails: true });

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    expect(orchestrator.state.stateOf('i1')).toBe('retry_pending');
    expect(fakes.events.some((e) => e.type === 'dispatch_failed')).toBe(true);
  });

  it('emits tick_completed with an error message when Linear fetch throws', async () => {
    const fakes = buildFakes({ fetchError: new Error('rate limited') });
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    const tickEnd = fakes.events.find((e) => e.type === 'tick_completed');
    expect(tickEnd?.error).toMatch(/rate limited/);
    expect(fakes.workspaceCalls).toEqual([]);
  });
});

describe('Orchestrator lifecycle', () => {
  it('start drives at least one tick and stop drains in-flight work', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates });
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.start();
    await orchestrator.stop();

    expect(orchestrator.state.stateOf('i1')).toBe('completed');
    // Concurrency: one start should have triggered exactly one fetch tick (the next tick is queued via setTimeout but stop() cancels it).
    expect(fakes.fetchCalls).toBeGreaterThanOrEqual(1);
  });
});
