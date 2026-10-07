// SPEC.md §11.5 (writes) + SPEC-claude.md §D — Linear write surface for the
// in-process symphony_linear MCP server.
// PARITY.md row: §11.5 (B7).
//
// The orchestrator's polling client is read-only by design; this is a
// distinct write surface used exclusively by the MCP tools we expose to
// the agent. They share the same LinearClient instance under the hood, so
// the operator's single LINEAR_API_KEY (with Read + Write scope) is the
// only credential to manage.

import type { LinearClient } from '@linear/sdk';

import { adaptIssue, type RawLinearIssue } from './adapter.js';
import { LinearTrackerError, type LinearWriteGateway } from './gateway.js';
import type { Issue } from './issue.js';

/**
 * Subset of @linear/sdk's LinearClient that this gateway calls. Stays
 * minimal so tests can supply a fake without dragging in the full SDK.
 */
export interface LinearWriteClient {
  issues(args: { first?: number; filter?: Record<string, unknown> }): Promise<{
    nodes: ReadonlyArray<WriteIssueNode>;
  }>;
  issue(idOrIdentifier: string): Promise<WriteIssueNode | null>;
  createComment(input: { issueId: string; body: string }): Promise<{
    success: boolean;
    comment?: Promise<{ id: string }> | { id: string };
  }>;
  updateComment(id: string, input: { body: string }): Promise<{ success: boolean }>;
  updateIssue(id: string, input: { stateId: string }): Promise<{ success: boolean }>;
  workflowStates(args: { filter: Record<string, unknown> }): Promise<{
    nodes: ReadonlyArray<{ id: string; name: string }>;
  }>;
  createAttachment(input: { issueId: string; url: string; title?: string }): Promise<{
    success: boolean;
  }>;
}

export interface WriteIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  branchName?: string | null;
  url?: string | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  state: Promise<{ name?: string | null } | null | undefined>;
  labels(): Promise<{ nodes: ReadonlyArray<{ name?: string | null }> } | null | undefined>;
  comments(args?: { first?: number }): Promise<{
    nodes: ReadonlyArray<{ id: string; body: string }>;
  }>;
}

export class SdkLinearWriteGateway implements LinearWriteGateway {
  constructor(private readonly client: LinearWriteClient) {}

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const match = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(identifier.trim());
    if (!match) {
      throw new LinearTrackerError(
        `fetchIssueByIdentifier: malformed identifier "${identifier}"; expected TEAM-NNN`,
      );
    }
    const teamKey = match[1]!;
    const number = Number.parseInt(match[2]!, 10);
    let page;
    try {
      page = await this.client.issues({
        first: 1,
        filter: { team: { key: { eq: teamKey } }, number: { eq: number } },
      });
    } catch (err) {
      throw new LinearTrackerError('Linear issue lookup failed', err);
    }
    const node = page.nodes[0];
    if (!node) return null;

    const stateResolved = await node.state;
    const labelsResolved = await node.labels();
    const stateName = stateResolved?.name;
    if (typeof stateName !== 'string' || stateName.length === 0) {
      throw new LinearTrackerError(
        `Linear issue ${node.identifier} has no resolvable state name`,
      );
    }
    const raw: RawLinearIssue = {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? null,
      priority: node.priority ?? null,
      state: { name: stateName },
      branchName: node.branchName ?? null,
      url: node.url ?? null,
      labels: {
        nodes: (labelsResolved?.nodes ?? []).map((l) => ({
          name: typeof l?.name === 'string' ? l.name : '',
        })),
      },
      inverseRelations: null,
      createdAt: node.createdAt ?? null,
      updatedAt: node.updatedAt ?? null,
    };
    return adaptIssue(raw);
  }

  async listComments(issueId: string): Promise<ReadonlyArray<{ id: string; body: string }>> {
    const issue = await this.client.issue(issueId);
    if (!issue) {
      throw new LinearTrackerError(`listComments: issue ${issueId} not found`);
    }
    try {
      const conn = await issue.comments({ first: 100 });
      return conn.nodes.map((c) => ({ id: c.id, body: c.body }));
    } catch (err) {
      throw new LinearTrackerError('Linear comments fetch failed', err);
    }
  }

  async createComment(args: { issueId: string; body: string }): Promise<{ id: string }> {
    let result;
    try {
      result = await this.client.createComment({ issueId: args.issueId, body: args.body });
    } catch (err) {
      throw new LinearTrackerError('Linear createComment failed', err);
    }
    if (!result.success) {
      throw new LinearTrackerError('Linear createComment returned success=false');
    }
    const comment = await result.comment;
    if (!comment || typeof comment.id !== 'string') {
      throw new LinearTrackerError('Linear createComment did not return a comment id');
    }
    return { id: comment.id };
  }

  async updateComment(args: { commentId: string; body: string }): Promise<void> {
    let result;
    try {
      result = await this.client.updateComment(args.commentId, { body: args.body });
    } catch (err) {
      throw new LinearTrackerError('Linear updateComment failed', err);
    }
    if (!result.success) {
      throw new LinearTrackerError(`Linear updateComment(${args.commentId}) returned success=false`);
    }
  }

  async findWorkflowStateId(args: {
    teamKey: string;
    stateName: string;
  }): Promise<string | null> {
    let result;
    try {
      result = await this.client.workflowStates({
        filter: {
          team: { key: { eq: args.teamKey } },
          name: { eq: args.stateName },
        },
      });
    } catch (err) {
      throw new LinearTrackerError('Linear workflowStates query failed', err);
    }
    return result.nodes[0]?.id ?? null;
  }

  async updateIssueState(args: { issueId: string; stateId: string }): Promise<void> {
    let result;
    try {
      result = await this.client.updateIssue(args.issueId, { stateId: args.stateId });
    } catch (err) {
      throw new LinearTrackerError('Linear updateIssue failed', err);
    }
    if (!result.success) {
      throw new LinearTrackerError(`Linear updateIssue(${args.issueId}) returned success=false`);
    }
  }

  async createAttachment(args: {
    issueId: string;
    url: string;
    title?: string;
  }): Promise<void> {
    let result;
    try {
      const input: { issueId: string; url: string; title?: string } = {
        issueId: args.issueId,
        url: args.url,
      };
      if (args.title !== undefined) input.title = args.title;
      result = await this.client.createAttachment(input);
    } catch (err) {
      throw new LinearTrackerError('Linear createAttachment failed', err);
    }
    if (!result.success) {
      throw new LinearTrackerError('Linear createAttachment returned success=false');
    }
  }
}

/** Convenience factory: wrap a real @linear/sdk LinearClient in our gateway. */
export function createLinearWriteGateway(
  client: LinearClient,
): LinearWriteGateway {
  return new SdkLinearWriteGateway(client as unknown as LinearWriteClient);
}
