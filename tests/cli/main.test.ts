import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError, parseArgs, runCli } from '../../src/cli/main.js';
import type { LinearGateway } from '../../src/linear/gateway.js';

describe('parseArgs', () => {
  it('accepts a positional WORKFLOW.md path', () => {
    const args = parseArgs(['WORKFLOW.md']);
    expect(args.workflowPath).toBe('WORKFLOW.md');
    expect(args.logsRoot).toBe('./log');
    expect(args.port).toBeNull();
  });

  it('accepts --logs-root in two-arg and equals form', () => {
    expect(parseArgs(['x.md', '--logs-root', '/var/log/symphony']).logsRoot).toBe(
      '/var/log/symphony',
    );
    expect(parseArgs(['--logs-root=/var/log/symphony', 'x.md']).logsRoot).toBe(
      '/var/log/symphony',
    );
  });

  it('accepts --port in both forms', () => {
    expect(parseArgs(['x.md', '--port', '4000']).port).toBe(4000);
    expect(parseArgs(['x.md', '--port=4000']).port).toBe(4000);
  });

  it('rejects --port with a non-integer value', () => {
    expect(() => parseArgs(['x.md', '--port', 'not-a-number'])).toThrow(CliError);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['x.md', '--invalid'])).toThrow(/unknown flag/);
  });

  it('rejects an extra positional arg', () => {
    expect(() => parseArgs(['x.md', 'y.md'])).toThrow(/extra positional/);
  });

  it('rejects when the WORKFLOW.md path is missing', () => {
    expect(() => parseArgs([])).toThrow(/required WORKFLOW.md/);
  });

  it('exits with code 0 when --help is passed', () => {
    try {
      parseArgs(['--help']);
      throw new Error('expected CliError');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(0);
    }
  });
});

describe('runCli — end-to-end with stub agent and linear', () => {
  let tempRoot: string;
  let workflowPath: string;
  let workspaceRoot: string;
  let logsRoot: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-'));
    workspaceRoot = path.join(tempRoot, 'workspaces');
    fs.mkdirSync(workspaceRoot);
    logsRoot = path.join(tempRoot, 'log');
    workflowPath = path.join(tempRoot, 'WORKFLOW.md');

    fs.writeFileSync(
      workflowPath,
      `---
tracker:
  kind: linear
  project_slug: chronicle
  active_states:
    - Todo
workspace:
  root: ${workspaceRoot}
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 1
claude:
  mcp_servers:
    linear:
      url: https://mcp.linear.app/mcp
---

prompt body for {{ issue.identifier }}
`,
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('boots the orchestrator, runs one tick, writes a log file, and stops cleanly', async () => {
    const fakeQuery = vi.fn(async function* () {
      yield {
        type: 'result' as const,
        subtype: 'success' as const,
        result: 'done',
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0,
        num_turns: 1,
      };
    });

    // Linear gateway substitute via fake LinearClient. The CLI converts a
    // LinearClient into a gateway internally; we shortcut by providing a
    // minimal client with the .issues() shape our gateway expects.
    const linearClientFactory = vi.fn(() => {
      const issues = vi.fn(async () => ({
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      }));
      return { issues } as unknown as InstanceType<
        typeof import('@linear/sdk').LinearClient
      >;
    });

    const prevApiKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test';

    try {
      const handle = await runCli([workflowPath, '--logs-root', logsRoot], {
        queryFactory: fakeQuery as never,
        linearClientFactory,
      });
      await handle.stop();
    } finally {
      if (prevApiKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevApiKey;
    }

    expect(linearClientFactory).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(logsRoot, 'symphony.log'))).toBe(true);
  });

  it('surfaces preflight failures as thrown errors before starting the orchestrator', async () => {
    fs.writeFileSync(
      workflowPath,
      `---
tracker:
  kind: linear
  project_slug: chronicle
workspace:
  root: ${workspaceRoot}
claude:
  mcp_servers: {}
---
body
`,
      'utf8',
    );

    const prevApiKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test';
    try {
      await expect(
        runCli([workflowPath, '--logs-root', logsRoot], {
          queryFactory: (async function* () {
            // never reached
            yield { type: 'result', subtype: 'success' };
          }) as never,
          linearClientFactory: () => ({} as unknown as InstanceType<typeof import('@linear/sdk').LinearClient>),
        }),
      ).rejects.toThrow(/Linear MCP/i);
    } finally {
      if (prevApiKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevApiKey;
    }
  });
});

// Silence unused-import warning while keeping the interface visible to readers.
export type { LinearGateway };
