import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadControlPlaneConfig } from '../../src/control-plane/config-loader.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'cp-cfg-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const FRONT = `---
state_root: /abs/state
workspace:
  repo: /abs/repo
  root: /abs/worktrees
  base_branch: origin/development
web:
  auth_token_env: SYMPHONY_BOARD_TOKEN
preview:
  up_script: /abs/up.sh
  down_script: /abs/down.sh
prompts:
  prep: /abs/prep.md
  execute: /abs/execute.md
  review: /abs/review.md
  gapfix: /abs/gapfix.md
  closeout: /abs/closeout.md
linear:
  read_token_env: LINEAR_READ_TOKEN
  ai_proto_path: /abs/ai.proto
---

# notes ignored
`;

describe('loadControlPlaneConfig', () => {
  it('parses the YAML front matter of a WORKFLOW.md file', async () => {
    const p = path.join(dir, 'cp.WORKFLOW.md');
    await writeFile(p, FRONT, 'utf8');
    const c = await loadControlPlaneConfig(p);
    expect(c.workspace.repo).toBe('/abs/repo');
    expect(c.web.port).toBe(8787); // default applied
    expect(c.agent.max_concurrent_agents).toBe(2);
  });

  it('throws a helpful error when the file is missing', async () => {
    await expect(loadControlPlaneConfig(path.join(dir, 'nope.md'))).rejects.toThrow(/config/i);
  });

  it('throws when front matter fails schema validation', async () => {
    const p = path.join(dir, 'bad.md');
    await writeFile(p, '---\nstate_root: /x\n---\n', 'utf8'); // missing required blocks
    await expect(loadControlPlaneConfig(p)).rejects.toThrow();
  });
});
