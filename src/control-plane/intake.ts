// src/control-plane/intake.ts
// Spec §7: re-home the orchestrator-session side effects the skill did
// interactively. The control plane (not a `claude -p` agent) renders context,
// creates the worktree off the base branch, and installs defense-in-depth.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { assertSafeIssueIdentifier, joinWithinRoot } from '../util/path-safety.js';
import type { Issue } from '../linear/issue.js';
import { buildSettingsJson } from './settings-policy.js';
import { installPrePush, neuterPushUrl } from './pre-push.js';

const execFileAsync = promisify(execFile);

export function renderTicketMd(issue: Issue): string {
  const labels = issue.labels.length > 0 ? issue.labels.join(', ') : 'none';
  return [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `- Status: ${issue.state}`,
    `- URL: ${issue.url ?? 'none'}`,
    `- Labels: ${labels}`,
    `- Priority: ${issue.priority ?? 'none'}`,
    `- Assignee / Parent / Project: (not fetched in MVP — agent reads deep context via the read-only Linear MCP)`,
    '',
    '## Description',
    '',
    issue.description && issue.description.length > 0 ? issue.description : '(no description)',
    '',
  ].join('\n');
}

export function renderCommentsMd(comments: ReadonlyArray<{ id: string; body: string }>): string {
  const header = [
    `# Comments`,
    '',
    '> Comments often carry decisions and scope detail not in the description. Read every one.',
    '> (author/timestamp are not captured in MVP — only the body.)',
    '',
  ];
  if (comments.length === 0) return [...header, '(no comments)', ''].join('\n');
  const body = comments.map((c, i) => `## ${i + 1}.\n${c.body}\n`);
  return [...header, ...body].join('\n');
}

export function renderContextPathsMd(args: {
  codeRoot: string;
  aiProto: string;
  aiProtoPullStatus: string;
}): string {
  return [
    `# Context paths`,
    '',
    `## Code reference root (worktree)`,
    `- ${args.codeRoot}/CLAUDE.md`,
    `- ${args.codeRoot}/.ai/`,
    `- ${args.codeRoot}/.claude/conventions/`,
    '',
    `## AI-prototype (CLIENT VISION — read only, NEVER modify)`,
    `- ${args.aiProto}/docs/`,
    '',
    `## AI-prototype pull status`,
    args.aiProtoPullStatus,
    '',
  ].join('\n');
}

export interface PrepareWorkspaceArgs {
  /** Shared repo root ($REPO). */
  repo: string;
  stateRoot: string;
  worktreeRoot: string;
  ticket: string;
  issue: Issue;
  comments: ReadonlyArray<{ id: string; body: string }>;
  /** e.g. "origin/development" in prod; a local branch name in tests. */
  baseBranch: string;
  aiProto: string;
  branch: string;
  /** On re-prep, the recorded baseSha to reset the agent branch to (clean-room). */
  baseSha?: string;
}

export interface PrepareWorkspaceResult {
  worktree: string;
  baseSha: string;
  aiProtoPullStatus: string;
}

/**
 * Idempotent intake. Creates the per-ticket state dir + worktree, renders the
 * three context files, writes mode/review-tickets, pulls AI-proto (best-effort),
 * and installs the security backstops. If the worktree already exists, runs the
 * clean-room reset (reset --hard baseSha + git clean -ffdx) instead of re-creating.
 */
export async function prepareWorkspace(args: PrepareWorkspaceArgs): Promise<PrepareWorkspaceResult> {
  assertSafeIssueIdentifier(args.ticket);
  const stateDir = joinWithinRoot(args.stateRoot, args.ticket);
  const worktree = joinWithinRoot(args.worktreeRoot, args.ticket);
  await fs.mkdir(stateDir, { recursive: true });

  // AI-proto fast-forward pull (best-effort; record status). For a remote-tracking
  // base ("origin/..."), also fetch first so the worktree base is current.
  let aiProtoPullStatus: string;
  try {
    await execFileAsync('git', ['-C', args.aiProto, 'pull', '--ff-only']);
    const { stdout } = await execFileAsync('git', ['-C', args.aiProto, 'rev-parse', 'HEAD']);
    aiProtoPullStatus = `ok, HEAD=${stdout.trim()}`;
  } catch (err) {
    aiProtoPullStatus = `FAILED: ${(err as Error).message}; using stale snapshot`;
  }

  // Worktree: create on first prep, clean-room on re-prep.
  let exists = false;
  try {
    await fs.access(worktree);
    exists = true;
  } catch {
    /* not yet */
  }
  if (exists) {
    // clean-room: discard planted files + HARD-RESET the agent branch to the
    // recorded baseSha. NEVER `checkout baseBranch` here — that detaches HEAD or
    // moves the branch under a newer tip. `-ffdx` also nukes nested git dirs.
    await execFileAsync('git', ['-C', worktree, 'clean', '-ffdx']);
    const resetTo = args.baseSha ?? args.baseBranch;
    await execFileAsync('git', ['-C', worktree, 'reset', '--hard', resetTo]);
  } else {
    // For a remote-tracking base, fetch the remote ref first (the test uses a
    // local branch, which has no slash, so it skips the fetch).
    if (args.baseBranch.includes('/')) {
      const [remote, ...rest] = args.baseBranch.split('/');
      await execFileAsync('git', ['-C', args.repo, 'fetch', remote!, rest.join('/')]);
    }
    await execFileAsync('git', ['-C', args.repo, 'worktree', 'add', '-b', args.branch, worktree, args.baseBranch]);
  }
  const { stdout: shaOut } = await execFileAsync('git', ['-C', worktree, 'rev-parse', 'HEAD']);
  const baseSha = shaOut.trim();

  // Context files.
  await fs.writeFile(path.join(stateDir, 'ticket.md'), renderTicketMd(args.issue), 'utf8');
  await fs.writeFile(path.join(stateDir, 'comments.md'), renderCommentsMd(args.comments), 'utf8');
  await fs.writeFile(
    path.join(stateDir, 'context-paths.md'),
    renderContextPathsMd({ codeRoot: worktree, aiProto: args.aiProto, aiProtoPullStatus }),
    'utf8',
  );
  await fs.writeFile(path.join(stateDir, 'mode'), 'worktree\n', 'utf8');
  await fs.writeFile(path.join(stateDir, 'review-tickets'), `${args.ticket}\n`, 'utf8');

  // Security install (spec §11): pre-push at the shared repo, settings.json in the worktree.
  await installPrePush(path.join(args.repo, '.git'));
  await neuterPushUrl(worktree);
  const claudeDir = path.join(worktree, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(buildSettingsJson(), null, 2), 'utf8');

  return { worktree, baseSha, aiProtoPullStatus };
}
