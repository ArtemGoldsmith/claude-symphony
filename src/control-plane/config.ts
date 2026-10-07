// src/control-plane/config.ts
// Spec §13 control-plane config. Mirrors src/config/schema.ts style (zod,
// .default, parseX). No tracker.polling; no Linear write surface. Paths point
// at deployment-local files — never vendored in the public repo.

import path from 'node:path';

import { z } from 'zod';

const NonEmpty = z.string().min(1);

export const ControlPlaneConfigSchema = z
  .object({
    state_root: NonEmpty,
    workspace: z.object({
      // Shared repo root: where `git worktree add` runs and .git/hooks lives.
      repo: NonEmpty,
      // Per-task worktrees land under <root>/<TEAM-NNN>/.
      root: NonEmpty,
      base_branch: NonEmpty.default('origin/development'),
    }),
    agent: z
      .object({
        // Lower than the polling daemon's 5 to bound memory on small hosts (spec §10/§13).
        max_concurrent_agents: z.number().int().positive().default(2),
        // Model passed to `claude -p --model`. Spec §6 pins opus; configurable.
        model: NonEmpty.default('opus'),
        // Extra env var NAMES forwarded to the spawned agent beyond the minimal
        // allowlist (spec §6/§11). For host build essentials only (e.g. DOCKER_HOST,
        // GOPATH) — NEVER secrets; the daemon's bearer/push creds are never listed.
        extra_env: z.array(NonEmpty).default([]),
      })
      .default({}),
    web: z.object({
      // Spec §9: never a wildcard — a Tailscale IP or loopback only.
      // .refine runs on supplied values; .default('127.0.0.1') applies when absent.
      bind_host: NonEmpty.refine((h) => h !== '0.0.0.0' && h !== '::', {
        message:
          'web.bind_host must not be a wildcard (0.0.0.0 / ::) — use the Tailscale IP or 127.0.0.1',
      }).default('127.0.0.1'),
      port: z.number().int().positive().default(8787),
      auth_token_env: NonEmpty,
      // Discuss terminal: opt-in PTY-over-WebSocket surface for the
      // tasks board. Disabled by default; the daemon refuses to spawn until
      // enabled=true. Limits below cap RAM/CPU and bound idle sessions (§9).
      discuss_terminal: z
        .object({
          enabled: z.boolean().default(false),
          idle_timeout_seconds: z.number().int().positive().default(1800),
          heartbeat_seconds: z.number().int().positive().default(30),
          pong_grace_seconds: z.number().int().positive().default(60),
          max_concurrent_global: z.number().int().positive().default(4),
          pty_kill_timeout_ms: z.number().int().positive().default(3000),
          allow_writes: z.boolean().default(false),
        })
        .default({
          enabled: false,
          idle_timeout_seconds: 1800,
          heartbeat_seconds: 30,
          pong_grace_seconds: 60,
          max_concurrent_global: 4,
          pty_kill_timeout_ms: 3000,
          allow_writes: false,
        }),
    }),
    preview: z.object({
      up_script: NonEmpty,
      down_script: NonEmpty,
      // Wall-clock ceiling for a preview/teardown run (the docker build is otherwise
      // unbounded). probeExit group-kills past this → preview_failed/teardown_failed (§8.1).
      timeout_seconds: z.number().int().positive().default(1800),
      // Extra env var NAMES forwarded to the preview SCRIPTS beyond the minimal
      // allowlist (e.g. DOCKER_HOST). NEVER secrets, NEVER the Linear token (§8.1/§8.3).
      extra_env: z.array(NonEmpty).default([]),
      // Docker compose project-name prefix for the agent's transient stack
      // (`<prefix>-<ticket>`) and the preview stack (`<prefix>-preview-<ticket>`)
      // that the daemon force-downs. Optional: when absent it is derived from the
      // basename of workspace.repo (see composeProjectPrefix), so it must match
      // whatever prefix your preview scripts / repo compose files use.
      compose_project_prefix: z
        .string()
        .regex(/^[a-z0-9][a-z0-9_-]*$/, 'preview.compose_project_prefix must be a valid lowercase docker compose project name')
        .optional(),
    }),
    prompts: z.object({
      prep: NonEmpty,
      execute: NonEmpty,
      review: NonEmpty,
      gapfix: NonEmpty,
      closeout: NonEmpty,
    }),
    linear: z.object({
      read_token_env: NonEmpty,
      // Path to a read-only design-prototype checkout (git pull --ff-only at prep);
      // surfaced to the agent as reference material. Key name kept for compat.
      ai_proto_path: NonEmpty,
    }),
  })
  .strip() // Unknown keys are dropped (forward-compat).
  .superRefine((cfg, ctx) => {
    const SECRETISH = /(_KEY|_SECRET|_TOKEN|PASSWORD|BEARER)$/i;
    // The read-scoped Linear token is the ONLY token allowed into the agent env.
    if (cfg.linear.read_token_env === 'LINEAR_API_KEY') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['linear', 'read_token_env'],
        message: 'read_token_env must be a READ-scoped token env, never LINEAR_API_KEY (full write)' });
    }
    if (cfg.linear.read_token_env === cfg.web.auth_token_env) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['linear', 'read_token_env'],
        message: 'read_token_env must not equal the board auth token env' });
    }
    for (const name of cfg.agent.extra_env) {
      if (SECRETISH.test(name) || name === cfg.web.auth_token_env || name === 'LINEAR_API_KEY') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['agent', 'extra_env'],
          message: `extra_env entry "${name}" looks like a secret; only the read-scoped Linear token may reach the agent` });
      }
    }
    for (const name of cfg.preview.extra_env) {
      if (SECRETISH.test(name) || name === cfg.web.auth_token_env || name === 'LINEAR_API_KEY' || name === cfg.linear.read_token_env) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['preview', 'extra_env'],
          message: `preview.extra_env entry "${name}" looks like a secret; preview scripts source their own secrets file` });
      }
    }
  });

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;

/** Docker compose project names allow only [a-z0-9_-] and must start with a letter/digit. */
function toComposeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '');
}

/** Resolved compose project prefix: explicit preview.compose_project_prefix, else
 *  the lowercased basename of workspace.repo (docker compose's own default project
 *  name for a checkout of that repo). */
export function composeProjectPrefix(config: Pick<ControlPlaneConfig, 'workspace' | 'preview'>): string {
  const explicit = config.preview.compose_project_prefix;
  if (explicit) return explicit;
  return toComposeName(path.basename(config.workspace.repo));
}

export function parseControlPlaneConfig(raw: unknown): ControlPlaneConfig {
  return ControlPlaneConfigSchema.parse(raw);
}
