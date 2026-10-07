// SPEC.md §3.1.1 + §5.1 + §5.2 + §5.5 — Workflow Loader.
// PARITY.md rows: §3.1.1, §5.1, §5.2, §5.5, §4.1.2.
//
// Reads a WORKFLOW.md file from disk, splits YAML front matter from the
// Markdown prompt body via gray-matter, returns a WorkflowDefinition. The
// raw front matter is NOT validated here — that is the config layer's job
// (src/config/schema.ts). Keeping these concerns split means parsing
// errors and validation errors surface with distinct messages.

import fs from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';

export class WorkflowLoadError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
  ) {
    super(`${filePath}: ${message}`);
    this.name = 'WorkflowLoadError';
  }
}

export interface WorkflowDefinition {
  /** Raw front-matter object. Validate via parseWorkflowConfig() in src/config/. */
  config: Record<string, unknown>;
  /** Markdown body after the front matter, trimmed (SPEC.md §5.4). */
  promptTemplate: string;
  /** Absolute path of the source file, useful for error messages. */
  sourcePath: string;
}

/**
 * Load and parse a WORKFLOW.md file. Throws WorkflowLoadError on:
 *   - file not found / unreadable
 *   - missing or empty YAML front matter
 *   - invalid YAML front matter
 *
 * Validation of the parsed front matter (required fields, types, defaults)
 * is the next stage — call parseWorkflowConfig() on the returned `config`.
 */
export async function loadWorkflow(filePath: string): Promise<WorkflowDefinition> {
  const absolutePath = path.resolve(filePath);

  let raw: string;
  try {
    raw = await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new WorkflowLoadError('file not found', absolutePath);
    }
    throw new WorkflowLoadError(
      `cannot read file: ${(err as Error).message}`,
      absolutePath,
    );
  }

  // Detect "no front matter at all" before we even hand off to gray-matter,
  // so the error message stays specific. Front-matter files MUST start with
  // a `---` delimiter on its own line (optionally preceded by a UTF-8 BOM).
  const stripped = raw.replace(/^﻿/, '');
  if (!/^---\s*\r?\n/.test(stripped)) {
    throw new WorkflowLoadError(
      'no YAML front matter found; expected `---`-delimited block at top of file',
      absolutePath,
    );
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    throw new WorkflowLoadError(
      `invalid YAML front matter: ${(err as Error).message}`,
      absolutePath,
    );
  }

  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    throw new WorkflowLoadError(
      'front matter must be a YAML mapping at the top level',
      absolutePath,
    );
  }

  if (Object.keys(parsed.data).length === 0) {
    throw new WorkflowLoadError(
      'YAML front matter is empty; expected at least `tracker` and `workspace` sections',
      absolutePath,
    );
  }

  return {
    config: parsed.data as Record<string, unknown>,
    promptTemplate: parsed.content.trim(),
    sourcePath: absolutePath,
  };
}
