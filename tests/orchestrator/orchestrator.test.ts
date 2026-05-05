import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  Orchestrator,
  isBlocked,
  sortCandidates,
  type OrchestratorEvent,
} from '../../src/orchestrator/orchestrator.js';

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

function makeConfig(overrides?: {
  maxConcurrent?: number;
  hooks?: { before_run?: string; after_run?: string };
}): ResolvedWorkflowConfig {
  const cfg = parseWorkflowConfig({
    tracker: { kind: 'linear', project_slug: 'chronicle' },
    workspace: { root: '/tmp/workspaces' },
    polling: { interval_ms: 5_000 },
    agent: { max_concurrent_agents: overrides?.maxConcurrent ?? 2 },
    ...(overrides?.hooks ? { hooks: overrides.hooks } : {}),
    claude: {
      mcp_servers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
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
  /** Mutable state-by-identifier: tests can flip a ticket terminal between dispatches. */
  linearStates: Map<string, string>;
}

function buildFakes(opts: {
  candidates?: Issue[];
  fetchError?: Error;
  agentResult?: AgentRunResult | ((input: AgentRunInput) => AgentRunResult);
  workspaceFails?: boolean;
  /** Override per-identifier behaviour for fetchIssueByIdentifier. */
  refreshError?: Error;
  /**
   * If set, every successful dispatch transitions that issue's Linear state
   * to this value (simulating the agent moving the ticket terminal). Most
   * happy-path tests use 'Done' here so the orchestrator marks completed.
   * Tests that want to exercise the continuation path leave it undefined.
   */
  postSuccessLinearState?: string;
}): Fakes {
  const events: OrchestratorEvent[] = [];
  const agentInputs: AgentRunInput[] = [];
  const workspaceCalls: string[] = [];
  let fetchCalls = 0;
  // Initial state seeded from the candidate list — every candidate starts in
  // its `state` field (typically "Todo"). Tests mutate this map to simulate
  // an agent moving the issue out of active states.
  const linearStates = new Map<string, string>(
    (opts.candidates ?? []).map((c) => [c.identifier, c.state]),
  );

  const linear: LinearGateway = {
    fetchActiveCandidates: vi.fn(async () => {
      fetchCalls += 1;
      if (opts.fetchError) throw opts.fetchError;
      return opts.candidates ?? [];
    }),
    fetchIssueByIdentifier: vi.fn(async (identifier: string) => {
      if (opts.refreshError) throw opts.refreshError;
      const state = linearStates.get(identifier);
      if (state === undefined) return null;
      const original = (opts.candidates ?? []).find((c) => c.identifier === identifier);
      if (!original) return null;
      return { ...original, state };
    }),
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
    sessionId: 'sess_default',
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
    if (out.exitReason === 'completed' && opts.postSuccessLinearState !== undefined) {
      // Simulate the agent moving the Linear ticket. The orchestrator's
      // post-success Linear refresh will see the new state.
      const identifier = path.basename(input.workspacePath);
      linearStates.set(identifier, opts.postSuccessLinearState);
    }
    return out;
  });

  return {
    linear,
    workspace,
    agent: realRunner,
    events,
    agentInputs,
    workspaceCalls,
    linearStates,
    get fetchCalls() {
      return fetchCalls;
    },
  } as Fakes;
}

describe('Orchestrator.tick — happy path (agent completes work, Linear leaves active)', () => {
  it('dispatches each candidate up to the concurrency cap', async () => {
    const candidates = [
      makeIssue({ id: 'i1', identifier: 'CHR-1' }),
      makeIssue({ id: 'i2', identifier: 'CHR-2' }),
      makeIssue({ id: 'i3', identifier: 'CHR-3' }),
    ];
    const fakes = buildFakes({ candidates, postSuccessLinearState: 'Done' });

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

  it('emits dispatch_started and dispatch_completed events when Linear state moves terminal', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates, postSuccessLinearState: 'Done' });

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
    expect(types).not.toContain('continuation_scheduled');
  });

  it('does not redispatch an issue once Linear is terminal on subsequent ticks', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates, postSuccessLinearState: 'Done' });

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
    expect(orchestrator.state.stateOf('i1')).toBe('completed');

    // Second tick — still the same candidate would come back from Linear in
    // this stub, but orchestrator's in-memory state remembers it's completed.
    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(fakes.workspaceCalls).toEqual(['CHR-1']);
  });
});

