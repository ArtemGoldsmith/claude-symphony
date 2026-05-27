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
      root: NonEmpty,
      base_branch: NonEmpty.default('origin/development'),
    }),
    agent: z
      .object({
        // Lowered from the daemon's 5 (schema.ts:59) — RAM-bound on a 16GB box (spec §10/§13).
        max_concurrent_agents: z.number().int().positive().default(2),
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
  .strip(); // Unknown keys are dropped (forward-compat).

export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;

export function parseControlPlaneConfig(raw: unknown): ControlPlaneConfig {
  return ControlPlaneConfigSchema.parse(raw);
}
