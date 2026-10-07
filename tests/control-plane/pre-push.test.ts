// tests/control-plane/pre-push.test.ts
import { mkdtemp, rm, mkdir, readFile, writeFile, stat, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  HARDENED_PRE_PUSH,
  PRE_PUSH_MARKER,
  installPrePush,
  PrePushCollisionError,
} from '../../src/control-plane/pre-push.js';

let gitDir: string;
beforeEach(async () => {
  gitDir = await mkdtemp(path.join(tmpdir(), 'cp-hook-'));
  await mkdir(path.join(gitDir, 'hooks'), { recursive: true });
});
afterEach(async () => {
  await rm(gitDir, { recursive: true, force: true });
});

describe('hardened pre-push', () => {
  it('content refuses all refs, ignores the override, and carries the marker in the first 5 lines', () => {
    expect(HARDENED_PRE_PUSH.split('\n').slice(0, 5).join('\n')).toContain(PRE_PUSH_MARKER);
    expect(HARDENED_PRE_PUSH).toMatch(/exit 1/);
    expect(HARDENED_PRE_PUSH).not.toContain('SYMPHONY_ALLOW_PUSH'); // override is gone
  });

  it('installs the hook (executable) when none exists', async () => {
    await installPrePush(gitDir);
    const hookPath = path.join(gitDir, 'hooks', 'pre-push');
    const body = await readFile(hookPath, 'utf8');
    expect(body).toBe(HARDENED_PRE_PUSH);
    const mode = (await stat(hookPath)).mode & 0o111;
    expect(mode).not.toBe(0); // has an execute bit
  });

  it('is idempotent — re-installing over our own marker leaves it in place', async () => {
    await installPrePush(gitDir);
    await expect(installPrePush(gitDir)).resolves.toBeUndefined();
    await expect(access(path.join(gitDir, 'hooks', 'pre-push'))).resolves.toBeUndefined();
  });

  it('refuses to overwrite a foreign (non-marker) pre-push hook', async () => {
    await writeFile(path.join(gitDir, 'hooks', 'pre-push'), '#!/bin/sh\necho other\n', 'utf8');
    await expect(installPrePush(gitDir)).rejects.toThrow(PrePushCollisionError);
  });
});
