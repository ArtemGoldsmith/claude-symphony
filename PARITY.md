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
| §3.1.3 Issue Tracker Client | 🔵 Phase 1 | `src/linear/client.ts`, `src/linear/adapter.ts` | `@linear/sdk` |
| §3.1.4 Orchestrator | 🔵 Phase 1 | `src/orchestrator/orchestrator.ts` | MVP subset (see §F of SPEC-claude.md) |
| §3.1.5 Workspace Manager | 🔵 Phase 1 | `src/workspace/manager.ts` | `after_create` hook only in MVP |
| §3.1.6 Agent Runner | 🔵 Phase 1 | `src/agent/runner.ts` | `claude-agent-sdk`; replaces §10 wholesale per `SPEC-claude.md` §A |
| §3.1.7 Status Surface (OPTIONAL) | ⚪ Phase 3 | — | Logs only in MVP |
| §3.1.8 Logging | 🔵 Phase 1 | `src/observability/log.ts` | `pino` JSONL |
| §3.2 Abstraction Layers | 🟡 | source tree | Folder layout mirrors the spec's six layers |
| §3.3 External Dependencies | 🟡 | `package.json`, `README.md` | Updated as we add each dep |

## §4. Core Domain Model
| Spec | Status | Module | Notes |
|---|---|---|---|
| §4.1.1 Issue entity | 🔵 Phase 1 | `src/linear/issue.ts` | Normalized shape per §11.3 |
| §4.1.2 Workflow Definition | ✅ | `src/workflow/loader.ts` | `WorkflowDefinition = { config, promptTemplate, sourcePath }` |
| §4.1.3 Service Config (typed view) | ✅ | `src/config/schema.ts` | Zod schema; ResolvedWorkflowConfig narrows api_key after resolve |
| §4.1.4 Workspace | 🔵 Phase 1 | `src/workspace/manager.ts` | |
| §4.1.5+ remaining entities (Run, Attempt, etc.) | 🔵 Phase 1/2 | `src/orchestrator/state.ts` | Some fields land in MVP; full lifecycle in Phase 2 |
| §4.2 Stable IDs / normalization | 🔵 Phase 1 | `src/linear/adapter.ts` | |

## §5. Workflow Specification (Repository Contract)
| Spec | Status | Module | Notes |
|---|---|---|---|
| §5.1 File discovery and path resolution | ✅ | `src/workflow/loader.ts` | Explicit path argument; resolves relative paths via `path.resolve()` |
| §5.2 File format | ✅ | `src/workflow/loader.ts` | YAML front matter + Markdown body via gray-matter |
| §5.3.1–§5.3.5 `tracker`/`polling`/`workspace`/`hooks`/`agent` | ✅ | `src/config/schema.ts` | Preserved field-for-field; defaults applied |
| §5.3.6 `codex` block | ✅ deviation | `src/config/schema.ts` | Replaced by `claude:` block per `SPEC-claude.md` §B; MVP guard rejects `max_turns > 1` |
| §5.4 Prompt Template Contract | 🔵 Phase 1 | `src/agent/prompt.ts` | Liquid-style `{{ }}` substitution; strict unknown-variable error |
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
| §7.1 Issue orchestration states | 🔵 Phase 1 | `src/orchestrator/state.ts` | Subset matching MVP transitions |
| §7.2 Run attempt lifecycle | 🟡 Phase 1 / Phase 2 | `src/orchestrator/state.ts` | Single-attempt in MVP; multi-turn deferred per `SPEC-claude.md` §C |
| §7.3 Transition triggers | 🔵 Phase 1 | `src/orchestrator/orchestrator.ts` | Poll tick + completion only in MVP |
| §7.4 Idempotency and recovery rules | ⚪ Phase 2 | — | Restart recovery deferred |

## §8. Polling, Scheduling, and Reconciliation
| Spec | Status | Module | Notes |
|---|---|---|---|
| §8.1 Poll loop | 🔵 Phase 1 | `src/orchestrator/orchestrator.ts` | |
| §8.2 Candidate selection | 🔵 Phase 1 | `src/linear/client.ts`, `src/orchestrator/orchestrator.ts` | Project filter + active states only in MVP |
| §8.3 Concurrency control | 🔵 Phase 1 | `src/orchestrator/orchestrator.ts` | `agent.max_concurrent_agents`; `_by_state` deferred |
| §8.4 Retry and backoff | 🟡 Phase 1 / Phase 2 | `src/orchestrator/retry.ts` | One fixed-delay retry in MVP; full backoff queue Phase 2 |
| §8.5 Active run reconciliation | ⚪ Phase 2 | — | |
| §8.6 Startup terminal workspace cleanup | ⚪ Phase 2 | — | |

