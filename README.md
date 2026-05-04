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

Not yet. The first end-to-end run is tracked as MVP Definition of Done in `PARITY.md`.

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