describe('Orchestrator.tick — Symphony continuation semantics', () => {
  it('redispatches when agent succeeds but Linear state remains active', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    // No postSuccessLinearState → agent does NOT move the ticket → Linear
    // stays in "Todo" → orchestrator should requeue for continuation.
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

    expect(orchestrator.state.stateOf('i1')).toBe('idle');
    const cont = fakes.events.find((e) => e.type === 'continuation_scheduled');
    expect(cont).toBeDefined();
    expect(cont?.linearStateAfterRun).toBe('Todo');

    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(fakes.workspaceCalls).toEqual(['CHR-1', 'CHR-1']);
    expect(orchestrator.state.attemptCount('i1')).toBe(2);
  });

  it('marks completed once the agent moves the issue to a terminal state on a later attempt', async () => {
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
    expect(orchestrator.state.stateOf('i1')).toBe('idle');

    // Second attempt: caller flips Linear state mid-run via the test hook.
    fakes.linearStates.set('CHR-1', 'Done');
    // The agent fn doesn't override after each call here; we just preset
    // the new state so the post-success refresh observes it.
    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(orchestrator.state.stateOf('i1')).toBe('completed');
  });

  it('marks failed after MAX_DISPATCHES (10) without leaving active states', async () => {
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

    for (let i = 0; i < 10; i += 1) {
      await orchestrator.tick();
      await orchestrator.state.drain();
    }

    expect(orchestrator.state.stateOf('i1')).toBe('failed');
    const finalFail = fakes.events
      .filter((e) => e.type === 'dispatch_failed')
      .pop();
    expect(finalFail?.error).toMatch(/still in active state.*after 10 dispatches/);
  });

  it('captures session_id on first dispatch and passes it as resumeSessionId on the continuation', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates });

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'first-prompt {{ issue.identifier }}',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();
    await orchestrator.tick();
    await orchestrator.state.drain();

    expect(fakes.agentInputs).toHaveLength(2);
    // First dispatch has no resume id and uses the rendered template.
    expect(fakes.agentInputs[0]?.resumeSessionId).toBeUndefined();
    expect(fakes.agentInputs[0]?.prompt).toBe('first-prompt CHR-1');
    // Second dispatch resumes the session captured from the first.
    expect(fakes.agentInputs[1]?.resumeSessionId).toBe('sess_default');
    expect(fakes.agentInputs[1]?.prompt).toMatch(/Continuing work on CHR-1/);
    expect(fakes.agentInputs[1]?.prompt).toMatch(/dispatch attempt #2/);
  });

  it('aborts the in-flight agent when Linear state goes terminal mid-run', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    let abortObserved = false;
    // Slow agent that yields control briefly so reconcile can run while the
    // dispatch is in flight.
    const slowAgent = (input: AgentRunInput): AgentRunResult => {
      // Caller actually awaits this synchronously via vi.fn — we need an
      // async runner here to give reconcile a chance. Build via a custom
      // queryFn instead.
      void input;
      return {
        exitReason: 'aborted_externally',
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
        errorMessage: null,
        sessionId: null,
      };
    };
    const fakes = buildFakes({ candidates, agentResult: slowAgent });
    // Wrap the runner so we capture whether the externalAbort signal was
    // ever raised before the run "completed".
    fakes.agent.run = vi.fn(async (input: AgentRunInput) => {
      // Simulate a long-running agent: wait until reconcile aborts us.
      await new Promise<void>((resolve) => {
        const sig = input.externalAbort;
        if (sig?.aborted) {
          abortObserved = true;
          resolve();
          return;
        }
        sig?.addEventListener(
          'abort',
          () => {
            abortObserved = true;
            resolve();
          },
          { once: true },
        );
      });
      return slowAgent(input);
    });

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig(),
      onEvent: (e) => fakes.events.push(e),
    });

    // Tick 1: dispatches CHR-1; the slow agent registers inflight and
    // blocks waiting for an abort. Linear state is still 'Todo', so the
    // reconcile pass at the end of tick 1 sees nothing to abort.
    await orchestrator.tick();
    expect(orchestrator.state.inflightFor('i1')).not.toBeNull();

    // Operator moves Linear to Cancelled while the agent is still working.
    fakes.linearStates.set('CHR-1', 'Cancelled');

    // Tick 2: reconcile now sees the terminal state and aborts the inflight.
    // The aborted dispatch resolves, drain returns, and the issue is marked
    // completed (the agent's responsibility ended when the operator cancelled).
    await orchestrator.tick();
    await orchestrator.state.drain();

    expect(abortObserved).toBe(true);
    expect(orchestrator.state.stateOf('i1')).toBe('completed');
    const reconcile = fakes.events.find((e) => e.type === 'reconcile_aborted');
    expect(reconcile).toBeDefined();
    expect(reconcile?.linearStateAfterRun).toBe('Cancelled');
  });

  it('clears the captured session_id when the issue reaches a terminal state', async () => {
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
    expect(orchestrator.state.sessionIdFor('i1')).toBe('sess_default');

    fakes.linearStates.set('CHR-1', 'Done');
    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(orchestrator.state.stateOf('i1')).toBe('completed');
    expect(orchestrator.state.sessionIdFor('i1')).toBeNull();
  });

  it('routes incomplete_turns (error_max_turns) through the success path, not failure (Phase 3 P1)', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const incompleteResult: AgentRunResult = {
      exitReason: 'incomplete_turns',
      usage: {
        inputTokens: 100,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        totalCostUsd: 0.05,
      },
      durationMs: 60_000,
      finalText: 'partial',
      numTurns: 20,
      errorMessage: null,
      sessionId: 'sess_partial',
    };
    const fakes = buildFakes({ candidates, agentResult: incompleteResult });

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

    // Linear state stayed Todo (the agent didn't transition). incomplete_turns
    // → handleSuccess → still active → continuation_scheduled, NOT a failure.
    expect(orchestrator.state.stateOf('i1')).toBe('idle');
    expect(orchestrator.state.failureCount('i1')).toBe(0);
    const types = fakes.events.map((e) => e.type);
    expect(types).toContain('continuation_scheduled');
    expect(types).not.toContain('dispatch_failed');
    expect(types).not.toContain('retry_scheduled');
  });

  it('falls back to completed when the post-success Linear refresh fails', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates, refreshError: new Error('linear unreachable') });

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

    expect(orchestrator.state.stateOf('i1')).toBe('completed');
    const completedEvent = fakes.events.find((e) => e.type === 'dispatch_completed');
    expect(completedEvent?.error).toMatch(/linear refresh failed/);
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
      sessionId: null,
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
      sessionId: null,
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

  it('uses exponential backoff and marks failed after MAX_FAILURE_ATTEMPTS consecutive failures', async () => {
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
      sessionId: null,
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

    // 5 consecutive failures expected. Backoff schedule: 30s, 2m, 8m, 30m,
    // then markFailed without scheduling a 5th retry.
    const expectedDelaysMs = [30_000, 2 * 60_000, 8 * 60_000, 30 * 60_000];

    for (let i = 0; i < 4; i += 1) {
      await orchestrator.tick();
      await orchestrator.state.drain();
      const last = fakes.events.filter((e) => e.type === 'retry_scheduled').pop();
      expect(last).toBeDefined();
      expect(last!.retryAt! - nowMs).toBe(expectedDelaysMs[i]);
      nowMs = last!.retryAt!; // jump past cooldown
    }

    // The 5th tick is the final dispatch; after it fails we should be in
    // 'failed' rather than retry_pending.
    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(orchestrator.state.stateOf('i1')).toBe('failed');
    expect(orchestrator.state.attemptCount('i1')).toBe(5);
  });

  it('resets the failure backoff on a successful continuation', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates });
    let runCount = 0;
    fakes.agent.run = vi.fn(async (_input: AgentRunInput): Promise<AgentRunResult> => {
      runCount += 1;
      // Fail once, then succeed (still active → continuation), then fail again.
      if (runCount === 1 || runCount === 3) {
        return {
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
          errorMessage: 'sim',
          sessionId: null,
        };
      }
      return {
        exitReason: 'completed',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          totalCostUsd: 0,
        },
        durationMs: 5,
        finalText: '',
        numTurns: 1,
        errorMessage: null,
        sessionId: `s-${runCount}`,
      };
    });

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

    // Tick 1 — failure 1, retry scheduled with 30s delay.
    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(orchestrator.state.failureCount('i1')).toBe(1);
    nowMs += 31_000;

    // Tick 2 — success-still-active, continuation. failureCount should reset.
    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(orchestrator.state.failureCount('i1')).toBe(0);

    // Tick 3 — failure 2 in lifetime, but 1st in this streak: should use
    // the 30s delay again, NOT the 2-minute delay.
    await orchestrator.tick();
    await orchestrator.state.drain();
    const lastRetry = fakes.events.filter((e) => e.type === 'retry_scheduled').pop();
    expect(lastRetry).toBeDefined();
    expect(lastRetry!.retryAt! - nowMs).toBe(30_000);
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

