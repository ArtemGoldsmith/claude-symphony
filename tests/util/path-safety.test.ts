import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  UnsafePathError,
  assertSafeIssueIdentifier,
  joinWithinRoot,
} from '../../src/util/path-safety.js';

describe('assertSafeIssueIdentifier', () => {
  it('accepts canonical TEAM-NNN identifiers', () => {
    expect(() => assertSafeIssueIdentifier('ABC-1')).not.toThrow();
    expect(() => assertSafeIssueIdentifier('TEAM-1234')).not.toThrow();
    expect(() => assertSafeIssueIdentifier('A_B-9')).not.toThrow();
  });

  it('rejects identifiers containing path separators', () => {
    expect(() => assertSafeIssueIdentifier('ABC/1')).toThrow(UnsafePathError);
    expect(() => assertSafeIssueIdentifier('ABC-1/etc')).toThrow(UnsafePathError);
  });

  it('rejects identifiers with parent-traversal sequences', () => {
    expect(() => assertSafeIssueIdentifier('..')).toThrow(UnsafePathError);
    expect(() => assertSafeIssueIdentifier('ABC-..')).toThrow(UnsafePathError);
  });

  it('rejects empty identifiers and NUL bytes', () => {
    expect(() => assertSafeIssueIdentifier('')).toThrow(UnsafePathError);
    expect(() => assertSafeIssueIdentifier('ABC-1\u0000')).toThrow(UnsafePathError);
  });

  it('rejects identifiers without the dash-number suffix', () => {
    expect(() => assertSafeIssueIdentifier('ABC')).toThrow(UnsafePathError);
    expect(() => assertSafeIssueIdentifier('ABC-')).toThrow(UnsafePathError);
    expect(() => assertSafeIssueIdentifier('ABC-abc')).toThrow(UnsafePathError);
  });
});

describe('joinWithinRoot', () => {
  const ROOT = path.join(os.tmpdir(), 'cs-pathsafety-root');

  it('returns root/segment as an absolute path', () => {
    const composed = joinWithinRoot(ROOT, 'ABC-1');
    expect(path.isAbsolute(composed)).toBe(true);
    expect(composed).toBe(path.join(path.resolve(ROOT), 'ABC-1'));
  });

  it('throws on a parent-traversal segment', () => {
    expect(() => joinWithinRoot(ROOT, '../escape')).toThrow(UnsafePathError);
    expect(() => joinWithinRoot(ROOT, 'a/../../etc')).toThrow(UnsafePathError);
  });

  it('throws on an absolute segment that points outside root', () => {
    expect(() => joinWithinRoot(ROOT, '/etc/passwd')).toThrow(UnsafePathError);
  });

  it('treats a trailing slash on root the same as without', () => {
    const a = joinWithinRoot(ROOT, 'ABC-1');
    const b = joinWithinRoot(ROOT + path.sep, 'ABC-1');
    expect(a).toBe(b);
  });
});
