#!/usr/bin/env node
// SPEC.md §16.1 — Service startup binary entry.
// PARITY.md row: §16.1, §17.7.

import { CliError, runCli } from '../src/cli/main.js';

async function main(): Promise<void> {
  let handle: { stop: () => Promise<void> };
  try {
    handle = await runCli(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      const stream = err.exitCode === 0 ? process.stdout : process.stderr;
      stream.write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    process.stderr.write(`fatal: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\nreceived ${signal}, draining...\n`);
    try {
      await handle.stop();
      process.exit(0);
    } catch (err) {
      process.stderr.write(`shutdown failed: ${(err as Error).message}\n`);
      process.exit(2);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
