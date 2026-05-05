// SPEC.md §3.1 + §11.5 + SPEC-claude.md §D — symphony_linear in-process
// MCP server. PARITY.md row: §11.5 (B7).
//
// Codex review item D: the public Linear MCP at mcp.linear.app/mcp is a
// vendor-managed, OAuth-fronted contract whose tool surface can drift.
// claude-symphony depends on a stable set of workflow operations (find or
// update the workpad comment, transition state, attach a PR, etc.), so we
// expose those as a small in-process MCP server scoped to the configured
// project. The agent can still use the public Linear MCP for general
// Linear access.
//
// `createSdkMcpServer` from claude-agent-sdk plumbs the server in-process
// (no subprocess, zero-overhead) and the SDK injects it under
// `mcp__symphony_linear__*` tool names alongside the rest of the agent's
// tools. The server captures the current Issue in a closure so all six
// tools refuse to operate on any other ticket — the agent on SMI-239
// physically cannot post a comment to SMI-300.

import { z } from 'zod';

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk';

import type { Issue } from '../linear/issue.js';
import type { LinearWriteGateway } from '../linear/gateway.js';

const WORKPAD_HEADER = '## Codex Workpad';

export interface SymphonyLinearServerOptions {
  /** Issue this server is scoped to. Tools refuse to operate on any other. */
  currentIssue: Issue;
  /** Linear write surface. */
  writes: LinearWriteGateway;
  /**
   * Configured project slug. Tools verify the issue's project matches at
   * construction time (caller's responsibility) and otherwise treat the
   * scoped issue as authoritative.
   */
  projectSlug: string;
  /**
   * Tool names from the canonical 6-tool surface that should NOT be
   * registered. Use to dial down to read-only or skip transition_state
   * when state management lives elsewhere. Names match those in
   * `SYMPHONY_LINEAR_TOOL_NAMES` below.
   */
  disabledTools?: ReadonlyArray<string>;
}

/** Canonical names of all tools the symphony_linear server can expose. */
export const SYMPHONY_LINEAR_TOOL_NAMES = [
  'get_current_issue',
  'get_workpad',
  'create_or_update_workpad',
  'transition_state',
  'attach_pr_url',
  'post_comment',
] as const;

/**
 * Build the in-process symphony_linear MCP server. The returned object is
 * ready to drop into claude-agent-sdk's options.mcpServers under any key
 * (the server's internal name is fixed to "symphony_linear"; tool names
 * end up as `mcp__symphony_linear__<tool>`).
 */
