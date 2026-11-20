import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/cleanup-sessions.sh runs as root after startup and daily, over
// data/sessions/<g>/.claude (agent-writable) and store/ (main-writable).
// It must not delete, read or open anything through a planted link.

let root: string; // a throwaway project root holding a copy of the script
let outside: string;

function run(env?: NodeJS.ProcessEnv): {
  status: number | null;
  out: string;
  lastLine: string;
} {
  const r = spawnSync(
    'bash',
    [path.join(root, 'scripts/cleanup-sessions.sh')],
    {
      encoding: 'utf8',
      ...(env ? { env } : {}),
    },
  );
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    // The host logs the last line of stdout only (src/session-cleanup.ts).
    lastLine: r.stdout.trim().split('\n').pop() ?? '',
  };
}

// A PATH that holds every command the script uses except sqlite3, so the
// test does not depend on whether the machine has sqlite3 installed.
function pathWithoutSqlite3(): string {
  const bin = path.join(root, 'bin-no-sqlite3');
  fs.mkdirSync(bin);
  for (const cmd of [
    'bash',
    'basename',
    'cut',
    'dirname',
    'du',
    'find',
    'grep',
    'rm',
    'wc',
  ]) {
    const found = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((d) => path.join(d, cmd))
      .find((p) => fs.existsSync(p));
    if (!found) throw new Error(`test setup: ${cmd} not found on PATH`);
    fs.symlinkSync(found, path.join(bin, cmd));
  }
  return bin;
}

// A sqlite3 that answers the session query from a fixed list, or fails.
function pathWithFakeSqlite3(script: string): string {
  const bin = pathWithoutSqlite3();
  fs.writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/bash\n${script}\n`, {
    mode: 0o755,
  });
  return bin;
}

function sessionFiles(): { dir: string; files: string[] } {
  const claude = path.join(root, 'data/sessions/g/.claude');
  const dir = path.join(claude, 'projects/-workspace-group');
  for (const d of [dir, 'debug', 'todos', 'telemetry'])
    fs.mkdirSync(path.isAbsolute(d) ? d : path.join(claude, d), {
      recursive: true,
    });
  const files = [
    path.join(dir, 'live.jsonl'),
    path.join(dir, 'stale.jsonl'),
    path.join(claude, 'debug/live.txt'),
    path.join(claude, 'todos/live-agent-live.json'),
    path.join(claude, 'telemetry/live.json'),
  ];
  files.forEach(makeOld);
  return { dir, files };
}

function makeDb(file: string, sessionIds: string[] = []): void {
  const db = new Database(file);
  db.exec('CREATE TABLE sessions (session_id TEXT)');
  for (const id of sessionIds)
    db.prepare('INSERT INTO sessions VALUES (?)').run(id);
  db.close();
}

function makeOld(file: string): void {
  fs.writeFileSync(file, '{}\n');
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cleanup-'));
  outside = path.join(root, 'outside');
  for (const d of ['scripts', 'store', 'groups', 'outside'])
    fs.mkdirSync(path.join(root, d));
  fs.copyFileSync(
    'scripts/cleanup-sessions.sh',
    path.join(root, 'scripts/cleanup-sessions.sh'),
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('cleanup-sessions.sh', () => {
  it('still prunes an old session JSONL in a real directory', () => {
    makeDb(path.join(root, 'store/messages.db'));
    const dir = path.join(
      root,
      'data/sessions/g/.claude/projects/-workspace-group',
    );
    fs.mkdirSync(dir, { recursive: true });
    makeOld(path.join(dir, 'old.jsonl'));
    // A sqlite3 that reports no active session: the machine's own may be absent.
    expect(run({ PATH: pathWithFakeSqlite3('exit 0') }).status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'old.jsonl'))).toBe(false);
  });

  it('does not delete host files through a linked projects directory', () => {
    makeDb(path.join(root, 'store/messages.db'));
    makeOld(path.join(outside, 'host.jsonl'));
    const projects = path.join(root, 'data/sessions/g/.claude/projects');
    fs.mkdirSync(projects, { recursive: true });
    fs.symlinkSync(outside, path.join(projects, '-workspace-group'));
    run();
    expect(fs.existsSync(path.join(outside, 'host.jsonl'))).toBe(true);
  });

  it('prunes no session file when sqlite3 is not installed, and says why', () => {
    makeDb(path.join(root, 'store/messages.db'), ['live']);
    const { files } = sessionFiles();
    const logs = path.join(root, 'groups/g/logs');
    fs.mkdirSync(logs, { recursive: true });
    makeOld(path.join(logs, 'run.log'));

    const r = run({ PATH: pathWithoutSqlite3() });

    expect(r.status).toBe(0);
    for (const f of files) expect(fs.existsSync(f), f).toBe(true);
    expect(r.out).toMatch(/session files not pruned: the sqlite3 command/i);
    expect(r.lastLine).toMatch(
      /session files NOT pruned: the sqlite3 command is not installed/,
    );
    // Group logs do not depend on the session list and are still pruned.
    expect(fs.existsSync(path.join(logs, 'run.log'))).toBe(false);
  });

  it('prunes no session file when the session query fails', () => {
    makeDb(path.join(root, 'store/messages.db'), ['live']);
    const { files } = sessionFiles();

    const r = run({ PATH: pathWithFakeSqlite3('exit 1') });

    expect(r.status).toBe(0);
    for (const f of files) expect(fs.existsSync(f), f).toBe(true);
    expect(r.lastLine).toMatch(
      /session files NOT pruned: the active sessions could not be read/,
    );
  });

  it('keeps the active session and prunes the rest when the query works', () => {
    makeDb(path.join(root, 'store/messages.db'), ['live']);
    const { dir, files } = sessionFiles();

    const r = run({ PATH: pathWithFakeSqlite3('echo live') });

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'stale.jsonl'))).toBe(false);
    for (const f of files.filter((f) => !f.endsWith('stale.jsonl')))
      expect(fs.existsSync(f), f).toBe(true);
    expect(r.out).not.toMatch(/NOT pruned/i);
  });

  it('prunes as usual when the query works and no session is active', () => {
    makeDb(path.join(root, 'store/messages.db'));
    const { files } = sessionFiles();

    const r = run({ PATH: pathWithFakeSqlite3('exit 0') });

    expect(r.status).toBe(0);
    for (const f of files) expect(fs.existsSync(f), f).toBe(false);
  });

  it('does not open store/messages.db through a planted link', () => {
    const hostDb = path.join(outside, 'other.db');
    makeDb(hostDb, ['keep-me']);
    fs.symlinkSync(hostDb, path.join(root, 'store/messages.db'));
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/refused/);
  });
});
