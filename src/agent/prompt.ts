// SPEC.md §3.1.6 + §5.4 + §12 — Prompt Construction.
// PARITY.md rows: §5.4, §12.1, §12.2, §12.4.
//
// MVP supports {{ name }} and {{ object.field }} substitution only.
// Filters and conditional blocks ({% if %}, {% for %}) are deferred to
// Phase 2 along with the continuation/turns design (SPEC-claude.md §C).
// Unknown variables fail rendering loudly per SPEC.md §12.2.

import type { Issue } from '../linear/issue.js';

export class PromptRenderError extends Error {
  constructor(
    message: string,
    public readonly templateExcerpt: string,
  ) {
    super(`${message} (near: ${templateExcerpt})`);
    this.name = 'PromptRenderError';
  }
}

/**
 * Inputs available to a WORKFLOW.md prompt template (SPEC.md §12.1).
 * `attempt` is `null` on the first dispatch and remains null in MVP since
 * continuation/turn semantics are deferred (SPEC-claude.md §C).
 */
export interface PromptVariables {
  issue: PromptIssueView;
  attempt: number | null;
}

export interface PromptIssueView {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
  branchName: string;
  labels: string;
}

const VAR_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*\}\}/g;

/**
 * Map a normalized Issue to the string-shaped view exposed in templates.
 * Null fields in Issue become empty strings; labels are joined by ", ".
 */
export function buildIssueView(issue: Issue): PromptIssueView {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? '',
    state: issue.state,
    url: issue.url ?? '',
    branchName: issue.branchName ?? '',
    labels: issue.labels.join(', '),
  };
}

/**
 * Render a WORKFLOW.md prompt template against the issue + attempt context.
 * Throws PromptRenderError on the first unknown variable reference.
 */
export function renderPrompt(template: string, vars: PromptVariables): string {
  return template.replace(VAR_PATTERN, (match, path: string) => {
    const segments = path.split('.');
    const value = lookup(vars, segments);
    if (value === undefined) {
      throw new PromptRenderError(`unknown template variable: "${path}"`, match);
    }
    return value === null ? '' : String(value);
  });
}

function lookup(root: PromptVariables, path: string[]): unknown {
  const top = path[0];
  if (top === 'attempt') {
    return path.length === 1 ? root.attempt : undefined;
  }
  if (top === 'issue') {
    if (path.length === 1) return undefined; // require subfield, not whole object
    const field = path[1] as keyof PromptIssueView;
    if (!(field in root.issue)) return undefined;
    return root.issue[field];
  }
  return undefined;
}
