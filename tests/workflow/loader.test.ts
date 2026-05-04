import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkflowLoadError, loadWorkflow } from '../../src/workflow/loader.js';

const VALID_BODY = `---
tracker:
  kind: linear
  project_slug: chronicle
workspace:
  root: ~/code/workspaces
---

You are working on issue {{ issue.identifier }}.
`;

describe('loadWorkflow', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loader-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeFixture(name: string, content: string): Promise<string> {
    const filePath = path.join(tempDir, name);
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  it('parses front matter into config and returns the trimmed body as promptTemplate', async () => {
    const filePath = await writeFixture('WORKFLOW.md', VALID_BODY);
    const def = await loadWorkflow(filePath);

    expect(def.config).toMatchObject({
      tracker: { kind: 'linear', project_slug: 'chronicle' },
      workspace: { root: '~/code/workspaces' },
    });
    expect(def.promptTemplate).toBe('You are working on issue {{ issue.identifier }}.');
    expect(def.sourcePath).toBe(filePath);
  });

  it('returns an empty promptTemplate when the body is blank', async () => {
    const filePath = await writeFixture(
      'WORKFLOW.md',
      `---
tracker:
  kind: linear
  project_slug: x
workspace:
  root: /tmp
---

`,
    );
    const def = await loadWorkflow(filePath);
    expect(def.promptTemplate).toBe('');
  });

  it('throws WorkflowLoadError when the file does not exist', async () => {
    await expect(loadWorkflow(path.join(tempDir, 'missing.md'))).rejects.toThrow(WorkflowLoadError);
    await expect(loadWorkflow(path.join(tempDir, 'missing.md'))).rejects.toThrow(/not found/);
  });

  it('throws when there is no YAML front matter at all', async () => {
    const filePath = await writeFixture('NO_FRONT_MATTER.md', '# Just a body, no front matter\n');
    await expect(loadWorkflow(filePath)).rejects.toThrow(/no YAML front matter/);
  });

  it('throws on invalid YAML front matter', async () => {
    const filePath = await writeFixture(
      'BAD.md',
      `---
this is not: valid yaml: at all: nested: badly:
---
body
`,
    );
    await expect(loadWorkflow(filePath)).rejects.toThrow(WorkflowLoadError);
  });

  it('throws when front matter is a top-level array instead of a mapping', async () => {
    const filePath = await writeFixture(
      'ARRAY.md',
      `---
- item1
- item2
---
body
`,
    );
    await expect(loadWorkflow(filePath)).rejects.toThrow(/mapping/);
  });

  it('resolves a relative input path to an absolute sourcePath', async () => {
    const filePath = await writeFixture('WORKFLOW.md', VALID_BODY);
    const cwd = process.cwd();
    process.chdir(tempDir);
    try {
      const def = await loadWorkflow('WORKFLOW.md');
      expect(path.isAbsolute(def.sourcePath)).toBe(true);
      // On macOS, `os.tmpdir()` returns an unresolved /var/folders/... path
      // while `process.cwd()` after chdir returns its symlink target
      // (/private/var/folders/...). Compare via fs.realpath to normalize.
      const realFilePath = await fs.realpath(filePath);
      expect(def.sourcePath).toBe(realFilePath);
    } finally {
      process.chdir(cwd);
    }
  });
});
