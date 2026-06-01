#!/usr/bin/env node
// Control-plane daemon + web board entry. Usage: control-plane --config <path>.
// Boots the singleton-locked daemon (tick loop) and co-hosts the Hono board on
// the SAME TaskStore instance, in one process.

import { randomUUID } from 'node:crypto';

import { loadControlPlaneConfig } from '../src/control-plane/config-loader.js';
import { bootControlPlane } from '../src/control-plane/daemon.js';
import { nullDiscussLease } from '../src/control-plane/discuss-lease.js';
import { startWebServer } from '../src/control-plane/web/server.js';
import { createLogger } from '../src/observability/log.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const configPath = argValue('--config');
  if (!configPath) { process.stderr.write('usage: control-plane --config <path>\n'); process.exit(2); }

  const config = await loadControlPlaneConfig(configPath);
  const token = process.env[config.web.auth_token_env];
  if (!token) { process.stderr.write(`fatal: ${config.web.auth_token_env} is not set\n`); process.exit(2); }

  const logger = createLogger({ logsRoot: config.state_root, filename: 'control-plane.log', prettyStdout: true });
  const discussLease = nullDiscussLease; // Task 11 will swap real impl when enabled
  const handle = await bootControlPlane(config, { logger, ownerGen: randomUUID(), discussLease });
  const web = startWebServer(config, { store: handle.store, linearRead: handle.linearRead, token, discussLease });
  logger.info({ kind: 'web', bind: `${config.web.bind_host}:${config.web.port}` }, 'control-plane board listening');

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\nreceived ${signal}, draining...\n`);
    try { await web.close(); await handle.stop(); process.exit(0); }
    catch (err) { process.stderr.write(`shutdown failed: ${(err as Error).message}\n`); process.exit(2); }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((err) => { process.stderr.write(`fatal: ${(err as Error).message}\n`); process.exit(2); });