describe('sortCandidates', () => {
  it('orders by priority asc, then created_at asc, then identifier', () => {
    const result = sortCandidates([
      makeIssue({ id: 'i3', identifier: 'CHR-3', priority: 2, createdAt: '2026-04-01T00:00:00Z' }),
      makeIssue({ id: 'i1', identifier: 'CHR-1', priority: 1, createdAt: '2026-04-02T00:00:00Z' }),
      makeIssue({ id: 'i4', identifier: 'CHR-4', priority: null, createdAt: '2026-04-01T00:00:00Z' }),
      makeIssue({ id: 'i2', identifier: 'CHR-2', priority: 1, createdAt: '2026-04-01T00:00:00Z' }),
    ]);
    expect(result.map((i) => i.identifier)).toEqual(['CHR-2', 'CHR-1', 'CHR-3', 'CHR-4']);
  });

  it('places null createdAt after dated ones', () => {
    const result = sortCandidates([
      makeIssue({ id: 'a', identifier: 'CHR-A', priority: 1, createdAt: null }),
      makeIssue({ id: 'b', identifier: 'CHR-B', priority: 1, createdAt: '2026-04-01T00:00:00Z' }),
    ]);
    expect(result.map((i) => i.identifier)).toEqual(['CHR-B', 'CHR-A']);
  });
});

