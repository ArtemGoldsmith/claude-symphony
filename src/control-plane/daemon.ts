// src/control-plane/daemon.ts
// Spec §10/§16: control-plane daemon wiring. Acquires the singleton lock, builds
// the engine over a ProcessManager-backed dispatcher, and runs a periodic tick.
// No HTTP — the Hono board (Plan 3) co-hosts later. Exposes start/stop.

import fs from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from 'pino';

import type { ControlPlaneConfig } from './config.js';
import { Engine, type Dispatcher, type DispatchArgs } from './engine.js';
import { ProcessManager } from './process-manager.js';
import { SlotCounter } from './slots.js';
import { SingletonLock } from './lock.js';
import { TaskStore } from './task-store.js';
import { taskDir, type TaskRecord } from './task-record.js';
import { renderTemplate, renderExecutePrompt } from './prompts.js';

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

export interface ControlPlaneHandle {
  engine: Engine;
  stop: () => Promise<void>;
}

export interface BootControlPlaneDeps {
  logger: Logger;
  ownerGen: string;
  now?: () => number;
  /** Tick cadence; default 2000ms. */
  tickIntervalMs?: number;
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
  if (!task.worktree) throw new Error(`dispatchForKind: ${args.ticket} has no worktree (intake not run)`);
  const stateDir = taskDir(config.state_root, args.ticket);
  const worktree = task.worktree;
  const settingsPath = path.join(worktree, '.claude', 'settings.json');
  const logRel = pm.logRelForKind(kind);
  const promptPath = config.prompts[kind];

  const ctx: Record<string, string> = {
    TICKET_ID: task.ticket,
    BRANCH: task.branch ?? '',
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
      if (sid) resumeSessionId = sid; // NO-SESSION fallback: fresh fixer (no resume)
    }
    prompt = renderTemplate(template, ctx);
  }

  const argv = pm.buildAgentArgv(resumeSessionId ? { prompt, settingsPath, resumeSessionId } : { prompt, settingsPath });
  await pm.dispatchAgent({
    store, ticket: args.ticket, expectRev: args.expectRev, kind,
    logRel, command: argv, cwd: worktree, env: pm.buildAgentEnv(), to: args.to,
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

  const dispatcher: Dispatcher = {
    async dispatch(args) {
      await dispatchForKind(pm, store, config, args);
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
    stop: async () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await lock.release();
    },
  };
}
