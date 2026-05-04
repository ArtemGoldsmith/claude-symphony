# SPEC-claude.md — claude-symphony deviations from openai/symphony SPEC.md

**Authoritative spec:** [openai/symphony `SPEC.md`](https://github.com/openai/symphony/blob/main/SPEC.md) (Draft v1, language-agnostic).

This document records, section by section, only the places where `claude-symphony` deliberately deviates from the upstream spec. Anything not listed here MUST follow `SPEC.md` as written. The companion document [`PARITY.md`](./PARITY.md) tracks porting status row by row.

A deviation is intentional and documented when one of these is true:

1. The upstream wording is Codex-specific and we replace it with the Claude-Code equivalent.
2. The upstream behaviour cannot be reproduced 1:1 because the underlying primitive differs (e.g., `claude-agent-sdk` does not expose a Codex-style "turn" boundary).
3. We choose to defer or skip a feature in early phases for scope reasons. Skips are listed but kept minimal; deferrals point at the planned phase.

Anything else found to differ during implementation is a bug in the port, not a deviation, and MUST be brought back into compliance with `SPEC.md`.

---

## A. Agent Runner — replaces SPEC.md §10 wholesale

`SPEC.md` §10 is written against the [Codex app-server protocol](https://developers.openai.com/codex/app-server/). `claude-symphony` does not run a Codex app-server. The Agent Runner instead drives the [Anthropic Claude Agent SDK](https://docs.anthropic.com/) (`@anthropic-ai/claude-agent-sdk`) directly from TypeScript.

### A.1 Launch contract (replaces §10.1)

- The runner does NOT spawn a subprocess and does NOT speak Codex stdio JSON-RPC.
- For each dispatched issue, the runner calls the SDK's `query()` factory inside the per-issue workspace, with `cwd` set to the workspace path.
- Workspace selection, prompt construction, and continuation triggering remain orchestrator-driven exactly as in `SPEC.md` §3 and §16; only the transport changes.
- The Codex CLI binary, its config flags, and `bash -lc` invocation described in `SPEC.md` §10.1 do not apply.

### A.2 Session startup (replaces §10.2)

- The runner constructs SDK `Options` from the resolved `claude:` config block (see §B below), passes the rendered prompt body as the user message, and consumes the returned `AsyncGenerator<SDKMessage>`.
- Linear access for the agent is provided via the existing public Linear MCP server (`https://mcp.linear.app/mcp`), declared in the `mcpServers` SDK option. The injected `linear_graphql` client tool from `SPEC.md` §10/§11 is NOT implemented; agents MUST use Linear MCP tools instead. PARITY row tracks this.

### A.3 Streaming turn processing (replaces §10.3)

- "Streaming turn processing" in `SPEC.md` §10.3 maps to consuming the SDK message stream until the generator completes or is cancelled.
- `claude-agent-sdk`'s `result` message terminates the stream; that boundary is the Claude analogue of the Codex turn boundary for v1. See §C below for the open question on multi-turn continuation in Phase 2.

### A.4 Emitted runtime events (replaces §10.4)

| `SPEC.md` §10.4 event family | claude-symphony source | Notes |
|---|---|---|
| Turn started | first `assistant` SDK message in a query | runner emits a synthetic `turn_started` |
| Tool call | `assistant` message with `tool_use` blocks | passed through as observation events |
| Approval request | n/a in default Claude Code permission modes | suppressed unless `permissionMode` requires it (see §B) |
| Token usage tick | `result` SDK message `usage` field | emitted once per query, not streaming |
| Turn completed | `result` SDK message | terminal event |
| Stall (no events for N ms) | runner-side timer over the SDK stream | implementation-defined per §10.6 |

The runner SHOULD preserve the `SPEC.md` §13.5 session-metrics shape (`input_tokens`, `output_tokens`, `total_tokens`, `runtime_seconds`) by mapping from `result.usage`.

### A.5 Approval / tool-call policy (replaces §10.5)

`claude-agent-sdk` exposes a permission model with three relevant levers (`permissionMode`, `allowedTools`, `disallowedTools`, plus optional permission callbacks and hooks). These supersede Codex's `approval_policy`, `thread_sandbox`, and `turn_sandbox_policy` fields entirely. Mapping is detailed in §B.

### A.6 Timeouts (preserves §10.6 intent)

- `claude.turn_timeout_ms` (default 3,600,000) — wall-clock cap on a single `query()`.
- `claude.read_timeout_ms` (default 5,000) — preserved for symmetry; in practice serves as the SDK stream-idle warning threshold.
- `claude.stall_timeout_ms` (default 300,000) — used by the runner to detect a silent SDK stream.

---

## B. Front Matter Schema — `codex:` block becomes `claude:`

`SPEC.md` §5.3 documents a `codex:` front-matter block with Codex-specific fields. `claude-symphony` replaces this with a `claude:` block. All other front-matter sections (`tracker`, `polling`, `workspace`, `hooks`, `agent`) are preserved as-is.

### B.1 Field mapping

| `codex.*` field (SPEC.md §5.3.6, §6.4) | `claude.*` field | Type | Default |
|---|---|---|---|
| `codex.command` | n/a (programmatic SDK call) | — | — |
| `codex.approval_policy` | `claude.permission_mode` | `"default" \| "acceptEdits" \| "plan" \| "bypassPermissions"` | `"default"` |
| `codex.thread_sandbox` | `claude.allowed_tools` | `string[]` (SDK tool names) | unset (no allowlist; combined with `disallowed_tools`) |
| `codex.turn_sandbox_policy` | `claude.disallowed_tools` | `string[]` (SDK tool names) | `[]` |
| `codex.turn_timeout_ms` | `claude.turn_timeout_ms` | integer | 3,600,000 |
| `codex.read_timeout_ms` | `claude.read_timeout_ms` | integer | 5,000 |
| `codex.stall_timeout_ms` | `claude.stall_timeout_ms` | integer | 300,000 |
| n/a | `claude.model` | string (e.g., `"claude-opus-4-7"`) | implementation default per SDK |
| n/a | `claude.mcp_servers` | record passed to SDK `mcpServers` | `{}` |
| n/a | `claude.system_prompt_append` | string appended to SDK system prompt | empty |
| n/a | `claude.max_turns` | integer in [1, 200] | 20 (matches openai/symphony reference) |

Validation lives in `src/config/schema.ts` as a Zod schema. Unknown keys under `claude:` MUST be ignored for forward compatibility, mirroring `SPEC.md` §5.3 / §6.

### B.2 Sandbox / safety preservation

`SPEC.md` §15.2 filesystem safety requirements (workspace as the only writable root, denial of paths outside the workspace, etc.) are preserved by:

1. Setting SDK `cwd` to the issue workspace path.
2. Using `claude.permission_mode` together with `claude.allowed_tools` / `claude.disallowed_tools` to forbid network or filesystem access outside the workspace.
3. Optionally registering a `canUseTool` permission callback or pre-tool-use hook to enforce path-prefix checks.

Detailed enforcement strategy is owned by `src/util/path-safety.ts`.

---

## C. Continuation and turns — orchestrator-side loop deferred to Phase 2

There are TWO distinct things hiding under the word "turn." Splitting them is the whole point of this section.

**1. SDK-internal turns (`claude.max_turns`) — supported in MVP.**

`claude-agent-sdk`'s `Options.maxTurns` caps how many internal round-trips (tool-use → assistant message → tool-use → ...) the model is allowed inside a single `query()` call before the SDK returns `result.subtype: "error_max_turns"`. This is the natural Claude analogue of "model can think and act several times before producing a final answer." It has no orchestrator implication; raising it just lets the agent solve more complex tickets in one shot.

`claude-symphony`'s default is `20` (matches openai/symphony's reference Codex configuration). The schema allows `[1, 200]`. Set it lower if you want to bound runtime cost, higher if your tickets routinely need more model rounds.

**2. Orchestrator-driven multi-`query()` loop — deferred to Phase 2.**

`SPEC.md` §7.2 and §12.3 describe a Codex-shaped lifecycle where a single coding-agent app-server session can run multiple consecutive **turns** under orchestrator supervision: when one turn completes but the issue is still in an active state, the orchestrator launches another. This is the Codex notion of "turn" and it lives in the orchestrator, not the SDK.

In MVP the orchestrator dispatches **one `query()` call per Linear issue** and never re-dispatches the same issue (other than the one fixed-delay retry on dispatch failure). If the issue remains active after the agent's `query()` returns successfully, the orchestrator marks it `completed` and walks away.

Phase 2 will pick one of: (a) re-`query()` with conversation resume, (b) re-`query()` with a fresh session and a "continuation" prompt suffix mirroring Codex's behaviour, or (c) translating Codex turns to a single longer `query()` via SDK stop conditions plus a higher `maxTurns`. The decision will be recorded as §C.1 before any implementation.

Downstream effects we deliberately do not ship in MVP:

- The prompt-template `attempt` variable (`SPEC.md` §12.3) is wired through but only increments across orchestrator-level retries on dispatch failure (see §F), never across "the issue is still active, run again" continuations.

---

## D. Linear tracker integration — unchanged contract, MCP for the agent side

`SPEC.md` §11 contract for the **orchestrator's** Linear client is preserved end-to-end. `src/linear/` uses `@linear/sdk` rather than raw GraphQL strings, but exposes the same operations (`fetch_candidate_issues`, `fetch_issue_state(id)`, terminal-state cleanup query) with the same normalization (`SPEC.md` §11.3).

Tracker WRITES (`SPEC.md` §11.5) remain the agent's responsibility, not the orchestrator's. The agent obtains write access through the Linear MCP server registered in `claude.mcp_servers`, replacing `SPEC.md`'s `linear_graphql` injected client tool (§10 / §11.5 / §13). The MCP server is provided by Linear and required to be configured in `WORKFLOW.md`; if unset, dispatch preflight (§6.3) MUST fail.

---

## E. Status surface — minimum viable subset for MVP

`SPEC.md` §13.4 and §13.7 describe an OPTIONAL human-readable status surface and HTTP server. MVP ships a structured `pino` log (`SPEC.md` §13.1, §13.2) only.

The HTTP server, JSON state API, and any UI are deferred to Phase 3. PARITY rows for §13.3, §13.4, §13.6, §13.7 are explicitly `🔵 Phase 3`.

---

## F. Retry, reconcile, recovery — MVP subset

MVP implements:

- `SPEC.md` §8.1 poll loop with `polling.interval_ms`.
- `SPEC.md` §8.2 candidate selection with project + active-states filter.
- `SPEC.md` §8.3 concurrency control via `agent.max_concurrent_agents`.
- `SPEC.md` §8.4 retry: a single retry per dispatch failure, after a fixed 30 s delay. Exponential backoff, retry queue, and `agent.max_concurrent_agents_by_state` are deferred.
- `SPEC.md` §16.5 worker attempt loop minus the multi-turn continuation step.

MVP defers:

- `SPEC.md` §6.2 dynamic config reload — Phase 3.
- `SPEC.md` §8.5 active run reconciliation — Phase 2.
- `SPEC.md` §8.6 startup terminal cleanup — Phase 2.
- `SPEC.md` §10.6 stall detection — Phase 2.
- `SPEC.md` §14.3 partial state recovery on restart — Phase 2.

Each deferral is a row in `PARITY.md` with the target phase noted.

---

## G. Appendix A — SSH workers

`SPEC.md` Appendix A (SSH worker extension) is OPTIONAL in the upstream spec and OUT OF SCOPE for `claude-symphony` Phases 1–3. Single-host execution only. Phase 4 will revisit if a real need surfaces.

---

## Open design questions tracked here

These are decisions we defer in MVP and resolve before the Phase they unblock. Add to this list whenever a deviation is identified mid-implementation.

| ID | Question | Blocks | Target resolution |
|---|---|---|---|
| Q1 | What is a "turn" in claude-agent-sdk for §12.3 retry/continuation? Resume session vs fresh session vs single longer query? | Phase 2 multi-turn dispatch | Documented as §C.1 before Phase 2 starts |
| Q2 | How do we report `SPEC.md` §13.5 token totals when SDK only emits final `result.usage`? Per-message synthetic ticks, or accept once-per-query semantics? | Phase 1 metrics fidelity | First MVP run; default to once-per-query |
| Q3 | `path-safety.ts` enforcement: SDK `permission_mode` + `disallowed_tools` only, or add `canUseTool` callback? | §15.2 filesystem safety guarantees | Before agent runner lands (PARITY row #6) |
| Q4 | Does `WORKFLOW.md` live in the user's product repo (like upstream) or in the orchestrator's working dir? Affects multi-project use. | Phase 3 multi-project | Phase 3 design pass |
