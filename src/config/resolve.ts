// SPEC.md §6.1 — Configuration Resolution Pipeline.
// PARITY.md row: §6.1.
//
// Two-phase config: schema.ts validates shape and applies defaults, this
// module resolves env-token indirection (`$VAR` / `${VAR}`) and home-dir
// expansion (`~`) on the fields where the spec requires it. Hook script
// bodies are deliberately NOT expanded here — the spawning shell handles
// `$VAR` at exec time (SPEC.md §6.1).

import os from 'node:os';
import path from 'node:path';

import type { WorkflowConfig } from './schema.js';

/**
 * Output of `resolveConfig`. Narrower than `WorkflowConfig`: `api_key` is now
 * guaranteed to be a non-empty string (resolveConfig either fills it from env
 * or throws). Carry this type through downstream layers (preflight,
 * orchestrator, agent runner) to avoid optional-chaining noise.
 */
export type ResolvedWorkflowConfig = WorkflowConfig & {
  tracker: WorkflowConfig['tracker'] & { api_key: string };
};

export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly fieldPath: string,
  ) {
    super(`Required environment variable ${varName} (referenced by ${fieldPath}) is not set`);
    this.name = 'MissingEnvVarError';
  }
}

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g;

function expandEnvVars(
  value: string,
  fieldPath: string,
  env: NodeJS.ProcessEnv,
): string {
  return value.replace(ENV_VAR_PATTERN, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? '';
    const resolved = env[name];
    if (resolved === undefined) {
      throw new MissingEnvVarError(name, fieldPath);
    }
    return resolved;
  });
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Resolve `tracker.api_key` per SPEC.md §6.1: when unset, or when the literal
 * value is `$LINEAR_API_KEY`, read from process.env.LINEAR_API_KEY. Any other
 * `$VAR` reference is expanded normally. Explicit non-`$VAR` strings are
 * preserved verbatim.
 */
function resolveApiKey(
  raw: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const fallbackEnv = env.LINEAR_API_KEY;
  if (raw === undefined || raw === '$LINEAR_API_KEY' || raw === '${LINEAR_API_KEY}') {
    if (fallbackEnv === undefined || fallbackEnv === '') {
      throw new MissingEnvVarError('LINEAR_API_KEY', 'tracker.api_key');
    }
    return fallbackEnv;
  }
  return expandEnvVars(raw, 'tracker.api_key', env);
}

/**
 * Take a validated WorkflowConfig and apply env-token + home-dir expansion
 * to the fields the spec calls out. Returns a new object; the input is
 * not mutated.
 *
 * @param input - validated config from schema.ts
 * @param env - environment to read from (defaults to process.env; injectable for tests)
 */
export function resolveConfig(
  input: WorkflowConfig,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedWorkflowConfig {
  const apiKey = resolveApiKey(input.tracker.api_key, env);
  const workspaceRoot = expandHome(expandEnvVars(input.workspace.root, 'workspace.root', env));

  return {
    ...input,
    tracker: { ...input.tracker, api_key: apiKey },
    workspace: { ...input.workspace, root: workspaceRoot },
    // hooks.* deliberately NOT expanded; the spawning shell handles `$VAR`.
  };
}
