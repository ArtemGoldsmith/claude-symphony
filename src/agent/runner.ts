// SPEC.md §3.1.6 + §10 + §13.5 — Agent Runner over @anthropic-ai/claude-agent-sdk.
// PARITY.md rows: §3.1.6, §10.* (deviation), §13.5.
// Deviations: SPEC-claude.md §A — Codex protocol replaced wholesale by SDK query().

import type { ClaudeConfig } from '../config/schema.js';

/**
 * Subset of `@anthropic-ai/claude-agent-sdk` SDKMessage we actually consume.
 * The full union is huge and unstable in places; we only need to read the
 * `result` terminator and recognise that any other message represents stream
 * activity (for stall detection).
 */
export interface SdkResultMessage {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | string;
  duration_ms?: number;
  num_turns?: number;
  result?: string;
  total_cost_usd?: number;
  session_id?: string;
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface SdkInitSystemMessage {
  type: 'system';
  subtype: 'init';
  session_id?: string;
}

export type AgentSdkMessage =
  | SdkResultMessage
  | SdkInitSystemMessage
  | { type: 'assistant' | 'user' | 'system' | string; [k: string]: unknown };

/**
 * Options accepted by claude-agent-sdk's query(). Re-declared narrowly to
 * keep the runner free of the SDK's private types in our module surface.
 */
export interface QueryOptions {
  cwd?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  /**
   * REQUIRED when permissionMode === 'bypassPermissions' (the SDK rejects
   * the option otherwise). Caller (buildQueryOptions) sets this conditionally.
   */
  allowDangerouslySkipPermissions?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  model?: string;
  maxTurns?: number;
  abortController?: AbortController;
  /**
   * SDK session id to resume. The next query() loads the full conversation
   * history from that session and continues, sharing the same on-disk
   * transcript file (cwd-local). See SPEC-claude.md §C / Codex review B1.
   */
  resume?: string;
  /** Forwarded to claude-agent-sdk so we can capture subprocess stderr. */
  stderr?: (data: string) => void;
  systemPrompt?:
    | string
    | string[]
    | { type: 'preset'; preset: 'claude_code'; append?: string };
}

/**
 * Function shape we drive the SDK through. The real binding wires this to
 * `import { query } from '@anthropic-ai/claude-agent-sdk'`. Tests substitute
 * a fake that yields a scripted message sequence.
 */
export type QueryFactory = (params: {
  prompt: string;
  options?: QueryOptions;
}) => AsyncIterable<AgentSdkMessage>;

export type ExitReason =
  | 'completed'
  | 'error'
  | 'turn_timeout'
  | 'stall_timeout'
  | 'aborted_externally';

export interface AggregatedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalCostUsd: number | null;
}

export interface AgentRunInput {
  workspacePath: string;
  prompt: string;
  config: ClaudeConfig;
  /**
   * Optional external abort signal. If aborted, exitReason becomes
   * 'aborted_externally'. Independent from the runner's own timeout abort.
   */
  externalAbort?: AbortSignal;
  /**
   * Optional callback receiving the subprocess's stderr lines, useful for
   * surfacing SDK-side failure modes (auth errors, MCP misconfiguration,
   * etc.) to the orchestrator log.
   */
  onStderr?: (chunk: string) => void;
  /**
   * If set, the runner asks the SDK to resume this prior session id rather
   * than starting fresh. Used by the orchestrator on continuation dispatches
   * (post-success-but-issue-still-active) so the agent keeps its prior
   * context instead of re-discovering everything from scratch.
   */
  resumeSessionId?: string;
}

export interface AgentRunResult {
  exitReason: ExitReason;
  usage: AggregatedUsage;
  durationMs: number;
  finalText: string;
  /** SDK-reported number of turns the model took. Null when not reported. */
  numTurns: number | null;
  /** Set when exitReason is 'error' or a timeout. */
  errorMessage: string | null;
  /**
   * SDK session id captured from the init/result message stream. May be
   * null if the SDK never emitted one (some failure paths). Persist on the
   * orchestrator for use as `resumeSessionId` on the next dispatch.
   */
  sessionId: string | null;
}

const ZERO_USAGE: AggregatedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalCostUsd: null,
};

/**
 * Translate our `claude:` config block into the SDK's QueryOptions shape.
 * Keeps the runner pure and lets us unit-test the mapping without an SDK.
 */
