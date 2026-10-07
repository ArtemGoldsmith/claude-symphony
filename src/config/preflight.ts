// SPEC.md §6.3 — Dispatch Preflight Validation.
// PARITY.md row: §6.3.
//
// Run after schema validation + env resolution, before the orchestrator
// dispatches anything. Catches misconfiguration that schema.ts cannot:
// runtime invariants like "Linear MCP server must be configured for the
// agent to write back to the tracker" (SPEC-claude.md §D), and existence
// of the workspace root's parent directory.

import fs from 'node:fs';
import path from 'node:path';

import type { ResolvedWorkflowConfig } from './resolve.js';

export class PreflightError extends Error {
  constructor(
    message: string,
    public readonly fieldPath: string,
  ) {
    super(`${fieldPath}: ${message}`);
    this.name = 'PreflightError';
  }
}

/**
 * Returns true if the configured `claude.mcp_servers` map contains an entry
 * that looks like the Linear MCP server. We accept either a key starting
 * with "linear" (case-insensitive) or a value object whose `url` field
 * contains "linear.app". This keeps WORKFLOW.md flexible while ensuring
 * the agent has a write path back to Linear.
 */
function hasLinearMcpServer(servers: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(servers)) {
    if (key.toLowerCase().includes('linear')) return true;
    if (value && typeof value === 'object') {
      const url = (value as { url?: unknown }).url;
      if (typeof url === 'string' && url.toLowerCase().includes('linear.app')) return true;
    }
  }
  return false;
}

export interface PreflightResult {
  /** Non-fatal advice the CLI logs at boot. */
  warnings: string[];
}

const SUPPORTED_MCP_TYPES: ReadonlySet<string> = new Set(['http', 'sse', 'stdio', 'sdk']);

/**
 * Shape-check a single MCP server config entry. Returns a problem string
 * if the entry is malformed enough that claude-agent-sdk will reject it.
 * Returns null when the entry looks plausible. Treated as a HARD error
 * upstream (preflight throws on first), since a malformed MCP config
 * causes the agent run to fail noisily anyway — better to surface at
 * boot than blame the SDK at first dispatch.
 */
function checkMcpEntry(name: string, raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return `claude.mcp_servers.${name}: must be an object`;
  }
  const entry = raw as Record<string, unknown>;
  const type = entry.type;
  if (typeof type === 'string') {
    if (!SUPPORTED_MCP_TYPES.has(type)) {
      return `claude.mcp_servers.${name}.type "${type}" is not one of ${[...SUPPORTED_MCP_TYPES].join(', ')}`;
    }
    if ((type === 'http' || type === 'sse') && typeof entry.url !== 'string') {
      return `claude.mcp_servers.${name}: type "${type}" requires a string \`url\``;
    }
    if (type === 'stdio' && typeof entry.command !== 'string') {
      return `claude.mcp_servers.${name}: type "stdio" requires a string \`command\``;
    }
    return null;
  }
  // No explicit type — accept legacy { command, args } stdio shape and
  // legacy bare { url } http shape, but warn-shaped above. The SDK has
  // grown stricter over time; surface the missing type here so operators
  // catch it at boot rather than at first dispatch.
  if (typeof entry.command === 'string' || typeof entry.url === 'string') {
    return `claude.mcp_servers.${name}: missing \`type\` field; add type: http (or sse / stdio) to match the claude-agent-sdk schema`;
  }
  return `claude.mcp_servers.${name}: must contain either \`type + url\` (http/sse) or \`type: stdio + command\``;
}

/**
 * Common camelCase ↔ snake_case typo signatures. Unknown keys at any level
 * are silently ignored by Zod for forward compatibility (SPEC.md §5.3),
 * which is correct in the long run but unhelpful when the user meant a
 * known field and wrote it in the wrong case. We surface the most likely
 * typos as warnings.
 */
const TYPO_HINTS: ReadonlyArray<{ wrong: string; right: string; container: string }> = [
  { wrong: 'permissionMode', right: 'permission_mode', container: 'claude' },
  { wrong: 'allowedTools', right: 'allowed_tools', container: 'claude' },
  { wrong: 'disallowedTools', right: 'disallowed_tools', container: 'claude' },
  { wrong: 'mcpServers', right: 'mcp_servers', container: 'claude' },
  { wrong: 'systemPromptAppend', right: 'system_prompt_append', container: 'claude' },
  { wrong: 'maxTurns', right: 'max_turns', container: 'claude' },
  { wrong: 'maxConcurrentAgents', right: 'max_concurrent_agents', container: 'agent' },
  { wrong: 'projectSlug', right: 'project_slug', container: 'tracker' },
  { wrong: 'activeStates', right: 'active_states', container: 'tracker' },
  { wrong: 'terminalStates', right: 'terminal_states', container: 'tracker' },
  { wrong: 'apiKey', right: 'api_key', container: 'tracker' },
  { wrong: 'intervalMs', right: 'interval_ms', container: 'polling' },
  { wrong: 'afterCreate', right: 'after_create', container: 'hooks' },
  { wrong: 'beforeRemove', right: 'before_remove', container: 'hooks' },
];

/**
 * Validate runtime invariants on a resolved config. Throws PreflightError
 * on hard problems; returns a list of soft warnings the CLI surfaces at
 * boot. Pass `rawWorkflowConfig` (the front-matter object before Zod
 * stripping) to enable typo-warning checks against unknown camelCase keys.
 */
export function preflightConfig(
  config: ResolvedWorkflowConfig,
  rawWorkflowConfig?: Record<string, unknown>,
): PreflightResult {
  const warnings: string[] = [];

  if (!hasLinearMcpServer(config.claude.mcp_servers)) {
    throw new PreflightError(
      'no Linear MCP server configured; agents cannot write back to the tracker. ' +
        'Add a `linear` entry under `claude.mcp_servers` (see SPEC-claude.md §D).',
      'claude.mcp_servers',
    );
  }

  for (const [name, entry] of Object.entries(config.claude.mcp_servers)) {
    const problem = checkMcpEntry(name, entry);
    if (problem !== null) {
      throw new PreflightError(problem, `claude.mcp_servers.${name}`);
    }
  }

  const workspaceRoot = config.workspace.root;
  const parent = path.dirname(workspaceRoot);
  if (!fs.existsSync(parent)) {
    throw new PreflightError(
      `parent directory does not exist: ${parent}. Create it before starting the daemon.`,
      'workspace.root',
    );
  }

  if (config.tracker.api_key.length === 0) {
    throw new PreflightError('resolved API key is empty', 'tracker.api_key');
  }

  if (config.claude.permission_mode === 'bypassPermissions' && !config.claude.enable_safety_hooks) {
    warnings.push(
      'claude.permission_mode = bypassPermissions but claude.enable_safety_hooks = false: ' +
        'the agent has unrestricted host access. Enable safety hooks or run inside an OS-level sandbox.',
    );
  }

  if (rawWorkflowConfig) {
    for (const hint of TYPO_HINTS) {
      const block = rawWorkflowConfig[hint.container];
      if (block && typeof block === 'object' && hint.wrong in block) {
        warnings.push(
          `${hint.container}.${hint.wrong} looks like a camelCase typo; the schema expects ${hint.container}.${hint.right}. The value is being silently ignored.`,
        );
      }
    }
  }

  return { warnings };
}
