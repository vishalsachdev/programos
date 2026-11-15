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

function run(): { status: number | null; out: string } {
  const r = spawnSync(
    'bash',
    [path.join(root, 'scripts/cleanup-sessions.sh')],
    {
      encoding: 'utf8',
    },
  );
  return { status: r.status, out: r.stdout + r.stderr };
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
    expect(run().status).toBe(0);
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

  it('does not open store/messages.db through a planted link', () => {
    const hostDb = path.join(outside, 'other.db');
    makeDb(hostDb, ['keep-me']);
    fs.symlinkSync(hostDb, path.join(root, 'store/messages.db'));
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/refused/);
  });
});
