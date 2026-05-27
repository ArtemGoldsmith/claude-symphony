# PARITY — porting status against openai/symphony SPEC.md

Source spec: [openai/symphony `SPEC.md`](https://github.com/openai/symphony/blob/main/SPEC.md) (Draft v1).
Deviations log: [`SPEC-claude.md`](./SPEC-claude.md).

This document is the canonical progress tracker. It is updated **in the same commit** as any code that moves a row's status. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Legend

| Symbol | Meaning |
|---|---|
| ✅ | Done — implementation matches the spec section (or the corresponding `SPEC-claude.md` deviation) and is covered by tests |
| 🟡 | Partial — some aspects implemented; row notes what is and isn't |
| 🔵 | Planned — not yet implemented; phase target in the row |
| ⚪ | Skipped — not implemented now; row notes whether deferred (with phase) or deliberately out of scope (with rationale) |

## Phase plan summary

- **Phase 1 (MVP)**: smallest end-to-end that closes a real Chronicle ticket. Scope locked in `SPEC-claude.md` §F.
- **Phase 2**: continuation/turns, exponential backoff retry queue, reconcile pass, stall detection, restart recovery, `before_remove` workspace hook.
- **Phase 3**: dynamic config reload, status surface (JSON API + minimal HTML), HTTP server.
- **Phase 4**: SSH workers (Appendix A), multi-project support if it surfaces real demand.

---

## §1. Problem Statement
| Spec | Status | Module | Notes |
|---|---|---|---|
| §1 framing | 🟡 | `README.md` | Restated at the top of README; full problem statement is canonical in upstream spec, not duplicated here |

## §2. Goals and Non-Goals
| Spec | Status | Module | Notes |
|---|---|---|---|
| §2.1 Goals | 🟡 | `README.md` | Inherited; we don't re-state |
| §2.2 Non-Goals | 🟡 | `README.md` | Same |

## §3. System Overview
| Spec | Status | Module | Notes |
|---|---|---|---|
| §3.1.1 Workflow Loader | ✅ | `src/workflow/loader.ts` | gray-matter front matter + Markdown body, trimmed; explicit error on missing/empty/non-mapping front matter |
| §3.1.2 Config Layer | ✅ | `src/config/{schema,resolve,preflight}.ts` | Zod-validated typed view + env/home expansion + dispatch preflight |
| §3.1.3 Issue Tracker Client | ✅ | `src/linear/{client,adapter,gateway,issue}.ts` | `LinearGateway` interface + `SdkLinearGateway` over `@linear/sdk`; orchestrator-side fakes use the same interface |
| §3.1.4 Orchestrator | ✅ MVP | `src/orchestrator/{orchestrator,state}.ts` | Poll-and-dispatch, bounded concurrency, single fixed-delay retry; reconcile/recover deferred per SPEC-claude.md §F |
| §3.1.5 Workspace Manager | ✅ | `src/workspace/manager.ts` | Idempotent ensureWorkspace; after_create runs once on creation; before_remove deferred to Phase 2 |
| §3.1.6 Agent Runner | ✅ deviation | `src/agent/runner.ts` | `claude-agent-sdk` `query()`; turn + stall timeouts; external abort; usage aggregation; SPEC-claude.md §A |
| §3.1.7 Status Surface (OPTIONAL) | ⚪ Phase 3 | — | Logs only in MVP |
| §3.1.8 Logging | ✅ | `src/observability/log.ts` | `pino` multistream: synchronous JSONL file + stdout (pretty in TTY, raw otherwise); `writeOrchestratorEvent` projects events to log records |
| §3.2 Abstraction Layers | 🟡 | source tree | Folder layout mirrors the spec's six layers |
| §3.3 External Dependencies | 🟡 | `package.json`, `README.md` | Updated as we add each dep |

## §4. Core Domain Model
| Spec | Status | Module | Notes |
|---|---|---|---|
| §4.1.1 Issue entity | ✅ | `src/linear/issue.ts` | Normalized shape per §11.3; timestamps are ISO-8601 strings for log-friendliness |
| §4.1.2 Workflow Definition | ✅ | `src/workflow/loader.ts` | `WorkflowDefinition = { config, promptTemplate, sourcePath }` |
| §4.1.3 Service Config (typed view) | ✅ | `src/config/schema.ts` | Zod schema; ResolvedWorkflowConfig narrows api_key after resolve |
| §4.1.4 Workspace | ✅ | `src/workspace/manager.ts` | Represented by `WorkspaceLocation { path, created, hookResult }` |
| §4.1.5+ remaining entities (Run, Attempt, etc.) | 🟡 Phase 1/2 | `src/orchestrator/state.ts` | IssueRunState + RetryEntry + attempt counters in MVP; full Run/Attempt lifecycle in Phase 2 |
| §4.2 Stable IDs / normalization | 🔵 Phase 1 | `src/linear/adapter.ts` | |

## §5. Workflow Specification (Repository Contract)
| Spec | Status | Module | Notes |
|---|---|---|---|
| §5.1 File discovery and path resolution | ✅ | `src/workflow/loader.ts` | Explicit path argument; resolves relative paths via `path.resolve()` |
| §5.2 File format | ✅ | `src/workflow/loader.ts` | YAML front matter + Markdown body via gray-matter |
| §5.3.1–§5.3.5 `tracker`/`polling`/`workspace`/`hooks`/`agent` | ✅ | `src/config/schema.ts` | Preserved field-for-field; defaults applied |
| §5.3.6 `codex` block | ✅ deviation | `src/config/schema.ts` | Replaced by `claude:` block per `SPEC-claude.md` §B; `max_turns` accepts `[1, 200]` (default 20, matches upstream); `bypassPermissions` auto-sets `allowDangerouslySkipPermissions` SDK flag |
| §5.4 Prompt Template Contract | 🟡 Phase 1 / Phase 2 | `src/agent/prompt.ts` | `{{ name }}` and `{{ name.field }}` substitution with strict unknown-variable error; `{% if %}` / filters deferred to Phase 2 alongside continuation/turns |
| §5.5 Workflow validation and error surface | ✅ | `src/workflow/loader.ts`, `src/config/schema.ts` | WorkflowLoadError with file path; Zod errors with field path |

## §6. Configuration Specification
| Spec | Status | Module | Notes |
|---|---|---|---|
| §6.1 Resolution pipeline | ✅ | `src/config/resolve.ts` | Defaults via Zod; `$VAR`/`${VAR}` env-token expansion; `~` home expansion; api_key fallback to `LINEAR_API_KEY` |
| §6.2 Dynamic reload semantics | ⚪ Phase 3 | — | Static load at boot in MVP |
| §6.3 Dispatch preflight validation | ✅ | `src/config/preflight.ts` | Linear MCP detection (key or URL match); workspace.root parent existence; non-empty api_key |
| §6.4 Cheat sheet | ✅ deviation | `SPEC-claude.md` §B.1 | `codex.*` rows → `claude.*`; canonical table lives in SPEC-claude.md |

## §7. Orchestration State Machine
| Spec | Status | Module | Notes |
|---|---|---|---|
| §7.1 Issue orchestration states | ✅ MVP | `src/orchestrator/state.ts` | idle / claimed / running / completed / failed / retry_pending |
| §7.2 Run attempt lifecycle | 🟡 Phase 1 / Phase 2 | `src/orchestrator/state.ts` | attemptCount tracked; success-while-Linear-active requeues for continuation up to MAX_DISPATCHES=10; SDK-side multi-query session resume deferred to Phase 2 (B1) |
| §7.3 Transition triggers | ✅ MVP | `src/orchestrator/orchestrator.ts` | Poll tick + dispatch result + retry-cooldown elapse + post-success Linear refresh |
| §7.4 Idempotency and recovery rules | ⚪ Phase 2 | — | Restart recovery deferred |

## §8. Polling, Scheduling, and Reconciliation
| Spec | Status | Module | Notes |
|---|---|---|---|
| §8.1 Poll loop | ✅ MVP | `src/orchestrator/orchestrator.ts` | `setTimeout`-driven loop pinned to `polling.interval_ms`; `unref()` so timers don't keep the process alive |
| §8.2 Candidate selection | ✅ MVP | `src/orchestrator/orchestrator.ts` | Project + active-states filter; busy/completed/failed/cooldown skips |
| §8.3 Concurrency control | ✅ MVP | `src/orchestrator/orchestrator.ts` | `busyCount() < max_concurrent_agents`; `_by_state` Phase 2 |
| §8.4 Retry and backoff | 🟡 Phase 1 / Phase 2 | `src/orchestrator/orchestrator.ts` | One 30 s fixed-delay retry, then mark failed; exponential queue Phase 2 |
| §8.5 Active run reconciliation | ⚪ Phase 2 | — | |
| §8.6 Startup terminal workspace cleanup | ⚪ Phase 2 | — | |

## §9. Workspace Management and Safety
| Spec | Status | Module | Notes |
|---|---|---|---|
| §9.1 Workspace layout | ✅ | `src/workspace/manager.ts` | `<root>/<TEAM-NNN>/` via path-safety helper |
| §9.2 Creation and reuse | ✅ | `src/workspace/manager.ts` | mkdir+stat-based idempotency; second call returns `created: false` and skips hook |
| §9.3 OPTIONAL population | ✅ | `src/workspace/hooks.ts` | `after_create` runs in workspace cwd via `bash -lc`; output captured |
| §9.4 Workspace hooks | 🟡 Phase 1 / Phase 2 | `src/workspace/hooks.ts` | `after_create` ✅; `before_remove` Phase 2; SYMPHONY_* env vars injected |
| §9.5 Safety invariants | 🟡 Phase 1 | `src/util/path-safety.ts` | `assertSafeIssueIdentifier` + `joinWithinRoot` enforce confinement; agent-side enforcement (Q3) lands with agent runner |

## §10. Agent Runner Protocol
| Spec | Status | Module | Notes |
|---|---|---|---|
| §10 entire chapter | ✅ deviation | `src/agent/runner.ts` | Wholesale replacement — see `SPEC-claude.md` §A |
| §10.1 Launch contract | ✅ deviation | `src/agent/runner.ts` | `query()` factory call, no subprocess |
| §10.2 Session startup | ✅ deviation | `src/agent/runner.ts` | SDK `Options` from `claude:` block via `buildQueryOptions` |
| §10.3 Streaming turn processing | ✅ deviation | `src/agent/runner.ts` | Async-iterate SDK messages until `result` terminator |
| §10.4 Emitted events | 🟡 deviation | `src/agent/runner.ts` | Result + usage aggregation per `SPEC-claude.md` §A.4; per-turn synthetic events Phase 3 |
| §10.5 Approval / tool-call policy | ✅ deviation | `src/agent/runner.ts` | `permission_mode` + `allowed_tools` + `disallowed_tools` passed through |
| §10.6 Timeouts | ✅ Phase 1 | `src/agent/runner.ts` | Turn timeout + stall timeout via AbortController; read_timeout reserved for Phase 2 |
| §10.7 Agent runner contract | ✅ Phase 1 | `src/agent/runner.ts` | `AgentRunInput` / `AgentRunResult` boundary |

## §11. Issue Tracker Integration Contract (Linear)
| Spec | Status | Module | Notes |
|---|---|---|---|
| §11.1 REQUIRED operations | 🟡 Phase 1 / Phase 2 | `src/linear/client.ts` | `fetchActiveCandidates`, `fetchIssueByIdentifier` done; terminal-cleanup query deferred to Phase 2 (§8.6) |
| §11.2 Query semantics | ✅ | `src/linear/client.ts` | `project: { slugId: { eq } }` + `state.name.in`; page size 50; full pagination |
| §11.3 Normalization rules | ✅ | `src/linear/adapter.ts` | Lowercase labels, integer-only priority, ISO-8601 re-emission, blocked_by from inverse `blocks` relations |
| §11.4 Error handling contract | 🟡 Phase 1 | `src/linear/{client,gateway}.ts` | Single `LinearTrackerError` wrapping SDK errors via native `cause`; finer-grained classes deferred |
| §11.5 Tracker writes (boundary) | ✅ deviation | `src/agent/symphony-linear-server.ts`, `src/linear/writes.ts` | In-process `symphony_linear` MCP server gives the agent a 6-tool stable contract (get_current_issue, get_workpad, create_or_update_workpad, transition_state, attach_pr_url, post_comment) closure-bound to the dispatched issue. Public Linear MCP also wired for general access — see `SPEC-claude.md` §D |

## §12. Prompt Construction and Context Assembly
| Spec | Status | Module | Notes |
|---|---|---|---|
| §12.1 Inputs | ✅ | `src/agent/prompt.ts` | `PromptVariables = { issue, attempt }`; `buildIssueView` flattens null fields |
| §12.2 Rendering rules | 🟡 Phase 1 / Phase 2 | `src/agent/prompt.ts` | Strict unknown-variable failure for `{{ var }}` and `{{ var.field }}`; filters / `{% if %}` Phase 2 |
| §12.3 Retry/continuation semantics | ⚪ Phase 2 | `src/agent/prompt.ts` | `attempt = null` always in MVP — `SPEC-claude.md` §C |
| §12.4 Failure semantics | ✅ | `src/agent/prompt.ts` | `PromptRenderError` includes the offending excerpt for debugging |

## §13. Logging, Status, and Observability
| Spec | Status | Module | Notes |
|---|---|---|---|
| §13.1 Logging conventions | ✅ | `src/observability/log.ts` | JSONL with `service` base field + per-event fields (event, at, issueId, issueIdentifier, plus type-specific extras) |
| §13.2 Logging outputs and sinks | ✅ | `src/observability/log.ts` | File sink (sync, append) + stdout sink at info+; pino multistream |
| §13.3 Runtime snapshot / monitoring interface | ⚪ Phase 3 | — | |
| §13.4 OPTIONAL human-readable status surface | ⚪ Phase 3 | — | |
| §13.5 Session metrics and token accounting | 🟡 Phase 1 | `src/agent/runner.ts` | `AggregatedUsage` synthesized from result message `usage` + `total_cost_usd`; once-per-query semantics per Q2 |
| §13.6 Humanized event summaries (OPTIONAL) | ⚪ Phase 3 | — | |
| §13.7 OPTIONAL HTTP server extension | ⚪ Phase 3 | — | |

## §14. Failure Model and Recovery Strategy
| Spec | Status | Module | Notes |
|---|---|---|---|
| §14.1 Failure classes | 🔵 Phase 1 | `src/orchestrator/errors.ts` | Subset for MVP |
| §14.2 Recovery behavior | 🟡 Phase 1 / Phase 2 | `src/orchestrator/orchestrator.ts` | One retry only in MVP |
| §14.3 Partial state recovery (restart) | ⚪ Phase 2 | — | |
| §14.4 Operator intervention points | ✅ MVP | `bin/claude-symphony.ts`, logs | SIGINT/SIGTERM graceful drain via `orchestrator.stop()`; structured log inspection |

## §15. Security and Operational Safety
| Spec | Status | Module | Notes |
|---|---|---|---|
| §15.1 Trust boundary assumption | 🔵 Phase 1 | `README.md`, `SPEC-claude.md` §A.5 | Document the trusted-environment posture |
| §15.2 Filesystem safety requirements | 🟡 Phase 1 | `src/util/path-safety.ts` | Workspace-side enforcement done via `assertSafeIssueIdentifier` + `joinWithinRoot`; agent-side enforcement (Q3) lands with agent runner |
| §15.3 Secret handling | ✅ | `src/config/resolve.ts`, `src/observability/log.ts` | `$VAR` indirection at config load; logger never receives api_key (writeOrchestratorEvent filters event payloads to known-safe fields) |
| §15.4 Hook script safety | ✅ | `src/workspace/hooks.ts` | `bash -lc` in workspace cwd, detached process group for clean timeout-kill, captured stdout/stderr, exit-code propagation |
| §15.5 Harness hardening guidance | 🟡 | `README.md` | Operator-facing notes |

## §16. Reference Algorithms
| Spec | Status | Module | Notes |
|---|---|---|---|
| §16.1 Service startup | ✅ | `src/cli/main.ts`, `bin/claude-symphony.ts` | `runCli(argv)` boots the orchestrator from a WORKFLOW.md path; bin entry adds SIGINT/SIGTERM graceful shutdown |
| §16.2 Poll-and-dispatch tick | ✅ MVP | `src/orchestrator/orchestrator.ts` | `Orchestrator.tick()` |
| §16.3 Reconcile active runs | ⚪ Phase 2 | — | |
| §16.4 Dispatch one issue | ✅ MVP | `src/orchestrator/orchestrator.ts` | `dispatchOne` ties workspace + prompt + agent runner |
| §16.5 Worker attempt | 🟡 Phase 1 | `src/agent/runner.ts` | Single-turn variant complete; multi-turn loop deferred per SPEC-claude.md §C |
| §16.6 Worker exit + retry handling | 🟡 Phase 1 | `src/orchestrator/orchestrator.ts` | One fixed-delay retry, then `failed` |

## §17. Test and Validation Matrix
| Spec | Status | Module | Notes |
|---|---|---|---|
| §17.1 Workflow + config parsing | ✅ | `tests/config/`, `tests/workflow/` | 43 vitest tests; ~92% line / 85% branch coverage on covered modules |
| §17.2 Workspace manager + safety | ✅ | `tests/workspace/`, `tests/util/path-safety.test.ts` | 24 vitest tests covering idempotency, hook execution, env injection, timeout-kill, path-safety guards |
| §17.3 Issue tracker client | ✅ | `tests/linear/` | 32 vitest tests against a stub `IssuesQueryClient`: pagination, filter shape, adapter integration, identifier parser, error wrapping |
| §17.4 Orchestrator dispatch + retry | ✅ MVP | `tests/orchestrator/` | 16 vitest tests: state lifecycle, dispatch, concurrency cap, retry cooldown, second-failure → failed, fetch-error survival |
| §17.5 Coding-agent app-server client | ✅ deviation | `tests/agent/` | 23 vitest tests with fake QueryFactory: prompt rendering edge cases, options mapping, happy path, result-subtype error mapping, abort/turn/stall timeouts |
| §17.6 Observability | ✅ | `tests/observability/log.test.ts` | 6 vitest tests: JSONL file write, custom filename, event-to-record projections per event type and level |
| §17.7 CLI and host lifecycle | ✅ MVP | `tests/cli/main.test.ts` | 10 tests: parseArgs, --logs-root / --port / --help / unknown flags / extra positionals; runCli end-to-end with stub agent + linear; preflight failure surfacing |
| §17.8 Real integration profile | 🔵 Phase 1 | `tests/e2e/` | Awaits operator-side action: create Linear project, set LINEAR_API_KEY, edit `examples/chronicle.WORKFLOW.md` slug, run on a test ticket |

## §18. Implementation Checklist (Definition of Done)
| Spec | Status | Module | Notes |
|---|---|---|---|
| §18.1 REQUIRED for conformance | 🔵 long-term | — | Tracked across phases; full conformance is Phase 3 exit gate |
| §18.2 RECOMMENDED extensions | ⚪ as-needed | — | |
| §18.3 Operational validation before production | ⚪ as-needed | — | |

## Appendix A. SSH Worker Extension
| Spec | Status | Module | Notes |
|---|---|---|---|
| A.1–A.3 | ⚪ Phase 4 | — | Out of scope for Phases 1–3 — `SPEC-claude.md` §G |

---

## Retired — control-plane re-scope

The daemon was re-scoped from a poll-and-dispatch loop to a UI-driven control plane with human approval gates (see `SPEC-claude.md` → "Control-plane re-scope"). The rows below are **retired**: Linear polling, autonomous candidate dispatch, and the orchestrator-side multi-`query()` continuation loop are no longer part of the design. Their original spec sections are preserved for upstream traceability, but the corresponding MVP behaviour is superseded by the control-plane lifecycle.

| Spec / feature | Status | Notes |
|---|---|---|
| §8.1 Poll loop | ⚪ Retired | No poll loop — the control plane is UI-driven, not tracker-polled |
| §8.2 Candidate selection | ⚪ Retired | No autonomous candidate dispatch; tasks enter via the board (`queued`) |
| §8.3 Concurrency control (poll-side) | ⚪ Retired | Slot accounting moves to the control-plane dispatcher; see new rows |
| §16.2 Poll-and-dispatch tick | ⚪ Retired | Replaced by the human-gated lifecycle transition engine |
| §7.2 / §12.3 Orchestrator-driven multi-`query()` continuation | ⚪ Retired | Continuation is the explicit lifecycle (`executing → reviewing → gapfixing → …`), not a re-`query()` loop — `SPEC-claude.md` §C is moot |
| §11.5 Tracker writes via injected client | ⚪ Retired | Linear is read-only in the control plane; no orchestrator/agent write surface |

## Control-plane modules (new)

New modules introduced by the re-scope. Lifecycle: `queued → prepping → awaiting_approval → approved → executing → reviewing → {gapfixing | closing} → closing → previewing → ready → done | abandoned`.

| Module | Status | Notes |
|---|---|---|
| Process manager / run wrapper | 🟡 Partial | `src/control-plane/{process-manager,proc}.ts` — spawns one `claude -p` agent per lifecycle stage under a minimal env allowlist |
| `LinearReadGateway` | 🟡 Partial | `src/control-plane/linear-read.ts` — read-only Linear access via a read-scoped token (`linear.read_token_env`, never `LINEAR_API_KEY`) over the AI gateway proto |
| Intake | 🟡 Partial | `src/control-plane/intake.ts` — turns an approved Linear item into a `queued` task with a worktree forked from `workspace.base_branch` |
| Settings deny policy | 🟡 Partial | `src/control-plane/settings-policy.ts` — Claude Code settings deny list applied to each agent — defense-in-depth layer 1 |
| Hardened pre-push | 🟡 Partial | `src/control-plane/pre-push.ts` — pre-push hook restricting the agent to pushing only its own task branch — layer 2 |
| Dispatcher engine | 🟡 Partial | `src/control-plane/{config,task-store,slots,lock,phase,engine,routing}.ts` — config schema, single-daemon lock, synchronous slot counter, boot scan/snapshot index, and the lifecycle transition engine |
| Daemon | 🟡 Partial | `src/control-plane/daemon.ts` — single-instance (proper-lockfile) host; web board binds to a private address / loopback (never a wildcard); env allowlist is layer 3; intake runs at the `queued → prepping` promotion |
| Web auth gate | 🟡 Partial | `src/control-plane/web/auth.ts` — ONE global bearer middleware before all routes: constant-time compare, rate-limited, HttpOnly session cookie |
| Web API (§9 endpoints) | 🟡 Partial | `src/control-plane/web/routes.ts` — POST/GET `/tasks(/:id)` + gate actions (answers, approve, reject, ack, approve-preview, request-changes, teardown, retry); each a phase+rev CAS through `TaskStore`; never spawns a process / never enters a ⊕ phase; `/retry` sets a transition-free flag the Engine acts on |
| Board / detail render | 🟡 Partial | `src/control-plane/web/views.ts` — server-rendered HTML + htmx board (`renderBoard` / `renderDetail` / `renderTaskCard`); no client framework |
| App / server | 🟡 Partial | `src/control-plane/web/server.ts` — Hono `createApp` / `startWebServer`; binds to a non-wildcard host from config |
| Config loader | 🟡 Partial | `src/control-plane/config-loader.ts` — `loadControlPlaneConfig` reads a `WORKFLOW.md`-style file via the front-matter contract |
| Control-plane bin | 🟡 Partial | `bin/control-plane.ts` — co-hosts the daemon (lock + Engine tick loop) and the web board in one process |
| Public-invariant grep guard | ✅ | `scripts/check-public-invariants.sh` + `tests/control-plane/public-invariants.test.ts` — fails on box/Pinley specifics or secrets in tracked files (§11/§13) |

---

## Out-of-spec additions

Things `claude-symphony` introduces that have no upstream `SPEC.md` counterpart. Each MUST be justified.

| Item | Justification | Status |
|---|---|---|
| `claude:` front-matter block | Replaces `codex:`; required by the SDK transport | 🔵 Phase 1 |
| `claude.mcp_servers` config | Linear MCP and any project-specific MCP servers must reach the agent | 🔵 Phase 1 |
| `claude.system_prompt_append` | SDK supports prompt appending; useful for project-wide rules without editing per-issue prompts | 🔵 Phase 1 |