## §9. Workspace Management and Safety
| Spec | Status | Module | Notes |
|---|---|---|---|
| §9.1 Workspace layout | 🔵 Phase 1 | `src/workspace/manager.ts` | `<root>/<issue_identifier>/` |
| §9.2 Creation and reuse | 🔵 Phase 1 | `src/workspace/manager.ts` | Idempotent create; reuse on retry |
| §9.3 OPTIONAL population | 🔵 Phase 1 | `src/workspace/hooks.ts` | Via `after_create` hook |
| §9.4 Workspace hooks | 🟡 Phase 1 / Phase 2 | `src/workspace/hooks.ts` | `after_create` in MVP; `before_remove` Phase 2 |
| §9.5 Safety invariants | 🟡 Phase 1 | `src/util/path-safety.ts` | Cwd-rooted SDK + `claude.disallowed_tools`; `canUseTool` callback decision tracked as `SPEC-claude.md` Q3 |

## §10. Agent Runner Protocol
| Spec | Status | Module | Notes |
|---|---|---|---|
| §10 entire chapter | 🟡 deviation | `src/agent/runner.ts` | Wholesale replacement — see `SPEC-claude.md` §A |
| §10.1 Launch contract | 🟡 deviation | `src/agent/runner.ts` | `query()` factory call, no subprocess |
| §10.2 Session startup | 🟡 deviation | `src/agent/runner.ts` | SDK `Options` from `claude:` block |
| §10.3 Streaming turn processing | 🟡 deviation | `src/agent/runner.ts` | Async-iterate SDK messages |
| §10.4 Emitted events | 🟡 deviation | `src/agent/runner.ts` | Mapped per `SPEC-claude.md` §A.4 |
| §10.5 Approval / tool-call policy | 🟡 deviation | `src/agent/runner.ts`, `src/util/path-safety.ts` | `permission_mode` + `disallowed_tools` |
| §10.6 Timeouts | 🔵 Phase 1 | `src/agent/runner.ts` | Turn + read; stall in Phase 2 |
| §10.7 Agent runner contract | 🔵 Phase 1 | `src/agent/runner.ts` | |

## §11. Issue Tracker Integration Contract (Linear)
| Spec | Status | Module | Notes |
|---|---|---|---|
| §11.1 REQUIRED operations | 🔵 Phase 1 | `src/linear/client.ts` | `fetch_candidate_issues`, `fetch_issue_state(id)`, terminal-cleanup |
| §11.2 Query semantics | 🔵 Phase 1 | `src/linear/client.ts` | `project: { slugId: { eq } }`, page size 50, full pagination |
| §11.3 Normalization rules | 🔵 Phase 1 | `src/linear/adapter.ts` | Lowercase labels, ISO-8601 timestamps, etc. |
| §11.4 Error handling contract | 🔵 Phase 1 | `src/linear/client.ts` | Mapped error classes |
| §11.5 Tracker writes (boundary) | 🟡 deviation | (agent-side) | Linear MCP server replaces `linear_graphql` tool — `SPEC-claude.md` §D |

## §12. Prompt Construction and Context Assembly
| Spec | Status | Module | Notes |
|---|---|---|---|
| §12.1 Inputs | 🔵 Phase 1 | `src/agent/prompt.ts` | Issue + workflow template + attempt counter |
| §12.2 Rendering rules | 🔵 Phase 1 | `src/agent/prompt.ts` | Strict filter checking; unknown-variable failure |
| §12.3 Retry/continuation semantics | ⚪ Phase 2 | `src/agent/prompt.ts` | `attempt = null` always in MVP — `SPEC-claude.md` §C |
| §12.4 Failure semantics | 🔵 Phase 1 | `src/agent/prompt.ts` | Render errors mapped per spec |

## §13. Logging, Status, and Observability
| Spec | Status | Module | Notes |
|---|---|---|---|
| §13.1 Logging conventions | 🔵 Phase 1 | `src/observability/log.ts` | `pino` JSONL, structured fields per spec |
| §13.2 Logging outputs and sinks | 🔵 Phase 1 | `src/observability/log.ts` | File + stdout |
| §13.3 Runtime snapshot / monitoring interface | ⚪ Phase 3 | — | |
| §13.4 OPTIONAL human-readable status surface | ⚪ Phase 3 | — | |
| §13.5 Session metrics and token accounting | 🟡 Phase 1 | `src/observability/metrics.ts` | Mapped from SDK `result.usage` — `SPEC-claude.md` Q2 |
| §13.6 Humanized event summaries (OPTIONAL) | ⚪ Phase 3 | — | |
| §13.7 OPTIONAL HTTP server extension | ⚪ Phase 3 | — | |