describe('isBlocked', () => {
  const TERMINAL = new Set(['Done', 'Cancelled']);

  it('does not gate non-Todo issues even with non-terminal blockers', () => {
    const issue = makeIssue({
      id: 'a',
      identifier: 'CHR-A',
      state: 'In Progress',
      blockedBy: [{ id: 'x', identifier: 'CHR-X', state: 'Todo' }],
    });
    expect(isBlocked(issue, TERMINAL)).toBe(false);
  });

  it('gates Todo issues with at least one non-terminal blocker', () => {
    const issue = makeIssue({
      id: 'a',
      identifier: 'CHR-A',
      state: 'Todo',
      blockedBy: [
        { id: 'x', identifier: 'CHR-X', state: 'Done' },
        { id: 'y', identifier: 'CHR-Y', state: 'Todo' },
      ],
    });
    expect(isBlocked(issue, TERMINAL)).toBe(true);
  });

  it('does not gate Todo issues whose blockers are all terminal', () => {
    const issue = makeIssue({
      id: 'a',
      identifier: 'CHR-A',
      state: 'Todo',
      blockedBy: [
        { id: 'x', identifier: 'CHR-X', state: 'Done' },
        { id: 'y', identifier: 'CHR-Y', state: 'Cancelled' },
      ],
    });
    expect(isBlocked(issue, TERMINAL)).toBe(false);
  });

  it('fails safe (treated as blocked) when a blocker has unknown state', () => {
    const issue = makeIssue({
      id: 'a',
      identifier: 'CHR-A',
      state: 'Todo',
      blockedBy: [{ id: 'x', identifier: 'CHR-X', state: null }],
    });
    expect(isBlocked(issue, TERMINAL)).toBe(true);
  });
});

describe('Orchestrator.tick — blocker gate + sort integration', () => {
  it('dispatches in priority/createdAt order and skips a blocked Todo', async () => {
    const candidates = [
      makeIssue({
        id: 'low',
        identifier: 'CHR-LOW',
        state: 'Todo',
        priority: 3,
        createdAt: '2026-04-01T00:00:00Z',
      }),
      makeIssue({
        id: 'blk',
        identifier: 'CHR-BLK',
        state: 'Todo',
        priority: 1,
        createdAt: '2026-04-01T00:00:00Z',
        blockedBy: [{ id: 'b', identifier: 'CHR-B', state: 'Todo' }],
      }),
      makeIssue({
        id: 'top',
        identifier: 'CHR-TOP',
        state: 'Todo',
        priority: 2,
        createdAt: '2026-04-01T00:00:00Z',
      }),
    ];
    const fakes = buildFakes({ candidates, postSuccessLinearState: 'Done' });

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig({ maxConcurrent: 5 }),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    // Blocked Todo dropped; remaining sorted by priority: TOP (2) then LOW (3).
    expect(fakes.workspaceCalls).toEqual(['CHR-TOP', 'CHR-LOW']);
  });
});

