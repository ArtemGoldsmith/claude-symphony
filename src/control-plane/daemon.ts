// src/control-plane/daemon.ts
// Spec §10/§16: control-plane daemon wiring. Acquires the singleton lock, builds
// the engine over a ProcessManager-backed dispatcher, and runs a periodic tick.
// No HTTP — the Hono board (Plan 3) co-hosts later. Exposes start/stop.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Logger } from 'pino';

import type { ControlPlaneConfig } from './config.js';
import { Engine, type Dispatcher, type DispatchArgs } from './engine.js';
import { ProcessManager } from './process-manager.js';
import { SlotCounter } from './slots.js';
import { SingletonLock } from './lock.js';
import { TaskStore } from './task-store.js';
import { taskDir, type TaskRecord } from './task-record.js';
import { renderTemplate, renderExecutePrompt } from './prompts.js';
import { prepareWorkspace } from './intake.js';
import { buildSettingsJson } from './settings-policy.js';
import { createLinearReadClient, createLinearReadGateway, type LinearReadGateway } from './linear-read.js';
import type { Phase } from './phase.js';

const execFileAsync = promisify(execFile);

/** Read review-fresh.md and decide if MISSING/PARTIAL gaps remain (spec §4 fork C). */
export async function reviewHasGaps(stateDir: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(stateDir, 'review-fresh.md'), 'utf8');
  } catch {
    return false; // no review → fail open to closing
  }
  if (/none\s+—\s+all acs covered/i.test(raw)) return false;
  return /\b(MISSING|PARTIAL)\b/.test(raw);
}

/** agent/<lower-ticket>-<slug> from the title (slug: alnum→hyphen, trimmed, ≤40). */
export function deriveBranch(ticket: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug.length > 0 ? `agent/${ticket.toLowerCase()}-${slug}` : `agent/${ticket.toLowerCase()}`;
}

/** Is this prep/execute dispatch a RETRY (source phase is the matching *_failed)? */
export function isRetryDispatch(sourcePhase: Phase, to: Phase): boolean {
  return (to === 'executing' && sourcePhase === 'execute_failed') ||
         (to === 'prepping' && sourcePhase === 'prep_failed');
}

/** Overwrite the worktree's .claude/settings.json from the daemon's canonical
 *  policy — runs before EVERY spawn so a prior agent cannot weaken it. Exported for the tamper test. */
