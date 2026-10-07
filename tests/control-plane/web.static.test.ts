import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/control-plane/web/server.js';
import { COOKIE_NAME } from '../../src/control-plane/web/auth.js';
import { nullDiscussLease } from '../../src/control-plane/discuss-lease.js';

const TOKEN = 'tok';
const cookie = `${COOKIE_NAME}=${TOKEN}`;

// Minimal stubs — only methods the static-asset route actually exercises (none).
// The auth middleware needs nothing from these.
function fakeStore(): any {
  return { async get(_t: string) { return null; } };
}
function fakeLinearRead(): any {
  return {};
}

describe('GET /static/*', () => {
  let staticRoot: string;
  beforeAll(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), 'cp-static-'));
    await mkdir(path.join(staticRoot, 'sub'), { recursive: true });
    await writeFile(path.join(staticRoot, 'hello.js'), '// hi', 'utf8');
    await writeFile(path.join(staticRoot, 'hello.css'), 'body{}', 'utf8');
    await writeFile(path.join(staticRoot, 'sub', 'nested.js'), '// n', 'utf8');
  });
  afterAll(async () => { await rm(staticRoot, { recursive: true, force: true }); });

  function makeApp() {
    return createApp({
      store: fakeStore(),
      linearRead: fakeLinearRead(),
      stateRoot: '/tmp/unused',
      staticRoot,
      discussLease: nullDiscussLease,
      token: TOKEN,
    });
  }

  it('serves .js with application/javascript', async () => {
    const res = await makeApp().fetch(new Request('http://x/static/hello.js', { headers: { cookie }}));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toBe('// hi');
  });

  it('serves nested file', async () => {
    const res = await makeApp().fetch(new Request('http://x/static/sub/nested.js', { headers: { cookie }}));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('// n');
  });

  it('serves .css with text/css', async () => {
    const res = await makeApp().fetch(new Request('http://x/static/hello.css', { headers: { cookie }}));
    expect(res.headers.get('content-type')).toMatch(/text\/css/);
  });

  it('rejects unauthenticated request with 401', async () => {
    const res = await makeApp().fetch(new Request('http://x/static/hello.js'));
    expect(res.status).toBe(401);
  });

  it('rejects path traversal with 400 or 404', async () => {
    const res = await makeApp().fetch(new Request('http://x/static/../config.ts', { headers: { cookie }}));
    expect([400, 404]).toContain(res.status);
  });

  it('404 for missing file', async () => {
    const res = await makeApp().fetch(new Request('http://x/static/nope.js', { headers: { cookie }}));
    expect(res.status).toBe(404);
  });
});
