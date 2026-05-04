import { describe, expect, it, vi } from 'vitest';

import type { ClaudeConfig } from '../../src/config/schema.js';
import {
  AgentRunner,
  buildQueryOptions,
  type AgentRunInput,
  type AgentSdkMessage,
  type QueryFactory,
} from '../../src/agent/runner.js';

function defaultClaudeConfig(overrides: Partial<ClaudeConfig> = {}): ClaudeConfig {
  return {
    permission_mode: 'default',
    disallowed_tools: [],
    mcp_servers: { linear: { url: 'https://mcp.linear.app/mcp' } },
    system_prompt_append: '',
    turn_timeout_ms: 60_000,
    read_timeout_ms: 5_000,
    stall_timeout_ms: 30_000,
    max_turns: 1,
    enable_safety_hooks: true,
    ...overrides,
  };
}

function defaultInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    workspacePath: '/tmp/workspace/CHR-1',
    prompt: 'do the thing',
    config: defaultClaudeConfig(),
    ...overrides,
  };
}

async function* yieldMessages(messages: AgentSdkMessage[]): AsyncIterable<AgentSdkMessage> {
  for (const message of messages) {
    yield message;
  }
}

async function* yieldDelayed(
  steps: Array<{ delayMs: number; message?: AgentSdkMessage }>,
  signal?: AbortSignal,
): AsyncIterable<AgentSdkMessage> {
  for (const step of steps) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), step.delayMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    if (step.message) yield step.message;
  }
}

const SUCCESS_RESULT: AgentSdkMessage = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1234,
  num_turns: 1,
  result: 'Done.',
  total_cost_usd: 0.04,
  session_id: 'sess_default',
  usage: {
    input_tokens: 1000,
    output_tokens: 200,
    cache_creation_input_tokens: 50,
    cache_read_input_tokens: 0,
  },
};

describe('buildQueryOptions', () => {
  it('maps cwd, permissionMode, mcpServers, disallowedTools, maxTurns', () => {
    const abort = new AbortController();
    const opts = buildQueryOptions(
      defaultInput({
        config: defaultClaudeConfig({
          permission_mode: 'acceptEdits',
          disallowed_tools: ['Bash(rm:*)'],
          mcp_servers: { linear: { url: 'https://mcp.linear.app/mcp' } },
        }),
      }),
      abort,
    );
    expect(opts.cwd).toBe('/tmp/workspace/CHR-1');
    expect(opts.permissionMode).toBe('acceptEdits');
    expect(opts.disallowedTools).toEqual(['Bash(rm:*)']);
    expect(opts.mcpServers).toEqual({ linear: { url: 'https://mcp.linear.app/mcp' } });
    expect(opts.maxTurns).toBe(1);
    expect(opts.abortController).toBe(abort);
  });

  it('omits allowedTools and model when not configured', () => {
    const opts = buildQueryOptions(defaultInput(), new AbortController());
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.model).toBeUndefined();
  });

  it('passes allowedTools and model when configured', () => {
    const opts = buildQueryOptions(
      defaultInput({
        config: defaultClaudeConfig({ allowed_tools: ['Read', 'Edit'], model: 'claude-opus-4-7' }),
      }),
      new AbortController(),
    );
    expect(opts.allowedTools).toEqual(['Read', 'Edit']);
    expect(opts.model).toBe('claude-opus-4-7');
  });

  it('wraps system_prompt_append into a preset claude_code systemPrompt', () => {
    const opts = buildQueryOptions(
      defaultInput({
        config: defaultClaudeConfig({ system_prompt_append: 'Always cite spec sections.' }),
      }),
      new AbortController(),
    );
    expect(opts.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Always cite spec sections.',
    });
  });

  it('omits systemPrompt when system_prompt_append is empty', () => {
    const opts = buildQueryOptions(defaultInput(), new AbortController());
    expect(opts.systemPrompt).toBeUndefined();
  });

  it('sets allowDangerouslySkipPermissions=true when permissionMode is bypassPermissions', () => {
    const opts = buildQueryOptions(
      defaultInput({
        config: defaultClaudeConfig({ permission_mode: 'bypassPermissions' }),
      }),
      new AbortController(),
    );
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
  });

  it('omits allowDangerouslySkipPermissions for non-bypass permissionModes', () => {
    for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
      const opts = buildQueryOptions(
        defaultInput({ config: defaultClaudeConfig({ permission_mode: mode }) }),
        new AbortController(),
      );
      expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
    }
  });

  it('passes resume when AgentRunInput.resumeSessionId is set', () => {
    const opts = buildQueryOptions(
      defaultInput({ resumeSessionId: 'sess_abc123' }),
      new AbortController(),
    );
    expect(opts.resume).toBe('sess_abc123');
  });

  it('omits resume when AgentRunInput.resumeSessionId is unset', () => {
    const opts = buildQueryOptions(defaultInput(), new AbortController());
    expect(opts.resume).toBeUndefined();
  });
});

