import { describe, it, expect } from 'vitest';

describe('node-pty module loads', () => {
  it('exposes spawn as a function', async () => {
    const pty = await import('node-pty');
    expect(typeof pty.spawn).toBe('function');
  });
});

describe('ws module loads', () => {
  it('exposes WebSocketServer as a constructor', async () => {
    const ws = await import('ws');
    expect(typeof ws.WebSocketServer).toBe('function');
  });
});
