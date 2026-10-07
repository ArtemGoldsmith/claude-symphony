// SPEC.md §9.5 + §15.2 — filesystem safety helpers.
// PARITY.md row: §15.2.
//
// Workspace operations MUST never touch paths outside the configured
// workspace root. The functions here are the canonical guard. Use them
// at every boundary that converts an issue identifier or other external
// input into a filesystem path.

import path from 'node:path';

export class UnsafePathError extends Error {
  constructor(
    message: string,
    public readonly attemptedPath: string,
    public readonly allowedRoot: string,
  ) {
    super(`${message} (path=${attemptedPath}, root=${allowedRoot})`);
    this.name = 'UnsafePathError';
  }
}

/**
 * Validate an issue identifier against the form Linear actually uses
 * (`TEAM-NNN`, where TEAM is `[A-Za-z][A-Za-z0-9_]*`). Rejects values
 * that contain path separators, `..`, or any other characters that
 * could break out of the workspace root.
 */
export function assertSafeIssueIdentifier(identifier: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(identifier)) {
    throw new UnsafePathError(
      `issue identifier "${identifier}" does not match TEAM-NNN`,
      identifier,
      '<schema>',
    );
  }
}

/**
 * Compose `root/segment`, resolve to absolute, and verify the result is
 * still inside `root`. Throws UnsafePathError on any escape attempt.
 * Returned path is absolute and normalized.
 */
export function joinWithinRoot(root: string, segment: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, segment);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (candidate !== resolvedRoot && !candidate.startsWith(rootWithSep)) {
    throw new UnsafePathError(
      'resolved path escapes the workspace root',
      candidate,
      resolvedRoot,
    );
  }
  return candidate;
}
