// SPEC.md §3.1.2 + §4.1.3 + §5.3 + §6 — Config Layer (typed view of WORKFLOW.md front matter).
// PARITY.md rows: §3.1.2, §4.1.3, §5.3.1–§5.3.5, §5.3.6 (deviation), §6.4.
// Deviations: SPEC-claude.md §B — `codex:` block replaced by `claude:` block.
//
// Unknown keys at any level are silently dropped, matching the spec's
// forward-compatibility guidance ("Unknown keys SHOULD be ignored").

import { z } from 'zod';

const NonEmptyString = z.string().min(1);

export const TrackerConfigSchema = z.object({
  kind: z.literal('linear'),
  project_slug: NonEmptyString,
  active_states: z.array(NonEmptyString).min(1).default(['Todo', 'In Progress']),
  terminal_states: z
    .array(NonEmptyString)
    .min(1)
    .default(['Done', 'Cancelled', 'Canceled', 'Closed', 'Duplicate']),
  // Optional. When unset, or when literally "$LINEAR_API_KEY", the resolver
  // reads from process.env.LINEAR_API_KEY. See SPEC.md §6.1 and src/config/resolve.ts.
  api_key: z.string().optional(),
});
export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;

export const PollingConfigSchema = z
  .object({
    interval_ms: z.number().int().positive().default(5_000),
  })
  .default({});
export type PollingConfig = z.infer<typeof PollingConfigSchema>;

export const WorkspaceConfigSchema = z.object({
  // Path may contain "~" and "$VAR"; expansion happens in resolve.ts.
  root: NonEmptyString,
});
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

export const HooksConfigSchema = z
  .object({
    // Shell scripts. The runner invokes them via `bash -lc`. `$VAR` inside the
    // script is expanded by the shell, not by claude-symphony.
    /** Runs ONCE when a per-issue workspace is first created. */
    after_create: z.string().optional(),
    /** Phase 2: runs once just before the workspace is removed. */
    before_remove: z.string().optional(),
    /** Runs before EACH agent dispatch in the workspace. */
    before_run: z.string().optional(),
    /** Runs after EACH agent dispatch (success or failure) in the workspace. */
    after_run: z.string().optional(),
    /** Wall-clock cap for any single hook invocation. Default 10 minutes. */
    timeout_ms: z.number().int().positive().default(10 * 60_000),
  })
  .default({});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export const AgentConfigSchema = z
  .object({
    max_concurrent_agents: z.number().int().positive().default(5),
    /**
     * Optional per-state caps that further constrain concurrency on top of
     * the global `max_concurrent_agents`. Keys are state names exactly as
     * Linear emits them (case-sensitive). Default `{}` = global cap only.
     * Example: { "In Progress": 3, "Rework": 1 }.
     */
    max_concurrent_agents_by_state: z
      .record(z.string(), z.number().int().nonnegative())
      .default({}),
  })
  .default({});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const PermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const ClaudeConfigSchema = z
  .object({
    model: z.string().optional(),
    permission_mode: PermissionModeSchema.default('default'),
    allowed_tools: z.array(z.string()).optional(),
    disallowed_tools: z.array(z.string()).default([]),
    // Pass-through to claude-agent-sdk's `mcpServers` option. The Linear MCP
    // entry is required at preflight time (see SPEC-claude.md §D + preflight.ts).
    mcp_servers: z.record(z.unknown()).default({}),
    system_prompt_append: z.string().default(''),
    turn_timeout_ms: z.number().int().positive().default(3_600_000),
    read_timeout_ms: z.number().int().positive().default(5_000),
    stall_timeout_ms: z.number().int().nonnegative().default(300_000),
    // SDK-internal cap on round-trips within ONE `query()` call (i.e. how
    // many tool-use → assistant cycles the model is allowed before giving
    // up). NOT the Codex-style multi-turn orchestration loop — that loop
    // (re-running query() while the issue stays in an active Linear state)
    // is the Phase 2 design question tracked in SPEC-claude.md §C / Q1.
    // Default 20 matches openai/symphony's reference configuration.
    max_turns: z.number().int().min(1).max(200).default(20),
    // PreToolUse safety hooks — survive bypassPermissions and enforce a
    // minimal "no Edit/Write outside workspace, no obviously dangerous
    // bash" policy. Default true; turn off only if you have a stronger
    // OS-level sandbox in place. See src/agent/safety-hooks.ts.
    enable_safety_hooks: z.boolean().default(true),
    /**
     * Names of in-process symphony_linear tools to NOT register for this
     * workflow. Use to dial down to read-only (disable transition_state,
     * post_comment, etc.) when an operator wants to manage Linear state
     * manually. Tool names: get_current_issue, get_workpad,
     * create_or_update_workpad, transition_state, attach_pr_url,
     * post_comment.
     */
    symphony_linear_disabled_tools: z.array(z.string()).default([]),
  })
  .default({});
export type ClaudeConfig = z.infer<typeof ClaudeConfigSchema>;

export const WorkflowConfigSchema = z.object({
  tracker: TrackerConfigSchema,
  polling: PollingConfigSchema,
  workspace: WorkspaceConfigSchema,
  hooks: HooksConfigSchema,
  agent: AgentConfigSchema,
  claude: ClaudeConfigSchema,
});
export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

/**
 * Parse and validate a raw front-matter object into a typed WorkflowConfig.
 * Throws ZodError with field-path context on validation failure.
 *
 * The returned config is NOT yet env-resolved; call resolveConfig() next.
 */
export function parseWorkflowConfig(raw: unknown): WorkflowConfig {
  return WorkflowConfigSchema.parse(raw);
}
