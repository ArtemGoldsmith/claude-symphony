// SPEC.md §3.1.3 + §11.1 + §11.2 + §11.4 — Linear adapter implemented over @linear/sdk.
// PARITY.md rows: §3.1.3, §11.1, §11.2, §11.4.
//
// Wraps @linear/sdk's LinearClient and produces normalized Issue values via
// adapter.ts. The gateway interface keeps callers (orchestrator, retry) free
// of SDK types so they can be tested without the SDK at all.

import type { LinearClient } from '@linear/sdk';

import { adaptIssue, type RawLinearIssue, type RawLinearRelation } from './adapter.js';
import { type LinearGateway, LinearTrackerError } from './gateway.js';
import type { Issue } from './issue.js';

/**
 * Subset of @linear/sdk's `LinearClient` that this gateway actually calls.
 * Declared independently so unit tests can supply a hand-rolled fake without
 * pulling in the full SDK types.
 */
export interface IssuesQueryClient {
  issues(args: IssuesQueryArgs): Promise<IssuesQueryResult>;
}

export interface IssuesQueryArgs {
  first?: number;
  after?: string;
  filter?: Record<string, unknown>;
}

export interface IssuesQueryResult {
  nodes: ReadonlyArray<SdkIssueNode>;
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

/**
 * Fields and lazy accessors we need from a `@linear/sdk` Issue node. Real
 * SDK Issue objects expose `state` as a Promise getter and `labels()` as a
 * function returning a Promise; this interface mirrors that shape so the
 * implementation matches both real and faked clients.
 */
export interface SdkIssueNode {
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
  inverseRelations?(): Promise<{ nodes: ReadonlyArray<RawLinearRelation> } | null | undefined>;
}

/** Linear GraphQL page size cap. SPEC.md §11.2 calls for 50. */
const PAGE_SIZE = 50;

export class SdkLinearGateway implements LinearGateway {
  /** Whether to populate `blockedBy` on issues. Off in MVP to keep latency low. */
  private readonly resolveBlockers: boolean;

  constructor(
    private readonly client: IssuesQueryClient,
    options: { resolveBlockers?: boolean } = {},
  ) {
    this.resolveBlockers = options.resolveBlockers ?? false;
  }

  async fetchActiveCandidates(projectSlug: string, activeStates: string[]): Promise<Issue[]> {
    if (activeStates.length === 0) return [];
    const filter = {
      project: { slugId: { eq: projectSlug } },
      state: { name: { in: activeStates } },
    };
    return this.collectAll(filter);
  }

  async fetchIssueByIdentifier(identifier: string): Promise<Issue | null> {
    const match = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/.exec(identifier.trim());
    if (!match) {
      throw new LinearTrackerError(
        `fetchIssueByIdentifier: malformed identifier "${identifier}"; expected TEAM-NNN`,
      );
    }
    const teamKey = match[1]!;
    const number = Number.parseInt(match[2]!, 10);
    const filter = {
      team: { key: { eq: teamKey } },
      number: { eq: number },
    };
    const result = await this.collectAll(filter, { first: 1, single: true });
    return result[0] ?? null;
  }

  private async collectAll(
    filter: Record<string, unknown>,
    options: { first?: number; single?: boolean } = {},
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    let cursor: string | undefined;
    const pageSize = options.first ?? PAGE_SIZE;

    do {
      let page: IssuesQueryResult;
      try {
        page = await this.client.issues({
          first: pageSize,
          ...(cursor ? { after: cursor } : {}),
          filter,
        });
      } catch (err) {
        throw new LinearTrackerError('Linear issues query failed', err);
      }

      for (const node of page.nodes) {
        issues.push(await this.materialize(node));
      }

      if (options.single) break;
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor ?? undefined : undefined;
    } while (cursor);

    return issues;
  }

  private async materialize(node: SdkIssueNode): Promise<Issue> {
    const [stateResolved, labelsResolved, relationsResolved] = await Promise.all([
      node.state,
      node.labels(),
      this.resolveBlockers && node.inverseRelations
        ? node.inverseRelations()
        : Promise.resolve(null),
    ]);

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
        nodes: (labelsResolved?.nodes ?? []).map((label) => ({
          name: typeof label?.name === 'string' ? label.name : '',
        })),
      },
      inverseRelations: relationsResolved
        ? { nodes: relationsResolved.nodes ?? [] }
        : null,
      createdAt: node.createdAt ?? null,
      updatedAt: node.updatedAt ?? null,
    };

    return adaptIssue(raw);
  }
}

/**
 * Convenience factory: wrap a real `@linear/sdk` LinearClient in our gateway.
 */
export function createLinearGateway(
  client: LinearClient,
  options: { resolveBlockers?: boolean } = {},
): LinearGateway {
  return new SdkLinearGateway(client as unknown as IssuesQueryClient, options);
}
