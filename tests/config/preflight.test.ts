import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseWorkflowConfig } from '../../src/config/schema.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { PreflightError, preflightConfig } from '../../src/config/preflight.js';

const ENV = { LINEAR_API_KEY: 'lin_test_token' };

function buildResolved(extras: { mcp?: Record<string, unknown>; workspaceRoot?: string }) {
  const tmp = extras.workspaceRoot ?? path.join(os.tmpdir(), 'preflight-test-workspaces');
  const cfg = parseWorkflowConfig({
    tracker: { kind: 'linear', project_slug: 'chronicle' },
    workspace: { root: tmp },
    claude: { mcp_servers: extras.mcp ?? { linear: { url: 'https://mcp.linear.app/mcp' } } },
  });
  return resolveConfig(cfg, ENV);
}

describe('preflightConfig — Linear MCP requirement', () => {
  it('passes when an explicit "linear" key is present in mcp_servers', () => {
    const cfg = buildResolved({ mcp: { linear: { url: 'https://mcp.linear.app/mcp' } } });
    expect(() => preflightConfig(cfg)).not.toThrow();
  });

  it('passes when key is named differently but URL points at linear.app', () => {
    const cfg = buildResolved({
      mcp: { tracker: { url: 'https://mcp.linear.app/mcp' } },
    });
    expect(() => preflightConfig(cfg)).not.toThrow();
  });

  it('passes when key is case-insensitively "linear-server"', () => {
    const cfg = buildResolved({ mcp: { 'Linear-Server': { command: 'npx', args: ['mcp-linear'] } } });
    expect(() => preflightConfig(cfg)).not.toThrow();
  });

  it('throws when mcp_servers is empty', () => {
    const cfg = buildResolved({ mcp: {} });
    expect(() => preflightConfig(cfg)).toThrow(PreflightError);
    expect(() => preflightConfig(cfg)).toThrow(/mcp_servers/);
  });

  it('throws when mcp_servers has unrelated entries only', () => {
    const cfg = buildResolved({ mcp: { playwright: { command: 'npx' } } });
    expect(() => preflightConfig(cfg)).toThrow(PreflightError);
  });
});

describe('preflightConfig — workspace.root parent check', () => {
  let tempBase: string;

  beforeEach(() => {
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  });

  afterEach(() => {
    fs.rmSync(tempBase, { recursive: true, force: true });
  });

  it('passes when the parent of workspace.root exists', () => {
    const cfg = buildResolved({ workspaceRoot: path.join(tempBase, 'subdir') });
    expect(() => preflightConfig(cfg)).not.toThrow();
  });

  it('throws when the parent of workspace.root does not exist', () => {
    const cfg = buildResolved({ workspaceRoot: '/this/path/definitely/does/not/exist/anywhere' });
    expect(() => preflightConfig(cfg)).toThrow(/parent directory/);
  });
});
