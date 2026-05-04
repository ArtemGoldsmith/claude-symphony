import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseWorkflowConfig } from '../../src/config/schema.js';
import { MissingEnvVarError, resolveConfig } from '../../src/config/resolve.js';

function baseConfig(overrides: { workspaceRoot?: string; apiKey?: string | undefined } = {}) {
  return parseWorkflowConfig({
    tracker: {
      kind: 'linear',
      project_slug: 'chronicle',
      ...(overrides.apiKey !== undefined ? { api_key: overrides.apiKey } : {}),
    },
    workspace: { root: overrides.workspaceRoot ?? '/tmp/workspaces' },
  });
}

describe('resolveConfig — workspace.root expansion', () => {
  it('expands ~ to the user home directory', () => {
    const cfg = baseConfig({ workspaceRoot: '~/code/workspaces' });
    const env = { LINEAR_API_KEY: 'lin_test' };
    const resolved = resolveConfig(cfg, env);
    expect(resolved.workspace.root).toBe(path.join(os.homedir(), 'code/workspaces'));
  });

  it('expands $VAR in workspace.root', () => {
    const cfg = baseConfig({ workspaceRoot: '$WORKSPACE_HOME/chronicle' });
    const env = { WORKSPACE_HOME: '/srv/agents', LINEAR_API_KEY: 'lin_test' };
    const resolved = resolveConfig(cfg, env);
    expect(resolved.workspace.root).toBe('/srv/agents/chronicle');
  });

  it('expands ${VAR} braced syntax', () => {
    const cfg = baseConfig({ workspaceRoot: '${WORKSPACE_HOME}/chronicle' });
    const env = { WORKSPACE_HOME: '/srv/agents', LINEAR_API_KEY: 'lin_test' };
    const resolved = resolveConfig(cfg, env);
    expect(resolved.workspace.root).toBe('/srv/agents/chronicle');
  });

  it('expands $VAR before ~ when both apply', () => {
    // Spec §6.1: workspace.root resolves $VAR before path handling.
    const cfg = baseConfig({ workspaceRoot: '$BASE/chronicle' });
    const env = { BASE: '~/code', LINEAR_API_KEY: 'lin_test' };
    const resolved = resolveConfig(cfg, env);
    expect(resolved.workspace.root).toBe(path.join(os.homedir(), 'code/chronicle'));
  });

  it('throws MissingEnvVarError when a referenced var is unset', () => {
    const cfg = baseConfig({ workspaceRoot: '$NOT_DEFINED/foo' });
    const env = { LINEAR_API_KEY: 'lin_test' };
    expect(() => resolveConfig(cfg, env)).toThrow(MissingEnvVarError);
  });

  it('preserves a plain absolute path unchanged', () => {
    const cfg = baseConfig({ workspaceRoot: '/var/tmp/workspaces' });
    const env = { LINEAR_API_KEY: 'lin_test' };
    const resolved = resolveConfig(cfg, env);
    expect(resolved.workspace.root).toBe('/var/tmp/workspaces');
  });
});

describe('resolveConfig — tracker.api_key resolution', () => {
  it('reads LINEAR_API_KEY from env when api_key is unset', () => {
    const cfg = baseConfig();
    const env = { LINEAR_API_KEY: 'lin_secret_xxx' };
    expect(resolveConfig(cfg, env).tracker.api_key).toBe('lin_secret_xxx');
  });

  it('reads LINEAR_API_KEY from env when api_key is the literal "$LINEAR_API_KEY"', () => {
    const cfg = baseConfig({ apiKey: '$LINEAR_API_KEY' });
    const env = { LINEAR_API_KEY: 'lin_secret_xxx' };
    expect(resolveConfig(cfg, env).tracker.api_key).toBe('lin_secret_xxx');
  });

  it('reads LINEAR_API_KEY from env when api_key is "${LINEAR_API_KEY}"', () => {
    const cfg = baseConfig({ apiKey: '${LINEAR_API_KEY}' });
    const env = { LINEAR_API_KEY: 'lin_secret_xxx' };
    expect(resolveConfig(cfg, env).tracker.api_key).toBe('lin_secret_xxx');
  });

  it('preserves an explicit non-$VAR api_key value', () => {
    const cfg = baseConfig({ apiKey: 'lin_explicit_token' });
    const env = {};
    expect(resolveConfig(cfg, env).tracker.api_key).toBe('lin_explicit_token');
  });

  it('expands $VAR references other than $LINEAR_API_KEY', () => {
    const cfg = baseConfig({ apiKey: '$CUSTOM_LINEAR_TOKEN' });
    const env = { CUSTOM_LINEAR_TOKEN: 'lin_custom' };
    expect(resolveConfig(cfg, env).tracker.api_key).toBe('lin_custom');
  });

  it('throws when LINEAR_API_KEY is required but unset', () => {
    const cfg = baseConfig();
    const env = {};
    expect(() => resolveConfig(cfg, env)).toThrow(MissingEnvVarError);
  });

  it('throws when LINEAR_API_KEY is explicitly empty', () => {
    const cfg = baseConfig();
    const env = { LINEAR_API_KEY: '' };
    expect(() => resolveConfig(cfg, env)).toThrow(MissingEnvVarError);
  });
});

describe('resolveConfig — hooks are NOT expanded', () => {
  it('leaves $VAR in hooks.after_create unexpanded (shell will expand at exec time)', () => {
    const cfg = parseWorkflowConfig({
      tracker: { kind: 'linear', project_slug: 'x' },
      workspace: { root: '/tmp/workspaces' },
      hooks: { after_create: 'git clone $REPO_URL .' },
    });
    const env = { LINEAR_API_KEY: 'lin_test', REPO_URL: 'https://example.com/repo' };
    const resolved = resolveConfig(cfg, env);
    expect(resolved.hooks.after_create).toBe('git clone $REPO_URL .');
  });
});

describe('resolveConfig — immutability', () => {
  it('does not mutate the input config', () => {
    const cfg = baseConfig({ workspaceRoot: '~/code' });
    const before = JSON.stringify(cfg);
    resolveConfig(cfg, { LINEAR_API_KEY: 'lin_test' });
    expect(JSON.stringify(cfg)).toBe(before);
  });
});
