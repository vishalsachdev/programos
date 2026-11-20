/**
 * Issue 55: a secret presented by a request is compared in constant time,
 * with no early return on a different length.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { bearerMatches, secretsEqual } from './secret-compare.js';

const SECRET = 'test-secret-value';

describe('secretsEqual', () => {
  it('accepts the same value only', () => {
    expect(secretsEqual(SECRET, SECRET)).toBe(true);
    expect(secretsEqual(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretsEqual(SECRET.slice(0, -1), SECRET)).toBe(false);
    expect(secretsEqual(SECRET.toUpperCase(), SECRET)).toBe(false);
  });

  it('refuses a missing, empty or non-string value without throwing', () => {
    for (const presented of [undefined, null, '', 0, [], [SECRET], {}])
      expect(secretsEqual(presented, SECRET)).toBe(false);
  });

  it('never matches an empty expected secret', () => {
    expect(secretsEqual('', '')).toBe(false);
    expect(secretsEqual(undefined, '')).toBe(false);
  });

  it('handles a value of any length without throwing (timingSafeEqual alone throws on a length difference)', () => {
    for (const presented of ['', 'x', SECRET, 'y'.repeat(100_000)])
      expect(() => secretsEqual(presented, SECRET)).not.toThrow();
    expect(secretsEqual('y'.repeat(100_000), 'y'.repeat(100_000))).toBe(true);
  });
});

describe('bearerMatches', () => {
  it('accepts exactly "Bearer <secret>"', () => {
    expect(bearerMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    [
      'a wrong secret of the same length',
      `Bearer ${'x'.repeat(SECRET.length)}`,
    ],
    ['a shorter secret', `Bearer ${SECRET.slice(0, 4)}`],
    ['a longer secret', `Bearer ${SECRET}${SECRET}`],
    ['the secret without the scheme', SECRET],
    ['another scheme', `Basic ${SECRET}`],
    ['a lower-case scheme', `bearer ${SECRET}`],
    ['a trailing space', `Bearer ${SECRET} `],
    ['an empty header', ''],
    ['"Bearer " alone', 'Bearer '],
    ['a missing header', undefined],
    ['a repeated header', [`Bearer ${SECRET}`, `Bearer ${SECRET}`]],
  ])('refuses %s', (_name, header) => {
    expect(bearerMatches(header, SECRET)).toBe(false);
  });

  it('refuses everything when the host has no secret', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer undefined', '')).toBe(false);
  });
});

describe('no request secret is compared with a plain operator', () => {
  const root = path.join(__dirname, '..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name))
        files.push(rel);
    }
  };
  walk('src');

  it('scans the source (the scan itself works)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/channels/webhook.ts');
  });

  it('no source file compares a header with === or !== against a Bearer value or a secret', () => {
    const bad: string[] = [];
    const plain =
      /[!=]==?\s*`Bearer \$\{|`Bearer \$\{[^`]*`\s*[!=]==?|\b\w*(auth|Auth)\w*\s*[!=]==?\s*\w*(secret|Secret|SECRET)\b|\b\w*(secret|Secret|SECRET)\s*[!=]==?\s*\w*(auth|Auth|header|Header|presented|token)\w*\b/;
    for (const rel of files) {
      const lines = fs.readFileSync(path.join(root, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (plain.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it.each([
    ['src/channels/webhook.ts', 'WEBHOOK_SECRET'],
    ['src/channels/web-chat.ts', 'WEBCHAT_SECRET'],
  ])('%s checks %s with bearerMatches', (rel) => {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    expect(text).toMatch(/if \(!bearerMatches\(authHeader, secret\)\) \{/);
  });
});
