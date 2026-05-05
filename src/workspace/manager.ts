// SPEC.md §3.1.5 + §9.1 + §9.2 + §9.3 — Workspace Manager.
// PARITY.md rows: §3.1.5, §9.1, §9.2, §9.3.
// `before_remove` hook and removal flow are deferred to Phase 2.

import fs from 'node:fs/promises';

import type { Issue } from '../linear/issue.js';
import { assertSafeIssueIdentifier, joinWithinRoot } from '../util/path-safety.js';
import { type HookResult, runHook } from './hooks.js';

export interface WorkspaceLocation {
  /** Absolute path of the per-issue workspace directory. */
  path: string;
  /** True if this call created the directory. False if it already existed. */
  created: boolean;
  /** Captured output from the after_create hook, if one ran. */
  hookResult: HookResult | null;
}

export interface WorkspaceManagerOptions {
  /** Workspace root (already env- and home-resolved). */
  root: string;
  /** Optional after_create hook script body (already validated). */
  afterCreateHook?: string | undefined;
  /** Optional before_remove hook script body. Runs in cwd before rm-rf. */
  beforeRemoveHook?: string | undefined;
  /** Optional per-hook timeout in milliseconds. Defaults to runHook's default. */
  hookTimeoutMs?: number;
}

/**
 * Map issues to per-issue workspace directories under a fixed root and run
 * the after_create hook on first creation. Idempotent: subsequent calls for
 * the same issue reuse the existing directory and do NOT re-run the hook.
 */
export class WorkspaceManager {
  constructor(private readonly options: WorkspaceManagerOptions) {}

  /**
   * Compute the workspace path for an issue without touching the filesystem.
   * Useful for log lines and dry-run paths.
   */
  pathFor(identifier: string): string {
    assertSafeIssueIdentifier(identifier);
    return joinWithinRoot(this.options.root, identifier);
  }

  /**
   * Phase 3 P6: run the configured before_remove hook (if any) and then
   * recursively delete the per-issue workspace directory. Idempotent —
   * a missing directory is treated as success.
   */
  async removeWorkspace(issue: Issue): Promise<void> {
    assertSafeIssueIdentifier(issue.identifier);
    const workspacePath = joinWithinRoot(this.options.root, issue.identifier);
    const exists = await directoryExists(workspacePath);
    if (!exists) return;

    if (this.options.beforeRemoveHook && this.options.beforeRemoveHook.length > 0) {
      await runHook(
        this.options.beforeRemoveHook,
        workspacePath,
        {
          ISSUE_ID: issue.id,
          ISSUE_IDENTIFIER: issue.identifier,
          ISSUE_TITLE: issue.title,
          ISSUE_URL: issue.url ?? '',
          WORKSPACE_PATH: workspacePath,
        },
        this.options.hookTimeoutMs !== undefined
          ? { timeoutMs: this.options.hookTimeoutMs }
          : {},
      );
    }
    await fs.rm(workspacePath, { recursive: true, force: true });
  }

  /**
   * Ensure the per-issue workspace directory exists. Returns the location
   * record describing whether the directory was just created and any hook
   * output captured.
   */
  async ensureWorkspace(issue: Issue): Promise<WorkspaceLocation> {
    assertSafeIssueIdentifier(issue.identifier);
    const workspacePath = joinWithinRoot(this.options.root, issue.identifier);

    const existedBefore = await directoryExists(workspacePath);
    if (!existedBefore) {
      await fs.mkdir(workspacePath, { recursive: true });
    }

    let hookResult: HookResult | null = null;
    if (!existedBefore && this.options.afterCreateHook) {
      hookResult = await runHook(
        this.options.afterCreateHook,
        workspacePath,
        {
          ISSUE_ID: issue.id,
          ISSUE_IDENTIFIER: issue.identifier,
          ISSUE_TITLE: issue.title,
          ISSUE_URL: issue.url ?? '',
          WORKSPACE_PATH: workspacePath,
        },
        this.options.hookTimeoutMs !== undefined
          ? { timeoutMs: this.options.hookTimeoutMs }
          : {},
      );
    }

    return {
      path: workspacePath,
      created: !existedBefore,
      hookResult,
    };
  }
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

