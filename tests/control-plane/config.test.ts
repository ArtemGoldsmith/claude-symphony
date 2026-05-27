// tests/control-plane/config.test.ts
import { describe, expect, it } from 'vitest';

import { parseControlPlaneConfig } from '../../src/control-plane/config.js';

const MIN = {
  state_root: '~/.local/state/symphony',
  workspace: { root: '/abs/worktrees', base_branch: 'origin/development' },
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
});
