// SPEC.md §16.1 — Service startup; CLI argument parsing.
// PARITY.md rows: §16.1, §17.7.
//
// `runCli(argv)` is exported separately from the bin/* entry so unit tests
// can drive it deterministically. The bin entry just calls runCli(process.argv).

import fs from 'node:fs';

import { LinearClient } from '@linear/sdk';

import { parseWorkflowConfig } from '../config/schema.js';
import { resolveConfig } from '../config/resolve.js';
import { preflightConfig } from '../config/preflight.js';
import { loadWorkflow } from '../workflow/loader.js';
import { createLinearGateway } from '../linear/client.js';
import { createLinearWriteGateway } from '../linear/writes.js';
import { WorkspaceManager } from '../workspace/manager.js';
import { AgentRunner, createSdkQueryFactory, type QueryFactory } from '../agent/runner.js';
import { Orchestrator } from '../orchestrator/orchestrator.js';
import { loadStateFromDisk, saveStateToDisk } from '../orchestrator/persistence.js';
import { createLogger, writeOrchestratorEvent } from '../observability/log.js';
import { startStatusServer, type StatusServer } from '../observability/http-server.js';

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ParsedArgs {
  workflowPath: string;
  logsRoot: string;
  /** Reserved; honoured in Phase 3 when the status surface lands. */
  port: number | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let workflowPath: string | null = null;
  let logsRoot = './log';
  let port: number | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--logs-root') {
      const next = argv[i + 1];
      if (!next) throw new CliError('--logs-root requires a value');
      logsRoot = next;
      i += 1;
    } else if (arg.startsWith('--logs-root=')) {
      logsRoot = arg.slice('--logs-root='.length);
    } else if (arg === '--port') {
      const next = argv[i + 1];
      if (!next) throw new CliError('--port requires a value');
      port = Number.parseInt(next, 10);
      if (!Number.isFinite(port)) throw new CliError(`--port must be an integer (got: ${next})`);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10);
      if (!Number.isFinite(port)) throw new CliError('--port must be an integer');
    } else if (arg === '--help' || arg === '-h') {
      throw new CliError(USAGE, 0);
    } else if (arg.startsWith('--')) {
      throw new CliError(`unknown flag: ${arg}\n\n${USAGE}`);
    } else {
      if (workflowPath !== null) {
        throw new CliError(`unexpected extra positional arg: ${arg}\n\n${USAGE}`);
      }
      workflowPath = arg;
    }
  }

  if (workflowPath === null) {
    throw new CliError(`missing required WORKFLOW.md path\n\n${USAGE}`);
  }
  return { workflowPath, logsRoot, port };
}

export const USAGE = `Usage: claude-symphony <WORKFLOW.md> [--logs-root DIR] [--port N]

Arguments:
  WORKFLOW.md        Path to the workflow file (YAML front matter + Markdown body)

Options:
  --logs-root DIR    Directory for structured log output (default: ./log)
  --port N           Reserved for the Phase 3 status surface; ignored in MVP
  -h, --help         Print this help`;

export interface RunCliDeps {
  /** Override the SDK query factory (tests). */
  queryFactory?: QueryFactory;
  /** Override the LinearClient constructor (tests). */
  linearClientFactory?: (apiKey: string) => InstanceType<typeof LinearClient>;
}

/**
 * Boot the orchestrator from CLI arguments, returning a handle the bin
 * entry can use for graceful shutdown. Resolves once the first poll tick
 * has completed (the orchestrator is by then driving its own timer).
 */