export async function writeSettings(worktree: string): Promise<string> {
  const claudeDir = path.join(worktree, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  await fs.writeFile(settingsPath, JSON.stringify(buildSettingsJson(), null, 2), 'utf8');
  return settingsPath;
}

export interface ControlPlaneHandle {
  engine: Engine;
  store: TaskStore;
  linearRead: LinearReadGateway;
  stop: () => Promise<void>;
}

export interface BootControlPlaneDeps {
  logger: Logger;
  ownerGen: string;
  now?: () => number;
  /** Tick cadence; default 2000ms. */
  tickIntervalMs?: number;
  /** Injectable read gateway for tests / no-Linear boot; defaults to the real SDK gateway. */
  linearRead?: LinearReadGateway;
}

/** The agent kinds dispatchForKind handles — exactly the config.prompts keys. */
type PromptKind = keyof ControlPlaneConfig['prompts'];

/** Best-effort read of a state-dir file (empty string if absent). */
async function readOpt(p: string): Promise<string> {
  try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
}

/** Format operator answers into a plain block for the execute prompt (empty if none). */
function formatAnswers(task: TaskRecord): string {
  const a = task.answers;
  if (!a || !a.values || Object.keys(a.values).length === 0) return '';
  return Object.entries(a.values).map(([k, v]) => `${k}: ${v}`).join('\n');
}

/**
 * Render config.prompts[kind] + build argv/env, then dispatch via ProcessManager.
 * THE box-coupled seam (spec §6): the exact placeholder set each template uses is
 * owned by the private skill-dir templates (handoff); this builds a standard
 * context (TICKET_ID/BRANCH/WORKTREE/STATE_DIR/AI_PROTO + the rendered
 * ticket/comments/context/plan bodies). renderTemplate THROWS on an unknown
 * placeholder, so a template referencing a var not in the context fails loudly —
 * by design. Validated by the box-only e2e (Task 13) + manual run, not unit tests.
 */
async function dispatchForKind(
  pm: ProcessManager,
  store: TaskStore,
  config: ControlPlaneConfig,
  linearRead: LinearReadGateway,
  args: DispatchArgs,
): Promise<void> {
  // The Engine only ever dispatches agent kinds through here. preview/teardown
  // are Plan-4 kinds with no config.prompts entry; reject them so the index below
  // is provably a prompt key.
  if (args.kind === 'preview' || args.kind === 'teardown') {
    throw new Error(`dispatchForKind: ${args.kind} is a Plan-4 kind`);
  }
  const kind: PromptKind = args.kind;

  const task = await store.get(args.ticket);
  if (!task) throw new Error(`dispatchForKind: unknown task ${args.ticket}`);
  const stateDir = taskDir(config.state_root, args.ticket);

  // --- prep: run intake at the promotion (before the worktree guard) ---
  let worktree = task.worktree;
  let effectiveBranch = task.branch ?? ''; // the prep prompt's {{BRANCH}} must be the real branch, not '' on first prep
  let intakeFields: ((r: TaskRecord) => void) | undefined;
  if (kind === 'prep') {
    const issue = await linearRead.fetchIssueByIdentifier(args.ticket);
    if (!issue) throw new Error(`dispatchForKind: ${args.ticket} not found in Linear`);
    const comments = await linearRead.listComments(issue.id);
    const branch = task.branch ?? deriveBranch(args.ticket, task.title);
    const result = await prepareWorkspace({
      repo: config.workspace.repo,
      stateRoot: config.state_root,
      worktreeRoot: config.workspace.root,
      ticket: args.ticket,
      issue, comments,
      baseBranch: config.workspace.base_branch,
      aiProto: config.linear.ai_proto_path,
      branch,
      ...(task.baseSha ? { baseSha: task.baseSha } : {}),
    });
    worktree = result.worktree;
    effectiveBranch = branch;
    intakeFields = (r) => { r.branch = branch; r.worktree = result.worktree; r.baseSha = result.baseSha; };
  } else if (kind === 'execute' && isRetryDispatch(task.phase, args.to)) {
    // execute retry: clean-room reset to baseSha before re-running the executor.
    if (!worktree || !task.baseSha) throw new Error(`dispatchForKind: execute retry needs worktree+baseSha for ${args.ticket}`);
    await execFileAsync('git', ['-C', worktree, 'clean', '-ffdx']);
    await execFileAsync('git', ['-C', worktree, 'reset', '--hard', task.baseSha]);
  }
  if (!worktree) throw new Error(`dispatchForKind: ${args.ticket} has no worktree (intake not run)`);

  // canonical settings re-written before every spawn
  const settingsPath = await writeSettings(worktree);
  const logRel = pm.logRelForKind(kind);
  const promptPath = config.prompts[kind];

  const ctx: Record<string, string> = {
    TICKET_ID: task.ticket,
    BRANCH: effectiveBranch,
    WORKTREE: worktree,
    STATE_DIR: stateDir,
    AI_PROTO: config.linear.ai_proto_path,
    TICKET_BODY: await readOpt(path.join(stateDir, 'ticket.md')),
    COMMENTS_BODY: await readOpt(path.join(stateDir, 'comments.md')),
    CONTEXT_PATHS: await readOpt(path.join(stateDir, 'context-paths.md')),
    PLAN_BODY: await readOpt(path.join(stateDir, 'plan.md')),
    REVIEW_TICKETS: (await readOpt(path.join(stateDir, 'review-tickets'))).trim(),
  };

  const template = await fs.readFile(promptPath, 'utf8');
  let prompt: string;
  let resumeSessionId: string | undefined;
  if (kind === 'execute') {
    prompt = renderExecutePrompt(template, { values: ctx, operatorAnswers: formatAnswers(task) });
  } else {
    if (kind === 'gapfix') {
      const sid = task.currentRun?.sessionId ?? (await pm.captureSessionId(path.join(stateDir, 'agent.jsonl')));
      if (sid) {
        resumeSessionId = sid;
      } else {
        // NO-SESSION on (re)dispatch: drop any partial edits from the failed gapfix
        // so the fresh fixer starts from the last commit, not dirty state.
        await execFileAsync('git', ['-C', worktree, 'reset', '--hard', 'HEAD']);
      }
    }
    prompt = renderTemplate(template, ctx);
  }

  const argv = pm.buildAgentArgv(resumeSessionId ? { prompt, settingsPath, resumeSessionId } : { prompt, settingsPath });
  await pm.dispatchAgent({
    store, ticket: args.ticket, expectRev: args.expectRev, kind,
    logRel, command: argv, cwd: worktree, env: pm.buildAgentEnv(), to: args.to,
    ...(intakeFields ? { extraMutate: intakeFields } : {}),
  });
}

export async function bootControlPlane(
  config: ControlPlaneConfig,
  deps: BootControlPlaneDeps,
): Promise<ControlPlaneHandle> {
  let compromised = false;
  const lock = new SingletonLock(config.state_root, {
    onCompromised: () => {
      compromised = true;
      deps.logger.error({ kind: 'lock' }, 'control-plane lock compromised; halting tick loop');
    },
  });
  await lock.acquire();

  const store = new TaskStore({ stateRoot: config.state_root, ownerGen: deps.ownerGen, now: deps.now });
  const slots = new SlotCounter(config.agent.max_concurrent_agents);
  const pm = new ProcessManager({
    stateRoot: config.state_root,
    model: config.agent.model,
    readTokenEnv: config.linear.read_token_env,
    extraEnv: config.agent.extra_env,
    ownerGen: deps.ownerGen,
  });

  const linearRead =
    deps.linearRead ?? createLinearReadGateway(createLinearReadClient(config.linear.read_token_env));

  const dispatcher: Dispatcher = {
    async dispatch(args) {
      await dispatchForKind(pm, store, config, linearRead, args);
    },
  };

  const probeExit = async (task: TaskRecord): Promise<{ ok: boolean } | null> => {
    const run = task.currentRun;
    if (!run) return { ok: true };
    const res = await pm.detectCompletion({
      stateDir: taskDir(config.state_root, task.ticket),
      runId: run.runId, kind: run.kind, logRel: run.log,
      pid: run.pid, pidStart: run.pidStart, spawnedAt: run.spawnedAt,
      graceSeconds: 30,
      now: (deps.now ?? (() => Math.floor(Date.now() / 1000)))(),
    });
    if (res.status === 'running' || res.status === 'unknown') return null;
    if (res.status === 'completed') return { ok: res.exitCode === 0 };
    if (res.status === 'completed-no-exitcode') return { ok: true };
    return { ok: false };
  };

  const engine = new Engine({
    store, slots, dispatcher, reviewHasGaps,
    stateRoot: config.state_root, ownerGen: deps.ownerGen, now: deps.now,
    logWarn: (msg, meta) => deps.logger.warn({ kind: 'engine', ...meta }, msg),
    probeExit,
  });

  await engine.boot();

  const intervalMs = deps.tickIntervalMs ?? 2000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = async (): Promise<void> => {
    if (stopped || compromised) return;
    try {
      await engine.tick();
    } catch (err) {
      deps.logger.warn({ kind: 'tick', error: (err as Error).message }, 'control-plane tick failed');
    }
    if (!stopped && !compromised) timer = setTimeout(() => void loop(), intervalMs);
  };
  timer = setTimeout(() => void loop(), intervalMs);

  return {
    engine,
    store,
    linearRead,
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await lock.release();
    },
  };
}
