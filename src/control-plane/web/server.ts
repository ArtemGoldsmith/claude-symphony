// src/control-plane/web/server.ts
// Assemble the Hono app: login (un-gated) → global auth → routes. startWebServer
// binds via @hono/node-server on config.web.{bind_host,port} (never a wildcard —
// enforced by the config schema). Co-hosted with the daemon in bin/control-plane.ts.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import type { ControlPlaneConfig } from '../config.js';
import type { LinearReadGateway } from '../linear-read.js';
import type { TaskStore } from '../task-store.js';
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
  deps: { store: TaskStore; linearRead: LinearReadGateway; token: string },
): WebServer {
  const app = createApp({
    store: deps.store,
    linearRead: deps.linearRead,
    stateRoot: config.state_root,
    token: deps.token,
  });
  const server = serve({ fetch: app.fetch, hostname: config.web.bind_host, port: config.web.port });
  return { close: () => new Promise<void>((res) => server.close(() => res())) };
}
