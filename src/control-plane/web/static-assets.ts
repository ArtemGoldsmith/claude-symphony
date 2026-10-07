// src/control-plane/web/static-assets.ts
// Auth-required, path-safe static asset serving. Registered after the global
// auth middleware in createApp, so every request carries the cookie.

import type { Hono } from 'hono';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { joinWithinRoot } from '../../util/path-safety.js';

const MIME: Record<string, string> = {
  '.js':  'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

export function mountStaticAssets(app: Hono, staticRoot: string): void {
  app.get('/static/*', async (c) => {
    const url = new URL(c.req.url);
    const sub = url.pathname.replace(/^\/static\//, '');
    if (!sub) return c.text('not found', 404);
    let abs: string;
    try { abs = joinWithinRoot(staticRoot, sub); }
    catch { return c.text('bad path', 400); }
    try {
      const st = await stat(abs);
      if (!st.isFile()) return c.text('not a file', 404);
    } catch { return c.text('not found', 404); }
    const mime = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const body = await readFile(abs);
    return new Response(body, { status: 200, headers: { 'content-type': mime } });
  });
}
