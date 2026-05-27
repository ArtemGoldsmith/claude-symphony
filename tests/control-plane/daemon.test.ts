import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { reviewHasGaps } from '../../src/control-plane/daemon.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cp-daemon-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reviewHasGaps', () => {
  it('is true when review-fresh.md lists MISSING/PARTIAL gaps', async () => {
    const dir = path.join(root, 'PIN-1');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'review-fresh.md'), '## Genuine gaps to finish\n- AC3 MISSING: the legend\n', 'utf8');
    expect(await reviewHasGaps(dir)).toBe(true);
  });

  it('is false when the reviewer wrote "None — all ACs covered"', async () => {
    const dir = path.join(root, 'PIN-2');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'review-fresh.md'), '## Genuine gaps to finish\nNone — all ACs covered\n', 'utf8');
    expect(await reviewHasGaps(dir)).toBe(false);
  });

  it('is false (fail-open to closing) when review-fresh.md is absent', async () => {
    expect(await reviewHasGaps(path.join(root, 'PIN-404'))).toBe(false);
  });
});
