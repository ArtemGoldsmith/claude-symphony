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
    allow?: string[];
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

const DISCUSS_ALLOW: readonly string[] = ['Read', 'Grep', 'Glob'];
const DISCUSS_DENY: readonly string[] = [
  'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Agent',
  // Defense-in-depth: known dangerous/extension tools. Future tools not on
  // `allow` are auto-denied under --permission-mode dontAsk regardless.
  'PowerShell', 'Skill', 'Workflow',
];
const DISCUSS_MATCHER =
  'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|Agent|PowerShell|Skill|Workflow';

/**
 * Read-only settings for `claude --continue` from the dashboard discuss
 * terminal. Primary safety: allowlist (Read/Grep/Glob) + --permission-mode
 * dontAsk auto-denies anything not on allow, including future tools. Deny list
 * + PreToolUse hook are defense-in-depth.
 *
 * `absGuardPath` MUST be absolute — Claude Code resolves the hook command at
 * runtime against the worktree cwd, so a relative path would fail-open.
 */
export function buildDiscussSettingsJson(absGuardPath: string): ClaudeSettings {
  if (!absGuardPath.startsWith('/')) {
    throw new Error(`buildDiscussSettingsJson: absGuardPath must be absolute, got ${absGuardPath}`);
  }
  return {
    permissions: {
      defaultMode: 'default',
      allow: [...DISCUSS_ALLOW],
      deny: [...DISCUSS_DENY],
    },
    hooks: {
      PreToolUse: [
        { matcher: DISCUSS_MATCHER, hooks: [{ type: 'command', command: absGuardPath }] },
      ],
    },
  };
}

const DISCUSS_ENV_KEYS: readonly string[] = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL'];

/** Env for `claude --continue` from discuss — strips Linear/Anthropic/all extras.
 *  Returns only keys necessary for claude to find its keychain creds (HOME) and
 *  render in a terminal. */
export function buildDiscussEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DISCUSS_ENV_KEYS) {
    const v = source[k];
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}
