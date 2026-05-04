// SPEC.md §4.1.1 + §11.3 — normalized Issue domain entity.
// PARITY.md row: §4.1.1.

/**
 * Reference to another issue that blocks this one. Populated from inverse
 * relations of type "blocks" on the source Linear issue (SPEC.md §11.3).
 */
export interface IssueRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

/**
 * Stable, normalized Linear issue representation used across the orchestrator,
 * workspace manager, and prompt builder. Fields match SPEC.md §4.1.1; timestamps
 * are kept as ISO-8601 strings rather than Date objects so the value is trivially
 * loggable and serializable.
 */
export interface Issue {
  /** Tracker-internal stable ID (Linear issue.id). */
  id: string;
  /** Human-readable ticket key (e.g. "PIN-123"). */
  identifier: string;
  title: string;
  description: string | null;
  /** Lower numbers are higher priority in dispatch sorting. */
  priority: number | null;
  /** Current tracker state name. */
  state: string;
  /** Tracker-provided suggested branch name, if any. */
  branchName: string | null;
  url: string | null;
  /** Always lowercased per SPEC.md §11.3. */
  labels: string[];
  /** Issues this one is blocked by, derived from inverse `blocks` relations. */
  blockedBy: IssueRef[];
  /** ISO-8601 string or null. */
  createdAt: string | null;
  /** ISO-8601 string or null. */
  updatedAt: string | null;
}
