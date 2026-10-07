import { describe, it, expect } from 'vitest';
import { buildDiscussSettingsJson, buildDiscussEnv } from '../../src/control-plane/settings-policy.js';

describe('buildDiscussSettingsJson', () => {
  const abs = '/abs/path/scripts/discuss-deny-guard.sh';

  it('uses bare tool names in allow + deny (no glob suffix)', () => {
    const s = buildDiscussSettingsJson(abs);
    expect(s.permissions.allow).toEqual(['Read', 'Grep', 'Glob']);
    expect(s.permissions.deny).toEqual(expect.arrayContaining([
      'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
      'WebFetch', 'WebSearch', 'Agent',
      'PowerShell', 'Skill', 'Workflow',
    ]));
    for (const n of s.permissions.allow!) expect(n).not.toMatch(/[()]/);
    for (const n of s.permissions.deny) expect(n).not.toMatch(/[()]/);
  });

  it('PreToolUse hook uses the absolute guard path', () => {
    const s = buildDiscussSettingsJson(abs);
    expect(s.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(abs);
    expect(s.hooks?.PreToolUse?.[0]?.matcher).toMatch(/Bash\|Edit\|Write/);
  });

  it('rejects relative guard path', () => {
    expect(() => buildDiscussSettingsJson('scripts/discuss-deny-guard.sh')).toThrow(/absolute/);
  });
});

describe('buildDiscussEnv', () => {
  it('returns only PATH/HOME/TERM/LANG/LC_ALL', () => {
    const env = buildDiscussEnv({
      PATH: '/usr/bin', HOME: '/home/x', TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
      LINEAR_READ_TOKEN: 'secret', ANTHROPIC_API_KEY: 'sk-...',
      LINEAR_API_KEY: 'lin', EXTRA_KEY: 'leak',
    });
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/home/x',
      TERM: 'xterm-256color', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8',
    });
  });

  it('omits absent keys silently', () => {
    expect(buildDiscussEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });
});
