# Contributing to claude-symphony

Early-stage repo. The rules below exist to keep `SPEC-claude.md` and `PARITY.md` honest as the port progresses.

## Language

All committed artifacts — documentation, code comments, JSDoc/TSDoc, commit messages, PR descriptions, fixtures, and `WORKFLOW.md` examples — are written in **English only**.

## The PARITY rule

Every commit that ports a section of `openai/symphony` `SPEC.md` MUST also update the matching row(s) in `PARITY.md` in the same commit. Specifically:

- A row moves from `🔵 Planned` to `🟡 Partial` when first code lands for that row, even if not all aspects are covered.
- A row moves from `🟡 Partial` to `✅ Done` only when the row's spec section is fully implemented for the targeted phase **and** covered by tests in `tests/`.
- A row moves from `🔵` directly to `⚪ Skipped` only with a one-line justification appended to its row notes; never silently.

If a commit touches code under `src/` or `bin/` that maps to a `PARITY` row but does not move the row's status, the commit message MUST explain why (e.g., "internal refactor, no spec progress").

## Module headers

Every TypeScript module that maps to a `PARITY` row begins with a one-line comment pointing at the spec sections and PARITY anchor:

```ts
// SPEC.md §X.Y + §A.B — Module Name. PARITY.md row: §X.Y.
// Deviations: SPEC-claude.md §Z (when relevant).
```

Reviewers can grep for `SPEC.md §` to audit coverage.

## Tests

- `vitest`. Tests live under `tests/`, mirroring the `src/` tree.
- Unit tests are required for any new public function or class. The MVP coverage gate is **70% lines / functions / branches / statements** (enforced in `vitest.config.ts`).
- The end-to-end test under `tests/e2e/` runs against real external services (Linear, Anthropic) and is gated by env vars — it does NOT run in the default `pnpm test` command.

## Commit messages

Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`). Subject ≤ 72 chars. Body explains the *why* and references the PARITY row id where applicable. Example:

```
feat(workflow): parse YAML front matter and Markdown body

Implements PARITY rows §3.1.1 + §5.2 + §5.3.1–§5.3.5 (claude block in
§5.3.6 deviation per SPEC-claude.md §B). Strict Zod validation on the
front matter; body trimmed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

## Open design questions

When a deviation or unanswered design choice surfaces during implementation:

1. Add a row under `SPEC-claude.md` "Open design questions" with a `Q<N>` id.
2. Reference the `Q<N>` from any code comment that depends on the eventual answer.
3. Resolve the question before the phase it blocks; remove the row when resolved and inline the answer into the appropriate `SPEC-claude.md` section.

## Hard rules baked into the design

These are not negotiable and will not be re-debated:

1. The Codex app-server protocol is NOT implemented. `@anthropic-ai/claude-agent-sdk` is the agent transport.
2. The `linear_graphql` injected client tool is NOT implemented. The agent uses Linear's public MCP server.
3. SSH worker pools are out of scope until Phase 4. Single-host execution only.