export function buildQueryOptions(input: AgentRunInput, abort: AbortController): QueryOptions {
  const cfg = input.config;
  const opts: QueryOptions = {
    cwd: input.workspacePath,
    permissionMode: cfg.permission_mode,
    disallowedTools: cfg.disallowed_tools,
    mcpServers: cfg.mcp_servers,
    maxTurns: cfg.max_turns,
    abortController: abort,
  };
  if (input.onStderr) {
    opts.stderr = input.onStderr;
  }
  if (input.resumeSessionId) {
    opts.resume = input.resumeSessionId;
  }
  // SDK requires this flag alongside permissionMode 'bypassPermissions'.
  // Without it the wrapper validation rejects the configuration before any
  // SDK call goes out.
  if (cfg.permission_mode === 'bypassPermissions') {
    opts.allowDangerouslySkipPermissions = true;
  }
  if (cfg.allowed_tools !== undefined) {
    opts.allowedTools = cfg.allowed_tools;
  }
  if (cfg.model !== undefined) {
    opts.model = cfg.model;
  }
  if (cfg.system_prompt_append.length > 0) {
    opts.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: cfg.system_prompt_append,
    };
  }
  return opts;
}

/**
 * Drive a single agent dispatch. Streams SDK messages until a result
 * terminator arrives, an external signal aborts, the wall-clock turn
 * timeout fires, or the stall timeout fires (no message activity for
 * `stall_timeout_ms`).
 */
export class AgentRunner {
  constructor(private readonly queryFn: QueryFactory) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const { config } = input;
    const start = Date.now();
    const abort = new AbortController();
    let exitReason: ExitReason | null = null;
    let errorMessage: string | null = null;

    const externalAbortHandler = () => {
      if (exitReason === null) {
        exitReason = 'aborted_externally';
        abort.abort();
      }
    };
    if (input.externalAbort) {
      if (input.externalAbort.aborted) externalAbortHandler();
      else input.externalAbort.addEventListener('abort', externalAbortHandler, { once: true });
    }

    const turnTimer = setTimeout(() => {
      if (exitReason === null) {
        exitReason = 'turn_timeout';
        errorMessage = `turn exceeded turn_timeout_ms=${config.turn_timeout_ms}`;
        abort.abort();
      }
    }, config.turn_timeout_ms);

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStallTimer = () => {
      if (config.stall_timeout_ms <= 0) return;
      if (stallTimer !== null) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (exitReason === null) {
          exitReason = 'stall_timeout';
          errorMessage = `no SDK activity for stall_timeout_ms=${config.stall_timeout_ms}`;
          abort.abort();
        }
      }, config.stall_timeout_ms);
    };
    armStallTimer();

    let finalText = '';
    let numTurns: number | null = null;
    let usage = ZERO_USAGE;
    let sessionId: string | null = null;

    try {
      const stream = this.queryFn({
        prompt: input.prompt,
        options: buildQueryOptions(input, abort),
      });

      for await (const message of stream) {
        armStallTimer();

        // Capture session_id from whichever message exposes it first.
        // Init system messages emit it eagerly; the result message also
        // carries it, so this works for both happy and abort paths.
        if (sessionId === null) {
          const sid = (message as { session_id?: unknown }).session_id;
          if (typeof sid === 'string' && sid.length > 0) {
            sessionId = sid;
          }
        }

        if (isResultMessage(message)) {
          finalText = message.result ?? '';
          numTurns = message.num_turns ?? null;
          usage = aggregateUsage(message);
          if (message.subtype === 'success') {
            if (exitReason === null) exitReason = 'completed';
          } else {
            if (exitReason === null) {
              exitReason = 'error';
              errorMessage = `SDK reported result subtype "${message.subtype}"`;
            }
          }
          break;
        }
      }
    } catch (err) {
      if (exitReason === null) {
        exitReason = 'error';
        errorMessage = (err as Error).message;
      }
    } finally {
      clearTimeout(turnTimer);
      if (stallTimer !== null) clearTimeout(stallTimer);
      if (input.externalAbort) {
        input.externalAbort.removeEventListener('abort', externalAbortHandler);
      }
    }

    if (exitReason === null) {
      // Stream ended without a result terminator. Treat as error.
      exitReason = 'error';
      errorMessage = errorMessage ?? 'agent stream ended without a result message';
    }

    return {
      exitReason,
      usage,
      durationMs: Date.now() - start,
      finalText,
      numTurns,
      errorMessage,
      sessionId,
    };
  }
}

function isResultMessage(message: AgentSdkMessage): message is SdkResultMessage {
  return message.type === 'result';
}

function aggregateUsage(message: SdkResultMessage): AggregatedUsage {
  const u = message.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    totalCostUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
  };
}

/**
 * Default queryFactory backed by the real SDK. Imported lazily so unit tests
 * can avoid loading the SDK's heavy dependency graph.
 */
export async function createSdkQueryFactory(): Promise<QueryFactory> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  // The SDK's Options.mcpServers expects a typed McpServerConfig union; we
  // accept Record<string, unknown> at the WORKFLOW.md boundary (the user's
  // YAML drives this). Trust the user's configuration and pass through.
  return ((params: { prompt: string; options?: QueryOptions }) =>
    sdk.query(params as unknown as Parameters<typeof sdk.query>[0])) as QueryFactory;
}
