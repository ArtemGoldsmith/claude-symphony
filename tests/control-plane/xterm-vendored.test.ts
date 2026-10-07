import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import path from 'node:path';

describe('xterm vendored under /static/xterm/', () => {
  const dir = path.resolve(__dirname, '../../src/control-plane/web/static/xterm');
  for (const f of ['xterm.js', 'xterm.css', 'addon-fit.js']) {
    it(`has ${f} > 1KB`, () => {
      const st = statSync(path.join(dir, f));
      expect(st.size).toBeGreaterThan(1024);
    });
  }
});
