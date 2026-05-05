// SPEC.md §14.3 + Phase 3 P5 — orchestrator state persistence to disk.
//
// Atomic write via tmp + rename so a daemon crash mid-write can never leave
// the file half-truncated. Best-effort load on boot: a missing or malformed
// state file is treated as "fresh start" and the daemon continues; loud
// only on real read errors.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { SerializedOrchestratorState } from './state.js';

export const STATE_FILENAME = '.symphony-state.json';

export interface LoadStateResult {
  /** Hydrated snapshot, or null if no usable file existed. */
  snapshot: SerializedOrchestratorState | null;
  /** Operator-visible note about what we loaded or why we didn't. */
  note: string;
}

export async function loadStateFromDisk(directory: string): Promise<LoadStateResult> {
  const file = path.join(directory, STATE_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { snapshot: null, note: `no state file at ${file}; starting clean` };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      snapshot: null,
      note: `state file ${file} is not valid JSON (${(err as Error).message}); starting clean`,
    };
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { issues?: unknown }).issues !== 'object'
  ) {
    return {
      snapshot: null,
      note: `state file ${file} has unexpected shape; starting clean`,
    };
  }
  return {
    snapshot: parsed as SerializedOrchestratorState,
    note: `loaded ${Object.keys((parsed as SerializedOrchestratorState).issues).length} issue records from ${file}`,
  };
}

/**
 * Atomically write the snapshot to `<directory>/.symphony-state.json`.
 * Writes to a sibling .tmp file first, then renames. Both ops are async
 * to keep the orchestrator's hot path non-blocking, but the renames are
 * ordered so concurrent saveStateToDisk() calls produce a well-defined
 * last-writer-wins outcome rather than a torn file.
 */
export async function saveStateToDisk(
  directory: string,
  snapshot: SerializedOrchestratorState,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, STATE_FILENAME);
  // Per-call tmp suffix prevents two concurrent saves from clobbering each
  // other's tmp file before the rename.
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
