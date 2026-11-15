import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runnerSourceNeedsCopy } from './runner-cache.js';

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cache-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}

function touch(file: string, whenMs: number): void {
  fs.utimesSync(file, new Date(whenMs), new Date(whenMs));
}

describe('runnerSourceNeedsCopy', () => {
  it('copies when the cache is missing', () => {
    const src = tree({ 'index.ts': 'a' });
    expect(runnerSourceNeedsCopy(src, path.join(src, 'nope'), false)).toBe(
      true,
    );
  });

  it('does not copy when every cached file is at least as new as the source', () => {
    const src = tree({ 'index.ts': 'a', 'ipc-mcp-stdio.ts': 'b' });
    const cache = tree({ 'index.ts': 'a', 'ipc-mcp-stdio.ts': 'b' });
    const t = Date.now() - 60_000;
    for (const f of ['index.ts', 'ipc-mcp-stdio.ts']) {
      touch(path.join(src, f), t);
      touch(path.join(cache, f), t + 1_000);
    }
    expect(runnerSourceNeedsCopy(src, cache, false)).toBe(false);
  });

  it('copies when a NON-index source file is newer than the cache (RC-018 deploy gap)', () => {
    const src = tree({ 'index.ts': 'a', 'ipc-mcp-stdio.ts': 'b' });
    const cache = tree({ 'index.ts': 'a', 'ipc-mcp-stdio.ts': 'old' });
    const t = Date.now() - 60_000;
    touch(path.join(src, 'index.ts'), t);
    touch(path.join(cache, 'index.ts'), t + 1_000);
    touch(path.join(cache, 'ipc-mcp-stdio.ts'), t + 1_000);
    touch(path.join(src, 'ipc-mcp-stdio.ts'), t + 5_000);
    expect(runnerSourceNeedsCopy(src, cache, false)).toBe(true);
  });

  it('copies when a source file has no cached counterpart', () => {
    const src = tree({ 'index.ts': 'a', 'allowlist-check.ts': 'new' });
    const cache = tree({ 'index.ts': 'a' });
    const t = Date.now() - 60_000;
    touch(path.join(src, 'index.ts'), t);
    touch(path.join(cache, 'index.ts'), t + 1_000);
    expect(runnerSourceNeedsCopy(src, cache, false)).toBe(true);
  });

  it('always copies when forced', () => {
    const src = tree({ 'index.ts': 'a' });
    const cache = tree({ 'index.ts': 'a' });
    expect(runnerSourceNeedsCopy(src, cache, true)).toBe(true);
  });

  it('copies when the cache holds a file the source no longer has (deleted module)', () => {
    const src = tree({ 'index.ts': 'a' });
    const cache = tree({ 'index.ts': 'a', 'removed.ts': 'stale' });
    const t = Date.now() - 60_000;
    touch(path.join(src, 'index.ts'), t);
    touch(path.join(cache, 'index.ts'), t + 1_000);
    expect(runnerSourceNeedsCopy(src, cache, false)).toBe(true);
  });

  it('refuses to inspect an oversized cache and refreshes instead of walking it (bounded)', () => {
    const files = { 'index.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' };
    const src = tree(files);
    const cache = tree(files);
    const t = Date.now() - 60_000;
    for (const f of Object.keys(files)) {
      touch(path.join(src, f), t);
      touch(path.join(cache, f), t + 1_000);
    }
    expect(runnerSourceNeedsCopy(src, cache, false)).toBe(false);
    expect(
      runnerSourceNeedsCopy(src, cache, false, { maxCacheEntries: 2 }),
    ).toBe(true);
  });
});
