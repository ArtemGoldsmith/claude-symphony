import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OrchestratorEvent } from '../../src/orchestrator/orchestrator.js';
import { createLogger, writeOrchestratorEvent } from '../../src/observability/log.js';

describe('createLogger', () => {
  let logsRoot: string;

  beforeEach(() => {
    logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  });

  afterEach(() => {
    fs.rmSync(logsRoot, { recursive: true, force: true });
  });

  it('creates the logs directory and writes JSONL records to symphony.log', async () => {
    const logger = createLogger({ logsRoot, prettyStdout: false });
    logger.info({ foo: 'bar' }, 'hello');
    logger.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const contents = fs.readFileSync(path.join(logsRoot, 'symphony.log'), 'utf8').trim();
    const line = contents.split('\n').pop()!;
    const parsed = JSON.parse(line);
    expect(parsed.foo).toBe('bar');
    expect(parsed.msg).toBe('hello');
    expect(parsed.service).toBe('claude-symphony');
  });

  it('honours a custom filename', async () => {
    const logger = createLogger({ logsRoot, filename: 'symphony.test.log', prettyStdout: false });
    logger.info('first');
    logger.flush();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(fs.existsSync(path.join(logsRoot, 'symphony.test.log'))).toBe(true);
  });
});

describe('writeOrchestratorEvent', () => {
  function captureLogs(events: OrchestratorEvent[]): unknown[] {
    const captured: unknown[] = [];
    const fakeLogger = {
      debug: (record: unknown) => captured.push({ level: 'debug', record }),
      info: (record: unknown) => captured.push({ level: 'info', record }),
      warn: (record: unknown) => captured.push({ level: 'warn', record }),
      error: (record: unknown) => captured.push({ level: 'error', record }),
    } as unknown as Parameters<typeof writeOrchestratorEvent>[0];

    for (const event of events) writeOrchestratorEvent(fakeLogger, event);
    return captured;
  }

  it('logs dispatch_completed at info with usage and exit reason', () => {
    const captured = captureLogs([
      {
        type: 'dispatch_completed',
        at: 1,
        issueId: 'i1',
        issueIdentifier: 'CHR-1',
        result: {
          exitReason: 'completed',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalCostUsd: 0.01,
          },
          durationMs: 1234,
          finalText: '',
          numTurns: 1,
          errorMessage: null,
        },
      },
    ]);
    expect(captured).toHaveLength(1);
    const entry = captured[0] as { level: string; record: { exitReason: string } };
    expect(entry.level).toBe('info');
    expect(entry.record.exitReason).toBe('completed');
  });

  it('logs dispatch_failed at warn with the error message', () => {
    const captured = captureLogs([
      { type: 'dispatch_failed', at: 1, issueId: 'i1', issueIdentifier: 'CHR-1', error: 'boom' },
    ]);
    const entry = captured[0] as { level: string; record: { error: string } };
    expect(entry.level).toBe('warn');
    expect(entry.record.error).toBe('boom');
  });

  it('logs retry_scheduled at warn with retryAt', () => {
    const captured = captureLogs([
      { type: 'retry_scheduled', at: 1, issueId: 'i1', issueIdentifier: 'CHR-1', retryAt: 9999 },
    ]);
    const entry = captured[0] as { level: string; record: { retryAt: number } };
    expect(entry.level).toBe('warn');
    expect(entry.record.retryAt).toBe(9999);
  });

  it('logs tick_* and retry_skipped at debug', () => {
    const captured = captureLogs([
      { type: 'tick_started', at: 1 },
      { type: 'tick_completed', at: 2 },
      { type: 'retry_skipped', at: 3, issueId: 'i1', issueIdentifier: 'CHR-1' },
    ]);
    expect(captured.every((c) => (c as { level: string }).level === 'debug')).toBe(true);
  });
});
