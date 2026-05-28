// src/control-plane/task-record.ts
// Spec §5 task.json shape + atomic file I/O (mirrors persistence.ts:67-78).

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { assertSafeIssueIdentifier, joinWithinRoot } from '../util/path-safety.js';
import { ALL_PHASES } from './phase.js';

// Derived from the single ALL_PHASES const so the schema can't drift from the union.
const PhaseSchema = z.enum(ALL_PHASES);

const RunRecordSchema = z.object({
  runId: z.string(),
  attemptId: z.number().int().nonnegative(),
  kind: z.enum(['prep', 'execute', 'review', 'gapfix', 'closeout', 'preview', 'teardown']),
  pid: z.number().int().nullable(),
  pidStart: z.string().nullable(), // kernel start-time token (spec §6); null until recorded
  spawnedAt: z.number().int(),
  sessionId: z.string().nullable(),
  log: z.string(),
  ownerGen: z.string(),
});

export type RunRecord = z.infer<typeof RunRecordSchema>;

export const OpenQuestionItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: z.enum(['choice', 'free', 'bool']),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

const OpenQuestionsSchema = z.object({
  rev: z.number().int().nonnegative(),
  items: z.array(OpenQuestionItemSchema),
});

const AnswersSchema = z.object({
  questionsRev: z.number().int().nonnegative(),
  planAckRev: z.number().int().nonnegative().nullable(),
  values: z.record(z.string(), z.string()),
});

export const Stage9Schema = z.object({
  attemptId: z.number().int().nonnegative(),
  gitSha: z.string(),
  items: z.array(
    z.object({
      n: z.number().int().positive(),
      tag: z.enum(['DEFERRED', 'PRODUCT', 'NO-DATA', 'MISSED', 'CUT', 'DIVERGENT', 'OTHER']),
      text: z.string(),
      acked: z.boolean(),
    }),
  ),
});

export const TaskRecordSchema = z.object({
  ticket: z.string().min(1),
  rev: z.number().int().nonnegative(),
  phase: PhaseSchema,
  ownerGen: z.string(),
  title: z.string(),
  url: z.string(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  baseSha: z.string().nullable(),
  currentRun: RunRecordSchema.nullable(),
  openQuestions: OpenQuestionsSchema.nullable(),
  answers: AnswersSchema.nullable(),
  rejectFeedback: z.string().nullable(),
  // Free-text operator context attached at task creation — flows into the prep
  // agent's ctx as {{OPERATOR_NOTE}}. Nullable + default-null so old task.json
  // files (written before this field existed) still parse cleanly.
  operatorNote: z.string().nullable().default(null),
  preview: z
    .object({ url: z.string(), gitSha: z.string(), state: z.string() })
    .nullable(),
  stage9: Stage9Schema.nullable(),
  teardownTarget: z.enum(['done', 'abandoned', 'queued']).nullable(),
  failedFrom: PhaseSchema.nullable(),
  terminalReason: z.enum(['approved', 'abandoned']).nullable(),
  retryRequested: z.boolean(),
  attempts: z.object({ prep: z.number().int().nonnegative(), execute: z.number().int().nonnegative() }),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export type TaskRecord = z.infer<typeof TaskRecordSchema>;
// NOTE: `Phase` is exported only from phase.ts (single source). Do not re-export
// it here — a second `export type Phase` makes the index.ts `export *` ambiguous.

export const TASK_FILENAME = 'task.json';

export function taskDir(stateRoot: string, ticket: string): string {
  assertSafeIssueIdentifier(ticket);
  return joinWithinRoot(stateRoot, ticket);
}

export function newTaskRecord(args: {
  ticket: string;
  title: string;
  url: string;
  ownerGen: string;
  now: number;
  /** Free-text operator note attached at task creation. */
  operatorNote?: string | null;
}): TaskRecord {
  return {
    ticket: args.ticket,
    rev: 0,
    phase: 'queued',
    ownerGen: args.ownerGen,
    title: args.title,
    url: args.url,
    branch: null,
    worktree: null,
    baseSha: null,
    currentRun: null,
    openQuestions: null,
    answers: null,
    rejectFeedback: null,
    operatorNote: args.operatorNote ?? null,
    preview: null,
    stage9: null,
    teardownTarget: null,
    failedFrom: null,
    terminalReason: null,
    retryRequested: false,
    attempts: { prep: 0, execute: 0 },
    createdAt: args.now,
    updatedAt: args.now,
  };
}

export async function readTaskRecord(
  stateRoot: string,
  ticket: string,
): Promise<TaskRecord | null> {
  const file = path.join(taskDir(stateRoot, ticket), TASK_FILENAME);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return TaskRecordSchema.parse(JSON.parse(raw));
  } catch {
    return null; // malformed or schema mismatch → treat as absent (spec §12 atomic-files)
  }
}

/** Atomic write: tmp + rename (mirrors persistence.ts:67-78). */
export async function writeTaskRecord(stateRoot: string, record: TaskRecord): Promise<void> {
  const dir = taskDir(stateRoot, record.ticket);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, TASK_FILENAME);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
