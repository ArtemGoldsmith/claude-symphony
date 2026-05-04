# claude-symphony

A TypeScript port of [openai/symphony](https://github.com/openai/symphony) that orchestrates [Claude Code](https://claude.com/claude-code) instead of Codex.

> [!WARNING]
> Early development. Not production-ready. Targeting MVP first; full spec parity is a long-term goal.

## What this is

Symphony turns project work into isolated, autonomous implementation runs. You manage tickets in a tracker (Linear); the daemon polls for work, creates per-issue git worktrees, and spawns coding-agent sessions inside them. Engineers manage *the work*, not the agents.

`claude-symphony` keeps the same model and the same `WORKFLOW.md` configuration shape, but swaps the Codex app-server for the Claude Agent SDK.

## Status

See [`PARITY.md`](./PARITY.md) for the row-by-row port status against `openai/symphony`'s [`SPEC.md`](https://github.com/openai/symphony/blob/main/SPEC.md). See [`SPEC-claude.md`](./SPEC-claude.md) for the deliberate deviations from that spec (notably the agent runtime).

## Requirements

- Node.js ≥ 20
- Git
- A Linear API token (`LINEAR_API_KEY`)
- An Anthropic API key with Claude Code access, or a logged-in Claude CLI

## Quick start

The MVP loop is in place. To run it against a real Linear project end-to-end:

### 1. Prepare your Linear project

- In your Linear workspace, create the project the daemon will poll (e.g. "Chronicle" under "Smirnov Labs"). Note the project's slug — right-click the project, "Copy link", and grab the segment after `/project/`.
- Confirm or add the active states the daemon should treat as dispatch candidates. The default `Todo` and `In Progress` exist out of the box.
- Get a personal API key from **Linear → Settings → Security & access → Personal API keys**.

### 2. Configure your environment

```sh
export LINEAR_API_KEY="lin_api_..."
# Make sure `claude` (the Claude Code CLI) is logged in, OR export ANTHROPIC_API_KEY.
```

### 3. Author a `WORKFLOW.md`

Copy `examples/chronicle.WORKFLOW.md` somewhere (in or out of your product repo — your call) and edit:

- `tracker.project_slug` to your real slug.
- `workspace.root` to where per-issue worktrees should live.
- `hooks.after_create` to the right `git clone` target for your repo.
- The prompt body at the bottom to match your project's conventions.

The format is YAML front matter + Markdown body. See [`SPEC-claude.md`](./SPEC-claude.md) §B for the front-matter schema (in particular the `claude:` block, which replaces upstream's `codex:` block).

### 4. Run the daemon

```sh
git clone https://github.com/ArtemGoldsmith/claude-symphony
cd claude-symphony
pnpm install
pnpm dev /absolute/path/to/your/WORKFLOW.md --logs-root ./log
```

The first poll happens immediately; subsequent polls fire on `polling.interval_ms`. Live activity streams to stdout; structured JSONL goes to `<logs-root>/symphony.log`. `Ctrl-C` (SIGINT) drains in-flight dispatches before exit.

### 5. Drive it from Linear

Create a ticket in your project, set its state to `Todo`. Within `interval_ms`, claude-symphony picks it up, creates a worktree under `workspace.root`, runs `after_create`, and dispatches a Claude Code agent with the rendered prompt. The agent writes back to the ticket via Linear's public MCP server (already wired in the example).

After each successful agent run, the daemon **re-checks the issue's Linear state** (Symphony parity, see [`SPEC-claude.md`](./SPEC-claude.md) §C):

- If the issue has moved out of `tracker.active_states` (e.g., the agent transitioned it to `Human Review` or `Done`), the orchestrator marks it completed and walks away.
- If the issue is still in an active state — the agent finished a turn but the work isn't done yet — the orchestrator requeues it with no cooldown so the next tick dispatches another run. Capped at 10 dispatches per issue to bound runaway cost; after that the issue is marked failed and the operator must intervene.

A **failed** dispatch (agent error, timeout, hook failure) is retried once after a 30 s cooldown; a second failure marks the issue failed permanently.

### Troubleshooting first run

- **"no Linear MCP server configured"** — the preflight check requires a Linear entry under `claude.mcp_servers`. The example WORKFLOW has it pre-wired.
- **`LINEAR_API_KEY` errors** — either the env var isn't exported in the shell that started the daemon, or the project slug is wrong (Linear returns 0 issues silently).
- **Hook failures** — the `after_create` script runs in `bash -lc` with the workspace as cwd. Inspect `<logs-root>/symphony.log` for stderr capture, then test the script manually in a scratch dir.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
