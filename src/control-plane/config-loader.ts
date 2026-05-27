// src/control-plane/config-loader.ts
// Load a control-plane config from a WORKFLOW.md-style file (YAML front matter +
// ignored Markdown body), mirroring src/workflow/loader.ts. The body is human
// documentation; only the front matter is the config.

import fs from 'node:fs/promises';

import matter from 'gray-matter';

import { parseControlPlaneConfig, type ControlPlaneConfig } from './config.js';

export async function loadControlPlaneConfig(filePath: string): Promise<ControlPlaneConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`control-plane config not readable at ${filePath}: ${(err as Error).message}`);
  }
  const parsed = matter(raw);
  return parseControlPlaneConfig(parsed.data);
}
