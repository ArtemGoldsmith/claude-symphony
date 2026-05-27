// src/control-plane/config.ts
// Spec §13 control-plane config. Mirrors src/config/schema.ts style (zod,
// .default, parseX). No tracker.polling; no Linear write surface. Paths point
// into the private repo/box — never vendored in the public repo.

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
        // Lowered from the daemon's 5 — RAM-bound on a 16GB box (spec §10/§13).
        max_concurrent_agents: z.number().int().positive().default(2),
        // Model passed to `claude -p --model`. Spec §6 pins opus; configurable.
        model: NonEmpty.default('opus'),
        // Extra env var NAMES forwarded to the spawned agent beyond the minimal
        // allowlist (spec §6/§11). For box build essentials only (e.g. DOCKER_HOST,
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
    }),
    preview: z.object({
      up_script: NonEmpty,
      down_script: NonEmpty,
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
  });

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;

export function parseControlPlaneConfig(raw: unknown): ControlPlaneConfig {
  return ControlPlaneConfigSchema.parse(raw);
}