## §14. Failure Model and Recovery Strategy
| Spec | Status | Module | Notes |
|---|---|---|---|
| §14.1 Failure classes | 🔵 Phase 1 | `src/orchestrator/errors.ts` | Subset for MVP |
| §14.2 Recovery behavior | 🟡 Phase 1 / Phase 2 | `src/orchestrator/orchestrator.ts` | One retry only in MVP |
| §14.3 Partial state recovery (restart) | ⚪ Phase 2 | — | |
| §14.4 Operator intervention points | 🟡 Phase 1 | `bin/claude-symphony.ts`, logs | Logs + manual workspace inspection |

## §15. Security and Operational Safety
| Spec | Status | Module | Notes |
|---|---|---|---|
| §15.1 Trust boundary assumption | 🔵 Phase 1 | `README.md`, `SPEC-claude.md` §A.5 | Document the trusted-environment posture |
| §15.2 Filesystem safety requirements | 🔵 Phase 1 | `src/util/path-safety.ts` | SDK cwd + permission flags + decision Q3 |
| §15.3 Secret handling | 🟡 Phase 1 | `src/config/resolve.ts` | `$VAR` indirection works; "never log resolved tokens" guarantee enforced once logging lands (PARITY row §13.1) |
| §15.4 Hook script safety | 🔵 Phase 1 | `src/workspace/hooks.ts` | Run with `bash -lc`, captured stdout/stderr |
| §15.5 Harness hardening guidance | 🟡 | `README.md` | Operator-facing notes |

## §16. Reference Algorithms
| Spec | Status | Module | Notes |
|---|---|---|---|
| §16.1 Service startup | 🔵 Phase 1 | `bin/claude-symphony.ts` | |
| §16.2 Poll-and-dispatch tick | 🔵 Phase 1 | `src/orchestrator/orchestrator.ts` | |
| §16.3 Reconcile active runs | ⚪ Phase 2 | — | |
| §16.4 Dispatch one issue | 🔵 Phase 1 | `src/orchestrator/orchestrator.ts` | |
| §16.5 Worker attempt | 🟡 Phase 1 | `src/agent/runner.ts` | Single-turn variant |
| §16.6 Worker exit + retry handling | 🟡 Phase 1 | `src/orchestrator/retry.ts` | Single retry |

## §17. Test and Validation Matrix
| Spec | Status | Module | Notes |
|---|---|---|---|
| §17.1 Workflow + config parsing | ✅ | `tests/config/`, `tests/workflow/` | 43 vitest tests; ~92% line / 85% branch coverage on covered modules |
| §17.2 Workspace manager + safety | 🔵 Phase 1 | `tests/workspace/` | |
| §17.3 Issue tracker client | 🔵 Phase 1 | `tests/linear/` | Mocked GraphQL |
| §17.4 Orchestrator dispatch + retry | 🔵 Phase 1 | `tests/orchestrator/` | Fake clock |
| §17.5 Coding-agent app-server client | 🟡 deviation | `tests/agent/` | Fake `claude-agent-sdk` `query()` |
| §17.6 Observability | 🔵 Phase 1 | `tests/observability/` | Log shape assertions |
| §17.7 CLI and host lifecycle | 🔵 Phase 1 | `tests/cli.test.ts` | Smoke + signal handling |
| §17.8 Real integration profile | 🔵 Phase 1 | `tests/e2e/` | One end-to-end run against real Chronicle ticket = MVP DoD |

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

## Out-of-spec additions

Things `claude-symphony` introduces that have no upstream `SPEC.md` counterpart. Each MUST be justified.

| Item | Justification | Status |
|---|---|---|
| `claude:` front-matter block | Replaces `codex:`; required by the SDK transport | 🔵 Phase 1 |
| `claude.mcp_servers` config | Linear MCP and any project-specific MCP servers must reach the agent | 🔵 Phase 1 |
| `claude.system_prompt_append` | SDK supports prompt appending; useful for project-wide rules without editing per-issue prompts | 🔵 Phase 1 |
