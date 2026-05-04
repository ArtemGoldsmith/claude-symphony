// Public re-exports for the linear module.

export type { Issue, IssueRef } from './issue.js';
export { adaptIssue } from './adapter.js';
export type { RawLinearIssue, RawLinearRelation } from './adapter.js';
export type { LinearGateway, LinearWriteGateway } from './gateway.js';
export {
  SdkLinearWriteGateway,
  createLinearWriteGateway,
  type LinearWriteClient,
  type WriteIssueNode,
} from './writes.js';
export { LinearTrackerError } from './gateway.js';
export {
  SdkLinearGateway,
  createLinearGateway,
  type IssuesQueryClient,
  type IssuesQueryArgs,
  type IssuesQueryResult,
  type SdkIssueNode,
} from './client.js';
