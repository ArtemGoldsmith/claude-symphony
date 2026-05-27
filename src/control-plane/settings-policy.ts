// src/control-plane/settings-policy.ts
// Spec §11 C1: reinstate, for raw `claude -p`, the deny policy the SDK gave us
// via enable_safety_hooks (src/agent/safety-hooks.ts). Settings `permissions.deny`
// entries are matched by Claude Code against tool calls; Bash(...) matches the
// command string, Write(...)/Edit(...) match the target path. This is a backstop
// (a determined agent can evade substring rules) layered with the pre-push hook
// + minimal env allowlist + clean-room worktree.

export interface ClaudeSettings {
  permissions: {
    /** "default" keeps allow/deny rules in force under --permission-mode. */
    defaultMode?: string;
    deny: string[];
  };
  hooks?: {
    PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>;
  };
}

/**
 * Bash command-prefix denials mirroring DEFAULT_BASH_DENY_PATTERNS plus the
 * never-push invariant. Claude Code matches `Bash(<prefix>:*)` against the
 * command's leading tokens; a trailing-pipe pattern (`curl ... | sh`) is NOT
 * expressible as a Bash prefix rule, so the load-bearing `curl|sh` block is
 * enforced by the PreToolUse hook below, not a permission glob.
 */
const BASH_DENY: readonly string[] = [
  'Bash(git push:*)',
  'Bash(sudo:*)',
  'Bash(rm -rf /:*)',
  'Bash(mkfs:*)',
  'Bash(gh pr create:*)',
  'Bash(glab mr create:*)',
];

/**
 * Build the deny policy + a PreToolUse guard hook. Two layers:
 *  1. permissions.deny — prefix-expressible Bash denials + absolute-path Write/Edit
 *     denials (Claude Code absolute-path syntax is `//abs/path/**`). Relative
 *     Write/Edit are already confined to cwd (the worktree) by Claude Code.
 *  2. hooks.PreToolUse — a shipped guard script that re-implements the parts a
 *     glob can't: the `curl|sh`/`wget|sh` pipe-to-shell block and a defensive
 *     "Write/Edit target resolves outside cwd" check. Faithful replacement for the
 *     SDK's enable_safety_hooks (safety-hooks.ts), which raw `claude -p` drops.
 *     The guard exits non-zero to deny.
 *
 * IMPORTANT: the EXACT permission-glob + hook-matcher syntax is validated by the
 * box-only integration test (Task 13) against real `claude -p`. File-path deny
 * rules do NOT block a subprocess writing a file, so the env allowlist + cwd
 * confinement + single-tenant box (accepted residual risk) remain load-bearing.
 */
export function buildSettingsJson(guardScriptPath = 'scripts/pretooluse-guard.sh'): ClaudeSettings {
  const pathDeny = [
    'Write(//etc/**)',
    'Edit(//etc/**)',
    'Write(~/**)',
    'Edit(~/**)',
  ];
  return {
    permissions: {
      defaultMode: 'default',
      deny: [...BASH_DENY, ...pathDeny],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: guardScriptPath }],
        },
      ],
    },
  };
}
