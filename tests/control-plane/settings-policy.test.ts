// tests/control-plane/settings-policy.test.ts
import { describe, expect, it } from 'vitest';

import { buildSettingsJson } from '../../src/control-plane/settings-policy.js';

describe('buildSettingsJson', () => {
  it('denies git push, sudo, rm -rf / via permission rules and routes curl|sh to the guard hook', () => {
    const s = buildSettingsJson();
    const deny: string[] = s.permissions.deny;
    expect(s.permissions.defaultMode ?? 'default').toBeDefined();
    expect(deny.some((r) => r.includes('git push'))).toBe(true);
    expect(deny.some((r) => /sudo/.test(r))).toBe(true);
    expect(deny.some((r) => r.includes('rm -rf /'))).toBe(true);
    // Write/Edit outside cwd: absolute-path deny entries (Claude `//abs` syntax).
    expect(deny.some((r) => r.startsWith('Write(') || r.startsWith('Edit('))).toBe(true);
    // curl|sh is NOT a permission glob — it is enforced by the PreToolUse guard.
    expect(deny.some((r) => /curl/.test(r))).toBe(false);
    expect(s.hooks?.PreToolUse?.[0]?.matcher).toMatch(/Bash/);
    expect(s.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toContain('pretooluse-guard');
  });

  it('serialises to valid JSON', () => {
    expect(() => JSON.stringify(buildSettingsJson())).not.toThrow();
  });
});