export function createSymphonyLinearMcpServer(
  options: SymphonyLinearServerOptions,
): McpSdkServerConfigWithInstance {
  const { currentIssue, writes } = options;
  const teamKey = currentIssue.identifier.split('-')[0]!;

  const okText = (text: string) => ({
    content: [{ type: 'text' as const, text }],
  });
  const errText = (text: string) => ({
    content: [{ type: 'text' as const, text }],
    isError: true,
  });

  const findWorkpadId = async (): Promise<{ id: string; body: string } | null> => {
    const comments = await writes.listComments(currentIssue.id);
    for (const c of comments) {
      if (c.body.trimStart().startsWith(WORKPAD_HEADER)) {
        return { id: c.id, body: c.body };
      }
    }
    return null;
  };

  const disabled = new Set(options.disabledTools ?? []);

  const allTools = [
      // 1. get_current_issue
      tool(
        'get_current_issue',
        `Re-fetch the current Linear issue (${currentIssue.identifier}) in full. ` +
          `Returns id, identifier, title, description, current state, labels, blockers, and timestamps. ` +
          `Use this when you need a fresh snapshot — the data the dispatch prompt embedded may be stale by now.`,
        {},
        async () => {
          try {
            const refreshed = await writes.fetchIssueByIdentifier(currentIssue.identifier);
            if (!refreshed) {
              return errText(`Issue ${currentIssue.identifier} not found.`);
            }
            return okText(JSON.stringify(refreshed, null, 2));
          } catch (err) {
            return errText(`get_current_issue failed: ${(err as Error).message}`);
          }
        },
      ),

      // 2. get_workpad
      tool(
        'get_workpad',
        `Find this issue's existing "${WORKPAD_HEADER}" comment if one exists. ` +
          `Returns { id, body } or "no workpad yet". The workpad is the single ` +
          `persistent comment claude-symphony agents use to coordinate across continuations.`,
        {},
        async () => {
          try {
            const wp = await findWorkpadId();
            if (wp === null) {
              return okText('no workpad yet');
            }
            return okText(JSON.stringify(wp, null, 2));
          } catch (err) {
            return errText(`get_workpad failed: ${(err as Error).message}`);
          }
        },
      ),

      // 3. create_or_update_workpad
      tool(
        'create_or_update_workpad',
        `Idempotent: if a "${WORKPAD_HEADER}" comment already exists on this issue, ` +
          `replace its body with the supplied text. Otherwise create a new comment ` +
          `with that body (which MUST start with the "${WORKPAD_HEADER}" header). ` +
          `One workpad per issue is the contract; do not create stray secondary comments.`,
        {
          body: z
            .string()
            .min(1)
            .describe('Full markdown body for the workpad. Must start with "## Codex Workpad".'),
        },
        async ({ body }) => {
          if (!body.trimStart().startsWith(WORKPAD_HEADER)) {
            return errText(`workpad body must start with "${WORKPAD_HEADER}"`);
          }
          try {
            const existing = await findWorkpadId();
            if (existing !== null) {
              await writes.updateComment({ commentId: existing.id, body });
              return okText(`workpad updated: ${existing.id}`);
            }
            const created = await writes.createComment({ issueId: currentIssue.id, body });
            return okText(`workpad created: ${created.id}`);
          } catch (err) {
            return errText(`create_or_update_workpad failed: ${(err as Error).message}`);
          }
        },
      ),

      // 4. transition_state
      tool(
        'transition_state',
        `Transition this issue to the given workflow state by name (e.g. "Human Review", ` +
          `"Cancelled"). Names are case-sensitive and must exist in the team's workflow. ` +
          `Use this when handing off to a reviewer or marking yourself blocked.`,
        {
          to_state: z
            .string()
            .min(1)
            .describe('Exact Linear workflow state name to move the issue to.'),
        },
        async ({ to_state }) => {
          try {
            const stateId = await writes.findWorkflowStateId({
              teamKey,
              stateName: to_state,
            });
            if (stateId === null) {
              return errText(
                `no workflow state named "${to_state}" in team ${teamKey}; ` +
                  `check the case and the team's workflow configuration`,
              );
            }
            await writes.updateIssueState({ issueId: currentIssue.id, stateId });
            return okText(`${currentIssue.identifier} transitioned to "${to_state}"`);
          } catch (err) {
            return errText(`transition_state failed: ${(err as Error).message}`);
          }
        },
      ),

      // 5. attach_pr_url
      tool(
        'attach_pr_url',
        `Attach a pull/merge request URL to this issue as a Linear attachment. ` +
          `Provide the canonical URL (e.g. https://github.com/org/repo/pull/123). ` +
          `Optional title; if omitted, Linear auto-derives one from the URL.`,
        {
          url: z.string().url().describe('Canonical PR/MR URL.'),
          title: z.string().optional().describe('Optional human-readable title.'),
        },
        async ({ url, title }) => {
          try {
            const args: { issueId: string; url: string; title?: string } = {
              issueId: currentIssue.id,
              url,
            };
            if (title !== undefined) args.title = title;
            await writes.createAttachment(args);
            return okText(`attached ${url} to ${currentIssue.identifier}`);
          } catch (err) {
            return errText(`attach_pr_url failed: ${(err as Error).message}`);
          }
        },
      ),

      // 6. post_comment
      tool(
        'post_comment',
        `Post a fresh Linear comment on this issue. NOT for the workpad — use ` +
          `create_or_update_workpad for that. Use post_comment for blocker reports, ` +
          `final summaries to the human reviewer, or anything that should NOT be ` +
          `replaced on the next dispatch.`,
        {
          body: z.string().min(1).describe('Markdown body of the comment.'),
        },
        async ({ body }) => {
          if (body.trimStart().startsWith(WORKPAD_HEADER)) {
            return errText(
              `body looks like a workpad comment (starts with "${WORKPAD_HEADER}"). ` +
                `Use create_or_update_workpad instead so we don't create duplicates.`,
            );
          }
          try {
            const created = await writes.createComment({ issueId: currentIssue.id, body });
            return okText(`comment posted: ${created.id}`);
          } catch (err) {
            return errText(`post_comment failed: ${(err as Error).message}`);
          }
        },
      ),
    ];

  return createSdkMcpServer({
    name: 'symphony_linear',
    version: '0.1.0',
    tools: allTools.filter(
      (t) => !disabled.has((t as { name?: string }).name ?? ''),
    ),
  });
}
