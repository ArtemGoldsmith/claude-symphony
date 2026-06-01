// tests/control-plane/config.test.ts
import { describe, expect, it } from 'vitest';

import { parseControlPlaneConfig } from '../../src/control-plane/config.js';

const MIN = {
  state_root: '~/.local/state/symphony',
  workspace: { repo: '/abs/repo', root: '/abs/worktrees', base_branch: 'origin/development' },
  web: { auth_token_env: 'SYMPHONY_BOARD_TOKEN' },
  preview: { up_script: '/abs/preview-up.sh', down_script: '/abs/preview-down-compute.sh' },
  prompts: {
    prep: '/abs/prep.md',
    execute: '/abs/bootstrap-prompt.md',
    review: '/abs/review-prompt.md',
    gapfix: '/abs/gapfix-prompt.md',
    closeout: '/abs/closeout.md',
  },
  linear: { read_token_env: 'LINEAR_READ_TOKEN', ai_proto_path: '/abs/AI-prototype' },
};

describe('parseControlPlaneConfig', () => {
  it('parses a minimal config and applies defaults', () => {
    const c = parseControlPlaneConfig(MIN);
    expect(c.agent.max_concurrent_agents).toBe(2); // control-plane default (spec §13)
    expect(c.web.bind_host).toBe('127.0.0.1'); // default; box sets the Tailscale IP
    expect(c.web.port).toBe(8787);
    expect(c.workspace.base_branch).toBe('origin/development');
  });

  it('honours overrides and drops unknown keys (forward-compat)', () => {
    const c = parseControlPlaneConfig({
      ...MIN,
      agent: { max_concurrent_agents: 3 },
      web: { auth_token_env: 'T', bind_host: '100.108.20.39', port: 443 },
      surprise: 'ignored',
    });
    expect(c.agent.max_concurrent_agents).toBe(3);
    expect(c.web.bind_host).toBe('100.108.20.39');
    expect((c as Record<string, unknown>).surprise).toBeUndefined();
  });

  it('rejects a config missing required prompt/preview/linear paths', () => {
    expect(() => parseControlPlaneConfig({ state_root: 'x' })).toThrow();
  });

  it('rejects a wildcard web.bind_host (spec §9)', () => {
    expect(() => parseControlPlaneConfig({ ...MIN, web: { auth_token_env: 'T', bind_host: '0.0.0.0' } })).toThrow();
  });

  it('defaults agent.model to opus and agent.extra_env to []', () => {
    const c = parseControlPlaneConfig(MIN);
    expect(c.agent.model).toBe('opus');
    expect(c.agent.extra_env).toEqual([]);
  });

  it('honours agent.model + agent.extra_env overrides (box build essentials)', () => {
    const c = parseControlPlaneConfig({
      ...MIN,
      agent: { max_concurrent_agents: 2, model: 'sonnet', extra_env: ['DOCKER_HOST', 'GOPATH'] },
    });
    expect(c.agent.model).toBe('sonnet');
    expect(c.agent.extra_env).toEqual(['DOCKER_HOST', 'GOPATH']);
  });

  it('requires workspace.repo (the shared repo root for worktree add)', () => {
    const c = parseControlPlaneConfig(MIN);
    expect(c.workspace.repo).toBe('/abs/repo');
    const { repo: _omit, ...noRepo } = MIN.workspace as Record<string, unknown>;
    expect(() => parseControlPlaneConfig({ ...MIN, workspace: noRepo })).toThrow();
  });

  it('rejects read_token_env = LINEAR_API_KEY (would leak the full-write key)', () => {
    expect(() =>
      parseControlPlaneConfig({ ...MIN, linear: { read_token_env: 'LINEAR_API_KEY', ai_proto_path: '/p' } }),
    ).toThrow(/READ-scoped/);
  });
  it('rejects a secret-looking extra_env entry', () => {
    expect(() =>
      parseControlPlaneConfig({ ...MIN, agent: { extra_env: ['GIT_PUSH_TOKEN'] } }),
    ).toThrow(/looks like a secret/);
  });

  it('preview.timeout_seconds defaults to 1800 and preview.extra_env to []', () => {
    const c = parseControlPlaneConfig(MIN);
    expect(c.preview.timeout_seconds).toBe(1800);
    expect(c.preview.extra_env).toEqual([]);
  });

  it('preview.extra_env rejects secret-looking names', () => {
    const bad = { ...MIN, preview: { ...MIN.preview, extra_env: ['DOCKER_HOST', 'GH_TOKEN'] } };
    expect(() => parseControlPlaneConfig(bad)).toThrow(/secret/i);
  });

  it('preview.extra_env accepts benign build env names', () => {
    const ok = { ...MIN, preview: { ...MIN.preview, extra_env: ['DOCKER_HOST', 'COLIMA_HOME'] } };
    expect(parseControlPlaneConfig(ok).preview.extra_env).toEqual(['DOCKER_HOST', 'COLIMA_HOME']);
  });

  describe('web.discuss_terminal', () => {
    it('applies defaults when omitted', () => {
      const c = parseControlPlaneConfig(MIN);
      expect(c.web.discuss_terminal).toEqual({
        enabled: false,
        idle_timeout_seconds: 1800,
        heartbeat_seconds: 30,
        pong_grace_seconds: 60,
        max_concurrent_global: 4,
        pty_kill_timeout_ms: 3000,
        allow_writes: false,
      });
    });

    it('rejects max_concurrent_global = 0', () => {
      expect(() =>
        parseControlPlaneConfig({
          ...MIN,
          web: { ...MIN.web, discuss_terminal: { max_concurrent_global: 0 } },
        }),
      ).toThrow();
    });

    it('rejects negative idle_timeout_seconds', () => {
      expect(() =>
        parseControlPlaneConfig({
          ...MIN,
          web: { ...MIN.web, discuss_terminal: { idle_timeout_seconds: -1 } },
        }),
      ).toThrow();
    });

    it('accepts enabled=true', () => {
      const c = parseControlPlaneConfig({
        ...MIN,
        web: { ...MIN.web, discuss_terminal: { enabled: true } },
      });
      expect(c.web.discuss_terminal.enabled).toBe(true);
    });
  });
});
