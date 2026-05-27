// src/control-plane/web/auth.ts
// Spec §9: one global bearer-auth middleware before all routes. Constant-time
// compare (sha256 + timingSafeEqual — equal-length, no early-out, no length leak),
// failed-auth rate limit, HttpOnly cookie set at /login, token never logged, no
// task content in error bodies.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { Hono, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export const COOKIE_NAME = 'symphony_token';

/** Constant-time string equality via fixed-length digests. */
function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

interface Bucket { count: number; resetAt: number; }
const MAX_FAILS = 10;
const WINDOW_MS = 60_000;

/** In-memory failed-auth limiter keyed by client (best-effort, single-tenant box). */
class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  blocked(key: string, now: number): boolean {
    const b = this.buckets.get(key);
    return b !== undefined && b.count >= MAX_FAILS && now < b.resetAt;
  }
  fail(key: string, now: number): void {
    const b = this.buckets.get(key);
    if (!b || now >= b.resetAt) this.buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    else b.count += 1;
  }
  reset(key: string): void { this.buckets.delete(key); }
}

function clientKey(c: { req: { header: (n: string) => string | undefined } }): string {
  return c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'local';
}

/** Build the global auth middleware. `token` is the resolved secret (never logged). */
export function createAuthMiddleware(token: string): MiddlewareHandler {
  const limiter = new RateLimiter();
  return async (c, next) => {
    const now = Date.now();
    const key = clientKey(c);
    if (limiter.blocked(key, now)) return c.text('rate limited', 429);

    const header = c.req.header('Authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const cookie = getCookie(c, COOKIE_NAME);
    const presented = bearer ?? cookie;

    if (presented !== undefined && safeEqual(presented, token)) {
      limiter.reset(key);
      await next();
      return;
    }
    limiter.fail(key, now);
    return c.text('unauthorized', 401); // no task content (spec §9)
  };
}

const LOGIN_FORM = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<form method=post action=/login style="font-family:system-ui;max-width:20rem;margin:4rem auto">
<h1>symphony</h1><input name=token type=password placeholder="board token" autofocus
 style="width:100%;padding:.6rem;font-size:1rem"><button style="margin-top:.5rem;padding:.6rem 1rem">enter</button></form>`;

/** Mount the (un-gated) login routes BEFORE the auth middleware. */
export function mountLogin(app: Hono, token: string): void {
  app.get('/login', (c) => c.html(LOGIN_FORM));
  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const presented = typeof body.token === 'string' ? body.token : '';
    if (!safeEqual(presented, token)) return c.html(`${LOGIN_FORM}<p style="color:#b00;text-align:center">bad token</p>`, 401);
    setCookie(c, COOKIE_NAME, token, { httpOnly: true, sameSite: 'Lax', path: '/', secure: false });
    return c.redirect('/', 302);
  });
}