describe('Orchestrator lifecycle hooks (before_run / after_run)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-'));
    // The fake workspace manager points each issue at <root>/<identifier>;
    // create that dir so the lifecycle hooks have a valid cwd.
    await fs.mkdir(path.join(workspaceRoot, 'CHR-1'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('runs before_run before agent dispatch and after_run after, in workspace cwd', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates, postSuccessLinearState: 'Done' });
    // Override workspace fake to use the real tempdir per identifier.
    (fakes.workspace as unknown as { pathFor: (i: string) => string }).pathFor = (
      identifier: string,
    ) => path.join(workspaceRoot, identifier);
    (fakes.workspace as unknown as { ensureWorkspace: typeof fakes.workspace.ensureWorkspace }).ensureWorkspace = vi.fn(
      async (issue: Issue) => ({
        path: path.join(workspaceRoot, issue.identifier),
        created: true,
        hookResult: null,
      }),
    );

    const beforeMarker = path.join(workspaceRoot, 'CHR-1', 'before-ran');
    const afterMarker = path.join(workspaceRoot, 'CHR-1', 'after-ran');

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig({
        hooks: {
          before_run: `touch '${beforeMarker}'`,
          after_run: `touch '${afterMarker}'`,
        },
      }),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();

    expect(await fs.stat(beforeMarker).then((s) => s.isFile())).toBe(true);
    expect(await fs.stat(afterMarker).then((s) => s.isFile())).toBe(true);
  });

  it('runs after_run even when the agent fails', async () => {
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
      errorMessage: 'sim',
      sessionId: null,
    };
    const fakes = buildFakes({ candidates, agentResult: failResult });
    (fakes.workspace as unknown as { pathFor: (i: string) => string }).pathFor = (
      identifier: string,
    ) => path.join(workspaceRoot, identifier);
    (fakes.workspace as unknown as { ensureWorkspace: typeof fakes.workspace.ensureWorkspace }).ensureWorkspace = vi.fn(
      async (issue: Issue) => ({
        path: path.join(workspaceRoot, issue.identifier),
        created: true,
        hookResult: null,
      }),
    );

    const afterMarker = path.join(workspaceRoot, 'CHR-1', 'after-ran-after-fail');

    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: makeConfig({
        hooks: { after_run: `touch '${afterMarker}'` },
      }),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.tick();
    await orchestrator.state.drain();
    expect(await fs.stat(afterMarker).then((s) => s.isFile())).toBe(true);
  });
});

describe('Orchestrator startup recovery', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recover-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  function configWithRoot(root: string) {
    const cfg = parseWorkflowConfig({
      tracker: { kind: 'linear', project_slug: 'chronicle' },
      workspace: { root },
      polling: { interval_ms: 5_000 },
      agent: { max_concurrent_agents: 1 },
      claude: { mcp_servers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } },
    });
    return resolveConfig(cfg, { LINEAR_API_KEY: 'lin_test' });
  }

  it('emits startup_recovery with no identifiers when the workspace root is empty', async () => {
    const fakes = buildFakes({ candidates: [] });
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: configWithRoot(workspaceRoot),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.start();
    await orchestrator.stop();

    const recovery = fakes.events.find((e) => e.type === 'startup_recovery');
    expect(recovery).toBeDefined();
    expect(recovery?.recoveredIssueIdentifiers).toEqual([]);
  });

  it('emits startup_recovery listing existing per-issue worktree dirs', async () => {
    await fs.mkdir(path.join(workspaceRoot, 'CHR-1'));
    await fs.mkdir(path.join(workspaceRoot, 'CHR-7'));
    await fs.mkdir(path.join(workspaceRoot, 'not-an-issue-dir'));
    await fs.writeFile(path.join(workspaceRoot, 'README'), 'x');

    const fakes = buildFakes({ candidates: [] });
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: configWithRoot(workspaceRoot),
      onEvent: (e) => fakes.events.push(e),
    });

    await orchestrator.start();
    await orchestrator.stop();

    const recovery = fakes.events.find((e) => e.type === 'startup_recovery');
    expect(recovery?.recoveredIssueIdentifiers).toEqual(['CHR-1', 'CHR-7']);
  });

  it('survives a missing workspace root without throwing', async () => {
    const fakes = buildFakes({ candidates: [] });
    const orchestrator = new Orchestrator({
      linear: fakes.linear,
      workspace: fakes.workspace,
      agent: fakes.agent,
      promptTemplate: 'p',
      config: configWithRoot(path.join(workspaceRoot, 'does-not-exist')),
      onEvent: (e) => fakes.events.push(e),
    });

    await expect(orchestrator.start()).resolves.toBeUndefined();
    await orchestrator.stop();
  });
});

describe('Orchestrator lifecycle', () => {
  it('start drives at least one tick and stop drains in-flight work', async () => {
    const candidates = [makeIssue({ id: 'i1', identifier: 'CHR-1' })];
    const fakes = buildFakes({ candidates, postSuccessLinearState: 'Done' });
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
