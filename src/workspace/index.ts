// Public re-exports for the workspace module.

export { WorkspaceManager } from './manager.js';
export type { WorkspaceLocation, WorkspaceManagerOptions } from './manager.js';
export { runHook, HookExecutionError } from './hooks.js';
export type { HookEnv, HookResult, RunHookOptions } from './hooks.js';
