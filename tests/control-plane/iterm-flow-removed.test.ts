import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function walk(root: string, ext: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full, ext)));
    else if (ext.test(ent.name)) out.push(full);
  }
  return out;
}

describe('iTerm-flow removed', () => {
  it('no references to discuss_url_scheme / discussUrlScheme / renderDiscussLink / symphony-discuss in tracked source', async () => {
    const repo = path.resolve(__dirname, '../..');
    const files: string[] = [];
    for (const sub of ['src', 'examples']) {
      try { files.push(...(await walk(path.join(repo, sub), /\.(ts|md)$/))); } catch { /* dir may not exist */ }
    }
    const banned = ['discuss_url_scheme', 'discussUrlScheme', 'renderDiscussLink', 'symphony-discuss'];
    for (const f of files) {
      const txt = await readFile(f, 'utf8');
      for (const word of banned) {
        expect(txt, `${path.relative(repo, f)} still references ${word}`).not.toMatch(new RegExp(word));
      }
    }
  });
});
