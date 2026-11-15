import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendToCheckout,
  checkoutHasLine,
  checkoutRelPath,
  ownerSpawnOptions,
  readFromCheckout,
  readFromCheckoutBuffer,
  writeToCheckout,
} from './checkout-fs.js';

// These tests run the real shell commands as the current user (the root
// branch only adds uid/gid, asserted separately below).
let root: string;
let outside: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cfs-'));
  root = path.join(base, 'checkout');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(outside);
});
afterEach(() =>
  fs.rmSync(path.dirname(root), { recursive: true, force: true }),
);

describe('checkoutRelPath', () => {
  it('accepts paths inside the checkout, including names starting with ..', () => {
    expect(checkoutRelPath(root, path.join(root, 'a/b.md'))).toBe('a/b.md');
    expect(checkoutRelPath(root, path.join(root, '..archive/x.md'))).toBe(
      '..archive/x.md',
    );
  });
  it('refuses the root itself, escapes and absolute outside paths', () => {
    expect(() => checkoutRelPath(root, root)).toThrow(/refused/);
    expect(() => checkoutRelPath(root, path.join(root, '../x'))).toThrow(
      /refused/,
    );
    expect(() => checkoutRelPath(root, '/etc/passwd')).toThrow(/refused/);
  });
});

describe('appendToCheckout / writeToCheckout / readFromCheckout', () => {
  it('append creates parent directories and appends every byte', () => {
    const big = 'x'.repeat(300_000) + '\n';
    appendToCheckout(
      root,
      path.join(root, 'discussions/audit-log/d.md'),
      'a\n',
    );
    appendToCheckout(root, path.join(root, 'discussions/audit-log/d.md'), big);
    expect(
      fs.readFileSync(path.join(root, 'discussions/audit-log/d.md'), 'utf8'),
    ).toBe('a\n' + big);
  });

  it('write replaces the file atomically and leaves no temp file', () => {
    const f = path.join(root, 'discussions/a.md');
    writeToCheckout(root, f, 'one');
    writeToCheckout(root, f, 'two');
    expect(fs.readFileSync(f, 'utf8')).toBe('two');
    expect(fs.readdirSync(path.dirname(f))).toEqual(['a.md']);
  });

  it('write replaces a planted symlink rather than writing through it', () => {
    const target = path.join(outside, 'secret.env');
    fs.writeFileSync(target, 'KEEP=1\n');
    fs.symlinkSync(target, path.join(root, 'a.md'));
    writeToCheckout(root, path.join(root, 'a.md'), 'new');
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP=1\n');
    expect(fs.lstatSync(path.join(root, 'a.md')).isSymbolicLink()).toBe(false);
  });

  it('read returns content, or null for a missing path or a FIFO', () => {
    fs.writeFileSync(path.join(root, 'a.md'), 'hello');
    expect(readFromCheckout(root, path.join(root, 'a.md'))).toBe('hello');
    expect(readFromCheckout(root, path.join(root, 'nope.md'))).toBeNull();
    const fifo = path.join(root, 'pipe.md');
    execFileSync('mkfifo', [fifo]);
    expect(readFromCheckout(root, fifo)).toBeNull();
  });

  it('reads raw bytes unchanged (non-UTF-8 email bodies)', () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a]);
    fs.writeFileSync(path.join(root, 'm.eml'), bytes);
    expect(readFromCheckoutBuffer(root, path.join(root, 'm.eml'))).toEqual(
      bytes,
    );
    expect(readFromCheckoutBuffer(root, path.join(root, 'x.eml'))).toBeNull();
  });

  it('append refuses a planted symlink or FIFO; read treats a link as absent', () => {
    const target = path.join(outside, 'secret.env');
    fs.writeFileSync(target, 'KEEP=1\n');
    fs.symlinkSync(target, path.join(root, 'l.md'));
    expect(() =>
      appendToCheckout(root, path.join(root, 'l.md'), 'x'),
    ).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP=1\n');
    expect(readFromCheckout(root, path.join(root, 'l.md'))).toBeNull();
    execFileSync('mkfifo', [path.join(root, 'f.md')]);
    expect(() =>
      appendToCheckout(root, path.join(root, 'f.md'), 'x'),
    ).toThrow();
  });

  it('write refuses to drop the file inside a directory that took the name', () => {
    fs.mkdirSync(path.join(root, 'd.md'));
    expect(() => writeToCheckout(root, path.join(root, 'd.md'), 'x')).toThrow();
    expect(fs.readdirSync(path.join(root, 'd.md'))).toEqual([]);
  });

  it('refuses writes when the checkout has no .git (missing or wrong root)', () => {
    const bare = path.join(path.dirname(root), 'not-a-checkout');
    fs.mkdirSync(bare);
    expect(() =>
      appendToCheckout(bare, path.join(bare, 'a.md'), 'x'),
    ).toThrow();
    expect(() => writeToCheckout(bare, path.join(bare, 'a.md'), 'x')).toThrow();
    expect(fs.readdirSync(bare)).toEqual([]);
  });

  it('a read that fails for a real reason throws instead of looking absent', () => {
    const f = path.join(root, 'unreadable.md');
    fs.writeFileSync(f, 'x');
    fs.chmodSync(f, 0o000);
    if (process.getuid?.() === 0) return; // root reads anyway
    expect(() => readFromCheckout(root, f)).toThrow();
    fs.chmodSync(f, 0o644);
  });

  it('refuses a missing checkout in-process, without spawning a child', () => {
    // Hot paths (every audit write) must not pay a process spawn just to be
    // refused when no checkout exists (dev, CI, a misconfigured host). The
    // in-process refusal says "has no .git"; the shell's says "is not a
    // checkout", so the message shows which path refused.
    const bare = path.join(path.dirname(root), 'no-checkout');
    for (const op of [
      () => appendToCheckout(bare, path.join(bare, 'a.md'), 'x'),
      () => writeToCheckout(bare, path.join(bare, 'a.md'), 'x'),
      () => readFromCheckout(bare, path.join(bare, 'a.md')),
    ])
      expect(op).toThrow(/has no \.git/);
  });

  it('refuses paths outside the checkout before running anything', () => {
    expect(() => appendToCheckout(root, '/etc/x', 'x')).toThrow(/refused/);
    expect(() => writeToCheckout(root, path.join(root, '../o'), 'x')).toThrow(
      /refused/,
    );
    expect(() => readFromCheckout(root, '/etc/passwd')).toThrow(/refused/);
  });

  it('handles names with spaces and leading dashes', () => {
    const f = path.join(root, 'd/-n x.md');
    appendToCheckout(root, f, 'ok');
    expect(fs.readFileSync(f, 'utf8')).toBe('ok');
  });
});

