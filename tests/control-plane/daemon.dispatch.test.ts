import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { deriveBranch, isRetryDispatch, writeSettings } from '../../src/control-plane/daemon.js';
import { buildSettingsJson } from '../../src/control-plane/settings-policy.js';

describe('deriveBranch', () => {
  it('builds agent/<ticket>-<slug> and sanitises the title', () => {
    expect(deriveBranch('PIN-301', 'Add the Submittals tab!')).toBe('agent/pin-301-add-the-submittals-tab');
  });
  it('falls back to agent/<ticket> when the title has no slug chars', () => {
    expect(deriveBranch('PIN-7', '!!!')).toBe('agent/pin-7');
  });
});

describe('isRetryDispatch', () => {
  it('is true only for the matching *_failed → ⊕ re-entry', () => {
    expect(isRetryDispatch('execute_failed', 'executing')).toBe(true);
    expect(isRetryDispatch('prep_failed', 'prepping')).toBe(true);
    expect(isRetryDispatch('approved', 'executing')).toBe(false);
    expect(isRetryDispatch('queued', 'prepping')).toBe(false);
  });
});

describe('writeSettings (tamper-resistant)', () => {
  let wt: string;
  beforeEach(async () => { wt = await mkdtemp(path.join(tmpdir(), 'cp-set-')); });
  afterEach(async () => { await rm(wt, { recursive: true, force: true }); });

  it('overwrites a previously-planted .claude/settings.json with the canonical policy', async () => {
    await mkdir(path.join(wt, '.claude'), { recursive: true });
    await writeFile(path.join(wt, '.claude', 'settings.json'), '{"permissions":{"deny":[]}}', 'utf8');
    const out = await writeSettings(wt);
    expect(out).toBe(path.join(wt, '.claude', 'settings.json'));
    const written = await readFile(out, 'utf8');
    expect(written).toBe(JSON.stringify(buildSettingsJson(), null, 2));
  });
});
