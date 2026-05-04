// SPEC.md §11.1 — REQUIRED tracker operations, expressed as a small interface
// the orchestrator depends on. Real implementation: src/linear/client.ts.
// Tests substitute a fake gateway in src/orchestrator/ without dragging in
// the @linear/sdk Promise/relation graph.
// PARITY.md rows: §3.1.3, §11.1.

import type { Issue } from './issue.js';

export interface LinearGateway {
  /**
   * Fetch all candidate issues for the project that are currently in any of
   * `activeStates`. Implementations MUST paginate fully (page size 50, per
   * SPEC.md §11.2) and apply the `project: { slugId: { eq } }` filter.
   */
  fetchActiveCandidates(projectSlug: string, activeStates: string[]): Promise<Issue[]>;

  /**
   * Fetch a single issue by its human identifier (e.g. "PIN-123"). Returns
   * null if no issue with that identifier exists in the workspace the API
   * key is authorized for. Used by reconcile / retry paths that already
   * know the identifier.
   */
  fetchIssueByIdentifier(identifier: string): Promise<Issue | null>;
}

export class LinearTrackerError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LinearTrackerError';
  }
}
