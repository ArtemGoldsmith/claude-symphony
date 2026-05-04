// SPEC.md §11.1 — REQUIRED tracker operations, expressed as a small interface
// the orchestrator depends on. Real implementation: src/linear/client.ts.
// Tests substitute a fake gateway in src/orchestrator/ without dragging in
// the @linear/sdk Promise/relation graph.
// PARITY.md rows: §3.1.3, §11.1.

import type { Issue } from './issue.js';

/**
 * Linear write surface used by the in-process `symphony_linear` MCP server
 * (see src/agent/symphony-linear-server.ts). Kept independent of @linear/sdk
 * types so unit tests can stub it cleanly.
 */
export interface LinearWriteGateway {
  /** Re-fetch an issue (used by get_current_issue tool). */
  fetchIssueByIdentifier(identifier: string): Promise<Issue | null>;

  /** Return all non-deleted comments on an issue, oldest first. */
  listComments(issueId: string): Promise<ReadonlyArray<{ id: string; body: string }>>;

  /** Post a fresh comment. Returns the created comment's id. */
  createComment(args: { issueId: string; body: string }): Promise<{ id: string }>;

  /** Replace the body of an existing comment. */
  updateComment(args: { commentId: string; body: string }): Promise<void>;

  /**
   * Resolve a workflow state name (e.g. "Human Review") to its GraphQL id
   * within the given team. Returns null if no state matches. Names are
   * case-sensitive; the agent passes the same name the operator sees in
   * Linear.
   */
  findWorkflowStateId(args: { teamKey: string; stateName: string }): Promise<string | null>;

  /** Move an issue to the given workflow state id. */
  updateIssueState(args: { issueId: string; stateId: string }): Promise<void>;

  /** Attach an external URL (e.g. a PR) to an issue. */
  createAttachment(args: { issueId: string; url: string; title?: string }): Promise<void>;
}

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
