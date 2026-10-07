// src/control-plane/linear-read.ts
// Spec §7: read-only Linear surface for rendering ticket.md/comments.md. No write
// methods exist on this gateway. Mirrors src/linear/writes.ts but uses a
// read-scoped token client (config.linear.read_token_env).

import { LinearClient } from '@linear/sdk';

import { adaptIssue, type RawLinearIssue } from '../linear/adapter.js';
import { LinearTrackerError } from '../linear/gateway.js';
import type { Issue } from '../linear/issue.js';

/** SDK subset this gateway calls — declared independently so tests can fake it. */
export interface LinearReadClient {
  issues(args: { first?: number; filter?: Record<string, unknown> }): Promise<{
    nodes: ReadonlyArray<{
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
    }>;
  }>;
  issue(idOrIdentifier: string): Promise<{
    comments(args?: { first?: number }): Promise<{ nodes: ReadonlyArray<{ id: string; body: string }> }>;
  } | null>;
}

export interface LinearReadGateway {
  fetchIssueByIdentifier(identifier: string): Promise<Issue | null>;
  listComments(issueId: string): Promise<ReadonlyArray<{ id: string; body: string }>>;
}

export class SdkLinearReadGateway implements LinearReadGateway {
  constructor(private readonly client: LinearReadClient) {}

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
      throw new LinearTrackerError(`Linear issue ${node.identifier} has no resolvable state name`);
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
    if (!issue) throw new LinearTrackerError(`listComments: issue ${issueId} not found`);
    try {
      const conn = await issue.comments({ first: 100 });
      return conn.nodes.map((c) => ({ id: c.id, body: c.body }));
    } catch (err) {
      throw new LinearTrackerError('Linear comments fetch failed', err);
    }
  }
}

/** Wrap a real @linear/sdk client (read-scoped token) in the read gateway. */
export function createLinearReadGateway(client: LinearClient): LinearReadGateway {
  return new SdkLinearReadGateway(client as unknown as LinearReadClient);
}

/** Construct a read-scoped LinearClient from the env var named in config. */
export function createLinearReadClient(readTokenEnv: string, env: NodeJS.ProcessEnv = process.env): LinearClient {
  const apiKey = env[readTokenEnv];
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new LinearTrackerError(`Linear read token env "${readTokenEnv}" is not set`);
  }
  return new LinearClient({ apiKey });
}