describe('checkoutHasLine', () => {
  it('finds an exact whole line in a file or anywhere under a directory', () => {
    const d = path.join(root, 'discussions/audit-log');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'a.md'), 'x\n<!-- m:1 -->\ny\n');
    fs.writeFileSync(path.join(d, 'b.txt'), '<!-- m:2 -->\n');
    expect(checkoutHasLine(root, d, '<!-- m:1 -->')).toBe(true);
    expect(checkoutHasLine(root, path.join(d, 'a.md'), '<!-- m:1 -->')).toBe(
      true,
    );
    expect(checkoutHasLine(root, d, '<!-- m:1')).toBe(false); // whole line only
    expect(checkoutHasLine(root, d, '<!-- m:2 -->')).toBe(false); // .md only
    expect(checkoutHasLine(root, path.join(root, 'missing'), 'x')).toBe(false);
  });

  it('skips a FIFO and does not follow a symlinked file', () => {
    const d = path.join(root, 'discussions/audit-log');
    fs.mkdirSync(d, { recursive: true });
    execFileSync('mkfifo', [path.join(d, 'pipe.md')]);
    const target = path.join(outside, 'o.md');
    fs.writeFileSync(target, 'SECRET\n');
    fs.symlinkSync(target, path.join(d, 'link.md'));
    expect(checkoutHasLine(root, d, 'SECRET')).toBe(false);
  });
});

describe('ownerSpawnOptions', () => {
  it('runs as uid/gid 1000 with a minimal env when the host is root', () => {
    const o = ownerSpawnOptions(true);
    expect(o.uid).toBe(1000);
    expect(o.gid).toBe(1000);
    expect(o.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/ubuntu' });
  });
  it('sets no uid when not root', () => {
    expect(ownerSpawnOptions(false).uid).toBeUndefined();
  });
});
