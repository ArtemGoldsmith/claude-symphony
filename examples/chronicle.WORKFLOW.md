---
# claude-symphony WORKFLOW.md — Chronicle (Smirnov Labs)
# This file follows SPEC-claude.md (the Claude Code variant of openai/symphony's
# SPEC.md). Edit the placeholders marked TODO before the first run.
#
# Required env vars:
#   LINEAR_API_KEY     - Personal API key from Linear → Settings → Security & access
#   ANTHROPIC_API_KEY  - or be logged in via the `claude` CLI

tracker:
  kind: linear
  # TODO: replace with the actual Linear project slug. Right-click the project
  # in Linear → "Copy URL"; the slug is the segment after "/project/".
  project_slug: chronicle-PLACEHOLDER

  # Issues in any of these states are dispatch candidates.
  active_states:
    - Todo
    - In Progress

  # Issues moving into any of these states are considered finished and will
  # never be redispatched. Symphony does not modify Linear state itself —
  # state changes are the agent's or operator's job.
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Closed
    - Duplicate

  # Optional. Defaults to $LINEAR_API_KEY if unset.
  # api_key: $LINEAR_API_KEY

polling:
  # Tick interval. 5s is a good starting point; raise for quieter projects.
  interval_ms: 5000

workspace:
  # Per-issue worktrees land at <root>/<TEAM-NNN>/. Path supports `~` and `$VAR`.
  root: ~/code/chronicle-symphony-workspaces

hooks:
  # Runs once when the per-issue workspace is first created. Use it to
  # populate the workspace with the repo. Bash -lc semantics; `$VAR` is
  # expanded by the shell at execution time, NOT by claude-symphony.
  #
  # SYMPHONY_ISSUE_ID, SYMPHONY_ISSUE_IDENTIFIER, SYMPHONY_ISSUE_TITLE,
  # SYMPHONY_ISSUE_URL, SYMPHONY_WORKSPACE_PATH are injected.
  after_create: |
    set -euo pipefail
    # TODO: confirm this matches your local clone strategy. SSH assumed.
    git clone --depth 1 git@github.com:Smirnov-Labs/chronicle.git .
    # Optional: install deps so the agent doesn't have to.
    if command -v pnpm >/dev/null 2>&1; then
      pnpm install --frozen-lockfile
    fi

agent:
  # Cap on concurrent dispatches. Start small, raise once you trust the loop.
  max_concurrent_agents: 1

claude:
  # Default model is whatever the SDK picks; pin one explicitly for repeatable
  # runs.
  model: claude-opus-4-7

  # See SPEC-claude.md §B for the mapping from upstream `codex.*` fields.
  # `default` is the safest starting point: the agent must explicitly request
  # writes and Bash commands. Switch to `acceptEdits` once you trust the loop
  # for low-risk work, and only use `bypassPermissions` in fully sandboxed envs.
  permission_mode: default

  # Tools the agent is FORBIDDEN to use, even when permission_mode would allow.
  # The `Bash(...)` syntax restricts a single binary; the bare name forbids the
  # whole tool. Examples:
  #   - "Bash(rm:*)"       block any `rm` invocation
  #   - "Bash(sudo:*)"     block sudo
  disallowed_tools:
    - "Bash(rm -rf:*)"
    - "Bash(sudo:*)"

  # MCP servers the agent should connect to during the session. The Linear
  # entry is REQUIRED (preflight will fail without it) — it gives the agent
  # the ability to comment on the ticket, change its status, and attach the
  # PR/MR back to the issue.
  mcp_servers:
    linear:
      url: https://mcp.linear.app/mcp

  # Appended to the SDK's built-in Claude Code system prompt. Use this for
  # project-wide rules without editing the per-issue prompt body below.
  system_prompt_append: |
    Repo conventions:
    - This is the Chronicle Nx monorepo (TypeScript ESM). Use `pnpm` for everything.
    - Run `pnpm test` and `pnpm typecheck` before declaring work done.
    - Keep changes minimal and reversible. Prefer surgical edits over rewrites.

  # Per-turn timeout. 1 hour matches the SPEC default; lower if you want to
  # bail out earlier on a stuck run.
  turn_timeout_ms: 3600000

  # MUST be 1 in MVP — multi-turn continuation is deferred to Phase 2 per
  # SPEC-claude.md §C. claude-symphony's Zod schema rejects higher values.
  max_turns: 1
---

You are working on Linear ticket `{{ issue.identifier }}` for Chronicle, the
Meeting Intelligence Operating System.

## Issue
- Title: {{ issue.title }}
- Status: {{ issue.state }}
- Labels: {{ issue.labels }}
- URL: {{ issue.url }}

## Description

{{ issue.description }}

---

## How to work this ticket

You are running unattended in an isolated git worktree. There is no human in
the loop. Your operator will read your final summary in Linear, not in the
terminal.

1. Read the ticket above carefully. If anything is unclear, post one
   question as a Linear comment on this issue and stop — that is your
   blocker escape hatch.
2. Reproduce or characterize current behavior before changing code. Capture
   the reproduction signal in a Linear comment so reviewers can see it.
3. Plan in a single Linear comment titled `## Codex Workpad`. Keep one
   workpad per issue and edit it in place as scope evolves.
4. Implement on a branch named `agent/<lowercase-identifier>-<short-slug>`.
5. Run `pnpm test` and `pnpm typecheck` for any apps you touched. Capture the
   command + result in the workpad.
6. Open a PR against `main`, attach it to the Linear issue, and move the
   issue to `Human Review` (use the Linear MCP for both). Do NOT merge.
7. Final Linear comment: a short list of what changed, what tests were run,
   any open questions for the reviewer.

## Hard rules

- Operate only inside this worktree. Do not modify any other path on disk.
- Do not push to branches other than your own `agent/...` branch.
- Do not delete or rename other people's branches.
- Do not run `npm publish`, `pnpm publish`, `gh release create`, or any other
  publication command.
- If you cannot complete the ticket without violating one of the above,
  post the blocker on the Linear issue and stop.
