// src/control-plane/web/server.ts
// Assemble the Hono app: login (un-gated) → global auth → routes. startWebServer
// binds via @hono/node-server on config.web.{bind_host,port} (never a wildcard —
// enforced by the config schema). Co-hosted with the daemon in bin/control-plane.ts.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

import type { ControlPlaneConfig } from '../config.js';
import type { LinearReadGateway } from '../linear-read.js';
import type { TaskStore } from '../task-store.js';
import { nullDiscussLease, type DiscussLease } from '../discuss-lease.js';
import { createAuthMiddleware, mountLogin } from './auth.js';
import { mountRoutes, type RoutesDeps } from './routes.js';

export interface AppDeps extends RoutesDeps { token: string; }

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  mountLogin(app, deps.token); // BEFORE the gate
  app.use('*', createAuthMiddleware(deps.token));
  mountRoutes(app, deps);
  return app;
}

export interface WebServer { close: () => Promise<void>; }

export function startWebServer(
  config: ControlPlaneConfig,
  deps: {
    store: TaskStore; linearRead: LinearReadGateway; token: string;
    discussLease?: DiscussLease; cfg?: ControlPlaneConfig['web'];
  },
): WebServer {
  const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'static');
  const app = createApp({
    store: deps.store,
    linearRead: deps.linearRead,
    stateRoot: config.state_root,
    token: deps.token,
    staticRoot,
    discussLease: deps.discussLease ?? nullDiscussLease,
  });
  // WS upgrade lane: when discuss_terminal is enabled, @hono/node-server's adapter
  // needs a `ws.WebSocketServer({ noServer: true })` so server.on('upgrade') routes
  // into our `upgradeWebSocket` route (mounted via discussLease.mountRoutes).
  const wss = config.web.discuss_terminal.enabled
    ? new WebSocketServer({ noServer: true })
    : undefined;
  const server = serve({
    fetch: app.fetch,
    hostname: config.web.bind_host,
    port: config.web.port,
    ...(wss ? { websocket: { server: wss } } : {}),
  });
  return { close: () => new Promise<void>((res) => server.close(() => res())) };
}
