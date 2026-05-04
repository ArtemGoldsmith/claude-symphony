// Public re-exports for the linear module.

export type { Issue, IssueRef } from './issue.js';
export { adaptIssue } from './adapter.js';
export type { RawLinearIssue, RawLinearRelation } from './adapter.js';
export type { LinearGateway } from './gateway.js';
export { LinearTrackerError } from './gateway.js';
export {
  SdkLinearGateway,
  createLinearGateway,
  type IssuesQueryClient,
  type IssuesQueryArgs,
  type IssuesQueryResult,
  type SdkIssueNode,
} from './client.js';
