// Public re-exports for the config module. Keep external imports flat.

export {
  parseWorkflowConfig,
  WorkflowConfigSchema,
  TrackerConfigSchema,
  PollingConfigSchema,
  WorkspaceConfigSchema,
  HooksConfigSchema,
  AgentConfigSchema,
  ClaudeConfigSchema,
  PermissionModeSchema,
} from './schema.js';
export type {
  WorkflowConfig,
  TrackerConfig,
  PollingConfig,
  WorkspaceConfig,
  HooksConfig,
  AgentConfig,
  ClaudeConfig,
  PermissionMode,
} from './schema.js';

export { resolveConfig, MissingEnvVarError } from './resolve.js';
export type { ResolvedWorkflowConfig } from './resolve.js';
export { preflightConfig, PreflightError } from './preflight.js';
