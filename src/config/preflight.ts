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

/**
 * Validate runtime invariants on a resolved config. Throws PreflightError
 * on the first problem found, with a `fieldPath` pointer suitable for
 * operator-facing logs.
 */
export function preflightConfig(config: ResolvedWorkflowConfig): void {
  if (!hasLinearMcpServer(config.claude.mcp_servers)) {
    throw new PreflightError(
      'no Linear MCP server configured; agents cannot write back to the tracker. ' +
        'Add a `linear` entry under `claude.mcp_servers` (see SPEC-claude.md §D).',
      'claude.mcp_servers',
    );
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
}
