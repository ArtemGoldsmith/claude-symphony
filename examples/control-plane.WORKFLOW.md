---
# claude-symphony control-plane config (example, placeholders only)
#
# This file documents the ControlPlaneConfig shape (see
# src/control-plane/config.ts). It is the UI-driven control-plane successor to
# the polling WORKFLOW.md (see examples/chronicle.WORKFLOW.md and the
# "Control-plane re-scope" section of SPEC-claude.md).
#
# Every value below is an OBVIOUS PLACEHOLDER. The public repo carries NO box
# specifics — no Tailscale IP, no *.ts.net host, no real home path, no ntfy
# topic, no ticket numbers. The real wiring lives outside the public repo.
#
# Env var NAMES are referenced here; the SECRET VALUES are supplied at runtime
# via the environment, never committed.

# Root for the daemon's durable state (task-store, snapshots, locks).
state_root: /abs/path/to/control-plane-state

workspace:
  # Per-task worktrees land under <root>/<TEAM-NNN>/.
  root: /abs/path/to/worktrees
  # Branch the worktree is forked from. Feature branches not merged here are
  # invisible to the agent.
  base_branch: origin/development

agent:
  # Cap on concurrent agents. RAM-bound on a small box; raise once trusted.
  max_concurrent_agents: 2
  # Model passed to `claude -p --model`.
  model: opus
  # Extra env var NAMES forwarded to the spawned agent beyond the minimal
  # allowlist. Build essentials only (e.g. DOCKER_HOST, GOPATH) — NEVER
  # secrets. The board bearer token and push creds are never listed here.
  extra_env: []

web:
  # NEVER a wildcard (0.0.0.0 / ::). A Tailscale IP or loopback only.
  bind_host: <TAILSCALE_IP_OR_127.0.0.1>
  port: 8787
  # Env var NAME holding the board's bearer token (the value is supplied at
  # runtime, never committed).
  auth_token_env: SYMPHONY_BOARD_TOKEN

preview:
  # Scripts that bring a per-task preview environment up/down.
  up_script: /abs/path/to/preview-up.sh
  down_script: /abs/path/to/preview-down.sh

prompts:
  # Paths to the prompt templates for each lifecycle stage.
  prep: /abs/path/to/prompts/prep.md
  execute: /abs/path/to/prompts/execute.md
  review: /abs/path/to/prompts/review.md
  gapfix: /abs/path/to/prompts/gapfix.md
  closeout: /abs/path/to/prompts/closeout.md

linear:
  # Env var NAME holding a READ-SCOPED Linear token. Must NOT be LINEAR_API_KEY
  # (full write) and must NOT equal web.auth_token_env. This is the ONLY token
  # allowed to reach the agent env.
  read_token_env: LINEAR_READ_TOKEN
  # Path to the Linear AI gateway proto used by the read gateway.
  ai_proto_path: /abs/path/to/linear-ai.proto
---

# Control-plane config example

This is the example config for the **control-plane** daemon — the UI-driven
successor to the polling orchestrator. Unlike `examples/chronicle.WORKFLOW.md`
(which configures the retired poll-and-dispatch loop), the control plane:

- has **no `tracker.polling`** block — there is no poll loop;
- exposes a small web board (bound to a Tailscale IP or loopback, never a
  wildcard) where a human approves each task at the gates;
- dispatches agents via `claude -p` + a run wrapper, one per lifecycle stage;
- gives the agent only a **read-scoped** Linear token (`linear.read_token_env`)
  and a minimal env allowlist — the board bearer and push creds never reach it.

The lifecycle and defense-in-depth posture are described in the
"Control-plane re-scope" section of [`SPEC-claude.md`](../SPEC-claude.md); the
field-by-field schema (with the secret-leak refinements) lives in
[`src/control-plane/config.ts`](../src/control-plane/config.ts).

**All values above are placeholders.** The detailed box wiring — real Tailscale
IP, host name, home paths, ntfy topic, and the prompt template contents — is
deliberately kept **outside the public repo**. A tracked-file grep guard
(`scripts/check-public-invariants.sh`, enforced by
`tests/control-plane/public-invariants.test.ts`) fails the build if any of
those specifics or secrets are ever committed.
