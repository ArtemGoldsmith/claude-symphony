// Public re-exports for the agent module.

export { renderPrompt, buildIssueView, PromptRenderError } from './prompt.js';
export type { PromptVariables, PromptIssueView } from './prompt.js';

export { AgentRunner, buildQueryOptions, createSdkQueryFactory } from './runner.js';
export type {
  AgentRunInput,
  AgentRunResult,
  AggregatedUsage,
  ExitReason,
  QueryFactory,
  QueryOptions,
  SdkResultMessage,
  AgentSdkMessage,
} from './runner.js';
