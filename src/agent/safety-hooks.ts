// SPEC.md §10.5 + §15.2 + §15.4 — agent-side safety guards.
// PARITY.md row: §15.2 (B3 from Codex review).
//
// Anthropic's permission flow runs PreToolUse hooks BEFORE permission mode,
// which means a hook can still block tool calls even when permission_mode
// is bypassPermissions. That makes hooks the right place to enforce a
// policy that survives autonomous dispatch:
//
//   1. Edit / Write / NotebookEdit may only target paths inside the
//      workspace cwd. Without this, the agent could decide to edit
//      /etc/hosts or ~/.zshrc on a stuck-loop attempt.
//   2. Bash commands matching well-known dangerous patterns (sudo,
//      rm -rf /, curl|sh, etc.) are denied outright. Not a complete
//      sandbox — the patterns can be bypassed by a determined agent —
//      but it catches accidents and obvious foot-guns at near-zero cost.
//
// This module builds the PreToolUse callback. The runner wires it into the
// SDK's options.hooks when claude.enable_safety_hooks is true.

import path from 'node:path';

/**
 * Bash command substrings that are denied unconditionally. Substring match
 * against the command string the agent passes to the Bash tool.
 *
 * Conservative: misses `sudo` invoked via env, `rm -rf` with a non-/ root,
 * etc. Operators who want more should add their own patterns.
 */
export const DEFAULT_BASH_DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  /(^|[\s;|&(])sudo(\s|$)/,
  /(^|[\s;|&(])rm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(\s|$)/,
  /\bmkfs\b/,
  />\s*\/dev\/(sd|nvme|disk)/,
  /\bcurl\s+[^|]*\|\s*(ba)?sh\b/,
  /\bwget\s+[^|]*\|\s*(ba)?sh\b/,
  /\b:\s*\(\s*\)\s*\{[^}]*\bfork\s*\(\)/, // fork bomb
]);

const PATH_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
]);

const PATH_FIELD_BY_TOOL: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

export interface SafetyHookOptions {
  workspaceCwd: string;
  bashDenyPatterns?: readonly RegExp[];
}

export interface SafetyDecision {
  /** SDK HookPermissionDecision string. */
  permissionDecision: 'allow' | 'deny';
  /** Operator-readable explanation when denying. */
  permissionDecisionReason?: string;
}

/**
 * Pure decision function — given a tool call, returns allow/deny.
 * The SDK-shaped callback in `buildPreToolUseSafetyHook` wraps this.
 * Exposed independently so the policy can be unit-tested without an SDK.
 */
export function decideSafety(
  toolName: string,
  toolInput: unknown,
  options: SafetyHookOptions,
): SafetyDecision {
  if (PATH_TOOL_NAMES.has(toolName)) {
    const field = PATH_FIELD_BY_TOOL[toolName] ?? 'file_path';
    const filePath = (toolInput as Record<string, unknown> | null | undefined)?.[field];
    if (typeof filePath !== 'string' || filePath.length === 0) {
      // Malformed input — deny rather than guess.
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: `${toolName} call missing string ${field}`,
      };
    }
    const resolvedRoot = path.resolve(options.workspaceCwd);
    const resolvedTarget = path.resolve(resolvedRoot, filePath);
    const rootWithSep = resolvedRoot.endsWith(path.sep)
      ? resolvedRoot
      : resolvedRoot + path.sep;
    if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(rootWithSep)) {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason:
          `safety hook: ${toolName} target ${resolvedTarget} is outside the workspace ${resolvedRoot}`,
      };
    }
    return { permissionDecision: 'allow' };
  }

  if (toolName === 'Bash') {
    const command = (toolInput as { command?: unknown } | null | undefined)?.command;
    if (typeof command !== 'string') {
      return { permissionDecision: 'allow' }; // SDK rejects malformed input itself
    }
    const patterns = options.bashDenyPatterns ?? DEFAULT_BASH_DENY_PATTERNS;
    for (const pattern of patterns) {
      if (pattern.test(command)) {
        return {
          permissionDecision: 'deny',
          permissionDecisionReason: `safety hook: bash command rejected by pattern ${pattern.source}`,
        };
      }
    }
    return { permissionDecision: 'allow' };
  }

  return { permissionDecision: 'allow' };
}

/**
 * Build the SDK-shaped PreToolUse hook callback. The shape mirrors
 * @anthropic-ai/claude-agent-sdk's HookCallback / PreToolUseHookInput so
 * the runner can wire it into Options.hooks directly.
 */
export function buildPreToolUseSafetyHook(options: SafetyHookOptions): (
  input: { hook_event_name: 'PreToolUse'; tool_name: string; tool_input: unknown },
) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}> {
  return async (input) => {
    const decision = decideSafety(input.tool_name, input.tool_input, options);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.permissionDecision,
        ...(decision.permissionDecisionReason !== undefined
          ? { permissionDecisionReason: decision.permissionDecisionReason }
          : {}),
      },
    };
  };
}
