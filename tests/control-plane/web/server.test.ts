import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createApp, type AppDeps } from '../../../src/control-plane/web/server.js';
import { TaskStore } from '../../../src/control-plane/task-store.js';
import type { LinearReadGateway } from '../../../src/control-plane/linear-read.js';

let root: string;
const linearRead: LinearReadGateway = { async fetchIssueByIdentifier() { return null; }, async listComments() { return []; } };

beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'cp-srv-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function build() {
  const store = new TaskStore({ stateRoot: root, ownerGen: 'g', now: () => 1 });
  const deps: AppDeps = { store, linearRead, stateRoot: root, token: 'tok' };
  return createApp(deps);
}

describe('createApp', () => {
  it('gates the board, the detail route, and POST /tasks behind auth (401)', async () => {
    const app = build();
    for (const req of [['/', undefined], ['/tasks/PIN-1', undefined], ['/tasks', { method: 'POST' }]] as const) {
      const res = await app.request(req[0], req[1]);
      expect(res.status).toBe(401);
    }
  });
  it('serves the board with a valid cookie', async () => {
    const app = build();
    const res = await app.request('/', { headers: { cookie: 'symphony_token=tok' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('symphony board');
  });
  it('leaves /login reachable without auth', async () => {
    const res = await build().request('/login');
    expect(res.status).toBe(200);
  });
});
