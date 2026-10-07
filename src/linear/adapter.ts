// SPEC.md §11.3 — Linear payload normalization.
// PARITY.md row: §11.3.
//
// Pure functions: take a raw Linear-shaped issue and produce the canonical
// Issue domain object. Kept independent of @linear/sdk so the same adapter
// can be exercised in unit tests with hand-crafted fixtures and in
// production against the SDK's resolved value.

import type { Issue, IssueRef } from './issue.js';

/**
 * Minimal shape we need from a Linear issue payload. Fields mirror the
 * Linear GraphQL schema; relations (state, labels, inverseRelations) are
 * pre-resolved by the caller so this adapter stays synchronous.
 */
export interface RawLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  state: { name: string };
  branchName?: string | null;
  url?: string | null;
  labels?: { nodes: ReadonlyArray<{ name: string }> } | null;
  /** Inverse relations: other issues that point AT this one with type. */
  inverseRelations?: {
    nodes: ReadonlyArray<RawLinearRelation>;
  } | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
}

export interface RawLinearRelation {
  type: string;
  issue: {
    id?: string | null;
    identifier?: string | null;
    state?: { name?: string | null } | null;
  } | null;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  // String input — only accept if it parses to a valid date. SPEC.md §11.3
  // says "parse ISO-8601 timestamps"; we re-emit canonical ISO-8601 to avoid
  // propagating tracker-side formatting variance.
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizePriority(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (!Number.isFinite(raw)) return null;
  if (!Number.isInteger(raw)) return null;
  return raw;
}

function normalizeLabels(
  raw: { nodes: ReadonlyArray<{ name: string }> } | null | undefined,
): string[] {
  if (!raw || !raw.nodes) return [];
  return raw.nodes
    .map((node) => (typeof node.name === 'string' ? node.name.toLowerCase() : ''))
    .filter((name) => name.length > 0);
}

/**
 * Extract blocker refs from inverse relations. Per SPEC.md §11.3 we keep only
 * relations whose type is exactly `"blocks"`.
 */
function normalizeBlockedBy(
  raw: { nodes: ReadonlyArray<RawLinearRelation> } | null | undefined,
): IssueRef[] {
  if (!raw || !raw.nodes) return [];
  const refs: IssueRef[] = [];
  for (const relation of raw.nodes) {
    if (relation.type !== 'blocks') continue;
    refs.push({
      id: relation.issue?.id ?? null,
      identifier: relation.issue?.identifier ?? null,
      state: relation.issue?.state?.name ?? null,
    });
  }
  return refs;
}

/**
 * Convert a raw Linear issue payload into the canonical Issue model.
 * Throws if essential identity fields are missing; treats every other
 * unexpected null/missing as the spec-mandated null/empty default.
 */
export function adaptIssue(raw: RawLinearIssue): Issue {
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error('adaptIssue: raw.id is missing or not a string');
  }
  if (typeof raw.identifier !== 'string' || raw.identifier.length === 0) {
    throw new Error('adaptIssue: raw.identifier is missing or not a string');
  }
  if (!raw.state || typeof raw.state.name !== 'string') {
    throw new Error('adaptIssue: raw.state.name is missing');
  }

  return {
    id: raw.id,
    identifier: raw.identifier,
    title: typeof raw.title === 'string' ? raw.title : '',
    description: raw.description ?? null,
    priority: normalizePriority(raw.priority ?? null),
    state: raw.state.name,
    branchName: raw.branchName ?? null,
    url: raw.url ?? null,
    labels: normalizeLabels(raw.labels),
    blockedBy: normalizeBlockedBy(raw.inverseRelations),
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
  };
}