describe('AgentRunner.run — happy path', () => {
  it('returns completed with usage and final text from the result message', async () => {
    const queryFn: QueryFactory = vi.fn(async function* () {
      yield { type: 'assistant', text: 'thinking...' };
      yield SUCCESS_RESULT;
    } as unknown as QueryFactory);
    const runner = new AgentRunner(queryFn);
    const result = await runner.run(defaultInput());

    expect(result.exitReason).toBe('completed');
    expect(result.finalText).toBe('Done.');
    expect(result.numTurns).toBe(1);
    expect(result.sessionId).toBe('sess_default');
    expect(result.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 0,
      totalCostUsd: 0.04,
    });
    expect(result.errorMessage).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures session_id from the system init message even if result lacks it', async () => {
    const queryFn: QueryFactory = vi.fn(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess_init_xyz' };
      yield { ...SUCCESS_RESULT, session_id: undefined } as AgentSdkMessage;
    } as unknown as QueryFactory);
    const runner = new AgentRunner(queryFn);
    const result = await runner.run(defaultInput());
    expect(result.sessionId).toBe('sess_init_xyz');
  });

  it('keeps the first session_id seen if multiple messages carry one', async () => {
    const queryFn: QueryFactory = vi.fn(async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess_first' };
      yield { ...SUCCESS_RESULT, session_id: 'sess_second' } as AgentSdkMessage;
    } as unknown as QueryFactory);
    const runner = new AgentRunner(queryFn);
    const result = await runner.run(defaultInput());
    expect(result.sessionId).toBe('sess_first');
  });

  it('forwards prompt and options to the query factory', async () => {
    const queryFn = vi.fn<QueryFactory>(() => yieldMessages([SUCCESS_RESULT]));
    const runner = new AgentRunner(queryFn);
    await runner.run(defaultInput({ prompt: 'go!' }));

    expect(queryFn).toHaveBeenCalledTimes(1);
    const args = queryFn.mock.calls[0];
    expect(args).toBeDefined();
    const params = args![0]!;
    expect(params.prompt).toBe('go!');
    expect(params.options?.cwd).toBe('/tmp/workspace/CHR-1');
  });
});

describe('AgentRunner.run — failure paths', () => {
  it('maps result.subtype="error_max_turns" to exitReason=error', async () => {
    const queryFn = vi.fn(() =>
      yieldMessages([{ ...SUCCESS_RESULT, subtype: 'error_max_turns' }]),
    );
    const runner = new AgentRunner(queryFn as unknown as QueryFactory);
    const result = await runner.run(defaultInput());
    expect(result.exitReason).toBe('error');
    expect(result.errorMessage).toMatch(/error_max_turns/);
  });

  it('returns error when stream ends without a result terminator', async () => {
    const queryFn = vi.fn(() =>
      yieldMessages([{ type: 'assistant', text: 'started but never finished' }]),
    );
    const runner = new AgentRunner(queryFn as unknown as QueryFactory);
    const result = await runner.run(defaultInput());
    expect(result.exitReason).toBe('error');
    expect(result.errorMessage).toMatch(/result message/);
  });

  it('returns error when the query factory throws', async () => {
    const queryFn = vi.fn(() => {
      throw new Error('SDK connection refused');
    });
    const runner = new AgentRunner(queryFn as unknown as QueryFactory);
    const result = await runner.run(defaultInput());
    expect(result.exitReason).toBe('error');
    expect(result.errorMessage).toBe('SDK connection refused');
  });
});

describe('AgentRunner.run — timeouts and abort', () => {
  it('hits turn_timeout when the run exceeds turn_timeout_ms', async () => {
    const queryFn: QueryFactory = (params) => {
      const signal = params.options?.abortController?.signal;
      // Sleep longer than the configured turn_timeout, dropping no messages.
      return yieldDelayed(
        [{ delayMs: 500, message: SUCCESS_RESULT }],
        signal,
      );
    };
    const runner = new AgentRunner(queryFn);
    const result = await runner.run(
      defaultInput({
        config: defaultClaudeConfig({
          turn_timeout_ms: 60,
          stall_timeout_ms: 0,
        }),
      }),
    );
    expect(result.exitReason).toBe('turn_timeout');
    expect(result.errorMessage).toMatch(/turn_timeout_ms=60/);
  });

  it('hits stall_timeout when no messages arrive for stall_timeout_ms', async () => {
    const queryFn: QueryFactory = (params) => {
      const signal = params.options?.abortController?.signal;
      return yieldDelayed(
        [{ delayMs: 500, message: SUCCESS_RESULT }],
        signal,
      );
    };
    const runner = new AgentRunner(queryFn);
    const result = await runner.run(
      defaultInput({
        config: defaultClaudeConfig({
          turn_timeout_ms: 60_000,
          stall_timeout_ms: 50,
        }),
      }),
    );
    expect(result.exitReason).toBe('stall_timeout');
    expect(result.errorMessage).toMatch(/stall_timeout_ms=50/);
  });

  it('respects an external abort signal', async () => {
    const queryFn: QueryFactory = (params) => {
      const signal = params.options?.abortController?.signal;
      return yieldDelayed(
        [{ delayMs: 500, message: SUCCESS_RESULT }],
        signal,
      );
    };
    const runner = new AgentRunner(queryFn);
    const externalAbort = new AbortController();
    setTimeout(() => externalAbort.abort(), 30);
    const result = await runner.run(defaultInput({ externalAbort: externalAbort.signal }));
    expect(result.exitReason).toBe('aborted_externally');
  });
});