export async function runCli(argv: string[], deps: RunCliDeps = {}): Promise<{
  stop: () => Promise<void>;
}> {
  const args = parseArgs(argv);

  const definition = await loadWorkflow(args.workflowPath);
  const validated = parseWorkflowConfig(definition.config);
  const resolved = resolveConfig(validated, process.env);
  const preflight = preflightConfig(resolved, definition.config);

  const logger = createLogger({ logsRoot: args.logsRoot });
  for (const warning of preflight.warnings) {
    logger.warn({ kind: 'preflight' }, warning);
  }
  logger.info(
    {
      workflowPath: definition.sourcePath,
      logsRoot: args.logsRoot,
      project: resolved.tracker.project_slug,
      activeStates: resolved.tracker.active_states,
      maxConcurrent: resolved.agent.max_concurrent_agents,
      pollIntervalMs: resolved.polling.interval_ms,
    },
    'claude-symphony starting',
  );

  const linearClient = deps.linearClientFactory
    ? deps.linearClientFactory(resolved.tracker.api_key)
    : new LinearClient({ apiKey: resolved.tracker.api_key });
  // resolveBlockers populates Issue.blockedBy on every fetch so the
  // orchestrator can gate Todo issues with non-terminal blockers (B6).
  // Each issue costs one extra Linear roundtrip to resolve; acceptable for
  // single-host MVP, would be a knob in Phase 3.
  const linearGateway = createLinearGateway(linearClient, { resolveBlockers: true });
  // Same LinearClient also drives the in-process symphony_linear MCP server
  // (B7): the API key needs Read + Write scope. Configured in Linear under
  // Settings → Security & access → Personal API keys.
  const linearWriteGateway = createLinearWriteGateway(linearClient);

  const workspaceManager = new WorkspaceManager({
    root: resolved.workspace.root,
    afterCreateHook: resolved.hooks.after_create,
    beforeRemoveHook: resolved.hooks.before_remove,
    hookTimeoutMs: resolved.hooks.timeout_ms,
  });

  const queryFactory = deps.queryFactory ?? (await createSdkQueryFactory());
  const agentRunner = new AgentRunner(queryFactory);

  // Linear connectivity probe (Phase 3 P9). Catches the most common boot
  // failures before the daemon claims to be running: bad API key, bad
  // project slug, network. Write-scope verification is deferred to first
  // symphony_linear call — Linear has no scope-introspection endpoint.
  try {
    await linearGateway.fetchActiveCandidates(
      resolved.tracker.project_slug,
      resolved.tracker.active_states,
    );
    logger.info({ kind: 'preflight' }, 'Linear read access OK');
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ kind: 'preflight', error: message }, 'Linear access probe failed');
    throw new CliError(
      `Linear connectivity check failed at boot: ${message}. ` +
        `Check LINEAR_API_KEY validity and that tracker.project_slug "${resolved.tracker.project_slug}" exists.`,
    );
  }

  // State persistence (Phase 3 P5). Save snapshots to <logsRoot> so a daemon
  // restart preserves sessionId, attempt counters, retry windows. Saves are
  // best-effort fire-and-forget; a failed write is logged but does NOT
  // block orchestrator progress.
  const orchestrator = new Orchestrator({
    linear: linearGateway,
    linearWrites: linearWriteGateway,
    workspace: workspaceManager,
    agent: agentRunner,
    promptTemplate: definition.promptTemplate,
    config: resolved,
    onEvent: (event) => writeOrchestratorEvent(logger, event),
    onStateChanged: (snapshot) => {
      void saveStateToDisk(args.logsRoot, snapshot).catch((err: Error) => {
        logger.warn({ kind: 'persistence', error: err.message }, 'state save failed');
      });
    },
  });

  const loaded = await loadStateFromDisk(args.logsRoot);
  if (loaded.snapshot !== null) {
    orchestrator.hydrate(loaded.snapshot);
    logger.info({ kind: 'persistence' }, loaded.note);
  } else {
    logger.debug({ kind: 'persistence' }, loaded.note);
  }

  await orchestrator.start();

  // Phase 3 P3: status surface. Starts only when --port was set.
  let statusServer: StatusServer | null = null;
  if (args.port !== null) {
    try {
      statusServer = await startStatusServer({ port: args.port, orchestrator });
      logger.info(
        { kind: 'status_surface', port: statusServer.port },
        `status dashboard at http://127.0.0.1:${statusServer.port}/`,
      );
    } catch (err) {
      logger.warn(
        { kind: 'status_surface', error: (err as Error).message },
        'failed to start status server; orchestrator continues without it',
      );
    }
  }

  // Phase 3 P4: hot reload of WORKFLOW.md. Watch the file; on change,
  // re-load + validate + resolve + preflight + swap config behind the
  // orchestrator. A reload that fails any stage is logged and the daemon
  // keeps running with the previous good config.
  let reloadInProgress = false;
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(definition.sourcePath, () => {
    if (reloadDebounce !== null) clearTimeout(reloadDebounce);
    // Editors typically save through a write+rename dance that fires
    // multiple events in quick succession; debounce so we reload once.
    reloadDebounce = setTimeout(async () => {
      reloadDebounce = null;
      if (reloadInProgress) return;
      reloadInProgress = true;
      try {
        const reloaded = await loadWorkflow(definition.sourcePath);
        const validatedReload = parseWorkflowConfig(reloaded.config);
        const resolvedReload = resolveConfig(validatedReload, process.env);
        preflightConfig(resolvedReload, reloaded.config);
        orchestrator.setConfig(resolvedReload, reloaded.promptTemplate);
      } catch (err) {
        logger.warn(
          { kind: 'reload', error: (err as Error).message },
          'WORKFLOW.md reload failed; keeping previous config',
        );
      } finally {
        reloadInProgress = false;
      }
    }, 200);
  });
  watcher.on('error', (err: Error) => {
    logger.warn({ kind: 'reload', error: err.message }, 'WORKFLOW.md watcher error');
  });

  return {
    stop: async () => {
      logger.info('claude-symphony stopping');
      if (reloadDebounce !== null) {
        clearTimeout(reloadDebounce);
        reloadDebounce = null;
      }
      watcher.close();
      if (statusServer !== null) {
        try {
          await statusServer.close();
        } catch (err) {
          logger.warn({ kind: 'status_surface', error: (err as Error).message }, 'status server close failed');
        }
      }
      await orchestrator.stop();
      logger.info('claude-symphony stopped');
    },
  };
}
