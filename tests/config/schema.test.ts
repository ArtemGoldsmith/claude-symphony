import { describe, expect, it } from 'vitest';

import { parseWorkflowConfig } from '../../src/config/schema.js';

const MINIMAL_VALID = {
  tracker: { kind: 'linear', project_slug: 'chronicle' },
  workspace: { root: '~/code/workspaces/chronicle' },
};

describe('parseWorkflowConfig', () => {
  it('parses a minimal valid config and applies all defaults', () => {
    const result = parseWorkflowConfig(MINIMAL_VALID);
    expect(result.tracker.kind).toBe('linear');
    expect(result.tracker.project_slug).toBe('chronicle');
    expect(result.tracker.active_states).toEqual(['Todo', 'In Progress']);
    expect(result.tracker.terminal_states).toEqual([
      'Done',
      'Cancelled',
      'Canceled',
      'Closed',
      'Duplicate',
    ]);
    expect(result.polling.interval_ms).toBe(5_000);
    expect(result.workspace.root).toBe('~/code/workspaces/chronicle');
    expect(result.hooks).toEqual({ timeout_ms: 10 * 60_000 });
    expect(result.agent.max_concurrent_agents).toBe(5);
    expect(result.claude.permission_mode).toBe('default');
    expect(result.claude.disallowed_tools).toEqual([]);
    expect(result.claude.mcp_servers).toEqual({});
    expect(result.claude.system_prompt_append).toBe('');
    expect(result.claude.turn_timeout_ms).toBe(3_600_000);
    expect(result.claude.read_timeout_ms).toBe(5_000);
    expect(result.claude.stall_timeout_ms).toBe(300_000);
    expect(result.claude.max_turns).toBe(20);
  });

  it('preserves explicit user-supplied values', () => {
    const result = parseWorkflowConfig({
      ...MINIMAL_VALID,
      polling: { interval_ms: 1_000 },
      agent: { max_concurrent_agents: 10 },
      claude: {
        permission_mode: 'acceptEdits',
        disallowed_tools: ['Bash(rm:*)'],
        model: 'claude-opus-4-7',
      },
    });
    expect(result.polling.interval_ms).toBe(1_000);
    expect(result.agent.max_concurrent_agents).toBe(10);
    expect(result.claude.permission_mode).toBe('acceptEdits');
    expect(result.claude.disallowed_tools).toEqual(['Bash(rm:*)']);
    expect(result.claude.model).toBe('claude-opus-4-7');
  });

  it('rejects missing tracker.kind', () => {
    expect(() =>
      parseWorkflowConfig({
        tracker: { project_slug: 'x' },
        workspace: { root: '/tmp' },
      }),
    ).toThrow();
  });

  it('rejects missing tracker.project_slug', () => {
    expect(() =>
      parseWorkflowConfig({
        tracker: { kind: 'linear' },
        workspace: { root: '/tmp' },
      }),
    ).toThrow(/project_slug/);
  });

  it('rejects unknown tracker.kind', () => {
    expect(() =>
      parseWorkflowConfig({
        tracker: { kind: 'jira', project_slug: 'x' },
        workspace: { root: '/tmp' },
      }),
    ).toThrow();
  });

  it('rejects missing workspace.root', () => {
    expect(() =>
      parseWorkflowConfig({
        tracker: { kind: 'linear', project_slug: 'x' },
      }),
    ).toThrow(/workspace/);
  });

  it('rejects empty workspace.root', () => {
    expect(() =>
      parseWorkflowConfig({
        tracker: { kind: 'linear', project_slug: 'x' },
        workspace: { root: '' },
      }),
    ).toThrow();
  });

  it('rejects non-positive polling.interval_ms', () => {
    expect(() =>
      parseWorkflowConfig({ ...MINIMAL_VALID, polling: { interval_ms: 0 } }),
    ).toThrow();
    expect(() =>
      parseWorkflowConfig({ ...MINIMAL_VALID, polling: { interval_ms: -100 } }),
    ).toThrow();
  });

  it('rejects non-positive agent.max_concurrent_agents', () => {
    expect(() =>
      parseWorkflowConfig({ ...MINIMAL_VALID, agent: { max_concurrent_agents: 0 } }),
    ).toThrow();
  });

  it('accepts claude.max_turns within [1, 200] and rejects out-of-range values', () => {
    expect(parseWorkflowConfig({ ...MINIMAL_VALID, claude: { max_turns: 1 } }).claude.max_turns).toBe(1);
    expect(parseWorkflowConfig({ ...MINIMAL_VALID, claude: { max_turns: 50 } }).claude.max_turns).toBe(50);
    expect(parseWorkflowConfig({ ...MINIMAL_VALID, claude: { max_turns: 200 } }).claude.max_turns).toBe(200);
    expect(() => parseWorkflowConfig({ ...MINIMAL_VALID, claude: { max_turns: 0 } })).toThrow();
    expect(() => parseWorkflowConfig({ ...MINIMAL_VALID, claude: { max_turns: 201 } })).toThrow();
    expect(() => parseWorkflowConfig({ ...MINIMAL_VALID, claude: { max_turns: 1.5 } })).toThrow();
  });

  it('rejects invalid claude.permission_mode', () => {
    expect(() =>
      parseWorkflowConfig({ ...MINIMAL_VALID, claude: { permission_mode: 'maximumChaos' } }),
    ).toThrow();
  });

  it('ignores unknown top-level keys (forward compatibility per SPEC.md §5.3)', () => {
    const result = parseWorkflowConfig({
      ...MINIMAL_VALID,
      something_in_v2: { not: 'yet known' },
    });
    expect(result.tracker.project_slug).toBe('chronicle');
    expect(result).not.toHaveProperty('something_in_v2');
  });

  it('ignores unknown nested keys', () => {
    const result = parseWorkflowConfig({
      ...MINIMAL_VALID,
      claude: { permission_mode: 'plan', future_field: 'ignored' },
    });
    expect(result.claude.permission_mode).toBe('plan');
    expect(result.claude).not.toHaveProperty('future_field');
  });

  it('accepts hooks block with optional scripts', () => {
    const result = parseWorkflowConfig({
      ...MINIMAL_VALID,
      hooks: { after_create: 'git clone . .' },
    });
    expect(result.hooks.after_create).toBe('git clone . .');
    expect(result.hooks.before_remove).toBeUndefined();
  });
});
