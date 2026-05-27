import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createAuthMiddleware, mountLogin, COOKIE_NAME } from '../../../src/control-plane/web/auth.js';

function appWithAuth(token: string) {
  const app = new Hono();
  mountLogin(app, token);
  app.use('*', createAuthMiddleware(token));
  app.get('/x', (c) => c.text('secret'));
  return app;
}

describe('auth middleware', () => {
  it('rejects requests with no token (401, no task content)', async () => {
    const res = await appWithAuth('s3cret').request('/x');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('secret');
  });

  it('accepts the bearer token via Authorization header', async () => {
    const res = await appWithAuth('s3cret').request('/x', { headers: { Authorization: 'Bearer s3cret' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('secret');
  });

  it('login sets an HttpOnly cookie that subsequently authenticates', async () => {
    const app = appWithAuth('s3cret');
    const login = await app.request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=s3cret',
    });
    expect(login.status).toBe(302);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`${COOKIE_NAME}=`));
    expect(setCookie.toLowerCase()).toContain('httponly');
    const res = await app.request('/x', { headers: { cookie: `${COOKIE_NAME}=s3cret` } });
    expect(res.status).toBe(200);
  });

  it('rate-limits after repeated bad tokens (429)', async () => {
    const app = appWithAuth('s3cret');
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const r = await app.request('/x', { headers: { Authorization: 'Bearer wrong', 'x-forwarded-for': '10.0.0.9' } });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  it('login itself is not auth-gated (mounted before the middleware)', async () => {
    const res = await appWithAuth('s3cret').request('/login', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});
