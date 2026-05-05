// SPEC.md §13.1 + §13.2 + §15.3 — structured logging.
// PARITY.md rows: §3.1.8, §13.1, §13.2, §15.3.
//
// Single pino logger with two sinks:
//   1. JSONL file at `<logsRoot>/symphony.log` for machine consumption.
//   2. Pretty stdout for operator console.
//
// Token-bearing fields (api_key, env) are NEVER passed through this logger.
// Callers MUST sanitize before logging — see writeOrchestratorEvent below.

import fs from 'node:fs';
import path from 'node:path';

import pino, { type Logger } from 'pino';

import type { OrchestratorEvent } from '../orchestrator/orchestrator.js';

/** Per-event cap on stderr text written to the JSONL log (Phase 3 P8). */
const STDERR_MAX_BYTES = 8 * 1024;

/**
 * Truncate `s` to roughly `max` bytes by keeping the head and the tail and
 * dropping the middle, with an inline marker so log readers know how much
 * was lost. Pure function; exported for tests.
 */
export function truncateMiddle(s: string, max: number): string {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  const headEnd = Math.max(0, Math.floor(max / 2) - 60);
  const tailStart = Math.max(headEnd, s.length - (max - headEnd - 80));
  const head = s.slice(0, headEnd);
  const tail = s.slice(tailStart);
  const droppedBytes =
    Buffer.byteLength(s, 'utf8') -
    Buffer.byteLength(head, 'utf8') -
    Buffer.byteLength(tail, 'utf8');
  return `${head}\n... [truncated ${droppedBytes} bytes] ...\n${tail}`;
}

export interface CreateLoggerOptions {
  logsRoot: string;
  /** Filename within logsRoot. Default: `symphony.log`. */
  filename?: string;
  /** Override for pretty output detection. */
  prettyStdout?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const filename = options.filename ?? 'symphony.log';
  const prettyStdout = options.prettyStdout ?? process.stdout.isTTY === true;

  fs.mkdirSync(options.logsRoot, { recursive: true });
  const logFile = path.join(options.logsRoot, filename);

  // pino.destination with sync:true gives us deterministic file ordering and
  // makes stop() observable: by the time the caller awaits stop(), the file
  // contents are already on disk. Worth the throughput cost for an
  // orchestrator log, which is low-volume.
  const fileDestination = pino.destination({ dest: logFile, sync: true, append: true });

  const streams: pino.StreamEntry[] = [
    { stream: fileDestination, level: 'debug' },
  ];

  if (prettyStdout) {
    streams.push({
      stream: pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
      }),
      level: 'info',
    });
  } else {
    streams.push({ stream: process.stdout, level: 'info' });
  }

  return pino(
    { level: 'debug', base: { service: 'claude-symphony' } },
    pino.multistream(streams),
  );
}

/**
 * Map an OrchestratorEvent to a structured log record. Keeps the event sink
 * loosely coupled from pino's API and makes the projection independently
 * testable.
 */
export function writeOrchestratorEvent(logger: Logger, event: OrchestratorEvent): void {
  const base = {
    event: event.type,
    at: event.at,
    issueId: event.issueId,
    issueIdentifier: event.issueIdentifier,
  };

  switch (event.type) {
    case 'tick_started':
    case 'tick_completed':
      logger.debug({ ...base, error: event.error }, event.type);
      break;

    case 'dispatch_started':
      logger.info(base, `dispatching ${event.issueIdentifier}`);
      break;

    case 'dispatch_completed':
      logger.info(
        {
          ...base,
          exitReason: event.result?.exitReason,
          durationMs: event.result?.durationMs,
          numTurns: event.result?.numTurns,
          usage: event.result?.usage,
        },
        `completed ${event.issueIdentifier}`,
      );
      break;

    case 'dispatch_failed':
      logger.warn({ ...base, error: event.error }, `failed ${event.issueIdentifier}`);
      break;

    case 'startup_recovery':
      logger.info(
        { ...base, recoveredIssueIdentifiers: event.recoveredIssueIdentifiers ?? [] },
        `startup recovery: found ${event.recoveredIssueIdentifiers?.length ?? 0} existing per-issue worktrees`,
      );
      break;

    case 'workspace_cleaned':
      if (event.error) {
        logger.warn(
          { ...base, linearStateAfterRun: event.linearStateAfterRun, error: event.error },
          `workspace cleanup failed for ${event.issueIdentifier}`,
        );
      } else {
        logger.info(
          { ...base, linearStateAfterRun: event.linearStateAfterRun },
          `workspace removed for ${event.issueIdentifier} (Linear: ${event.linearStateAfterRun})`,
        );
      }
      break;

    case 'reconcile_aborted':
      logger.warn(
        { ...base, linearStateAfterRun: event.linearStateAfterRun },
        `aborting in-flight ${event.issueIdentifier} (Linear state changed mid-run)`,
      );
      break;

    case 'continuation_scheduled':
      logger.info(
        {
          ...base,
          linearStateAfterRun: event.linearStateAfterRun,
          exitReason: event.result?.exitReason,
          durationMs: event.result?.durationMs,
          numTurns: event.result?.numTurns,
          usage: event.result?.usage,
        },
        `${event.issueIdentifier} still active after agent run; requeuing for continuation`,
      );
      break;

    case 'retry_scheduled':
      logger.warn(
        { ...base, retryAt: event.retryAt },
        `retry queued for ${event.issueIdentifier}`,
      );
      break;

    case 'retry_skipped':
      logger.debug(base, `${event.issueIdentifier} still in cooldown`);
      break;

    case 'agent_stderr':
      logger.warn(
        {
          ...base,
          stderr: truncateMiddle((event.stderrChunk ?? '').trimEnd(), STDERR_MAX_BYTES),
        },
        `agent stderr (${event.issueIdentifier})`,
      );
      break;
  }
}
