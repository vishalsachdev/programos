import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRunArtifact } from './eval-metrics.js';
import Database from 'better-sqlite3';

import { writeArtifactFile } from '../scripts/safe-artifact.mjs';

// store/ is writable for the main group's container, and the eval runners
// and eval:report run on the VPS as root: store/eval-runs/ reads and writes
// must never follow a link planted there.

let base: string;
let runs: string; // stands in for store/eval-runs
let secret: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'evalrun-'));
  runs = path.join(base, 'store', 'eval-runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(path.join(base, 'outside'));
  secret = path.join(base, 'outside', 'secret.env');
  fs.writeFileSync(secret, 'KEEP=1\n');
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('eval run artifacts under store/eval-runs', () => {
  it('eval:gates does not write its artifact through a planted link', () => {
    const out = path.join(runs, 'gates-latest.json');
    fs.symlinkSync(secret, out);
    try {
      execFileSync('node', ['scripts/eval-gates.mjs', '--out', out], {
        stdio: 'pipe',
      });
    } catch {
      /* refusing is fine */
    }
    expect(fs.readFileSync(secret, 'utf8')).toBe('KEEP=1\n');
  });

  it('writeArtifactFile replaces a dangling link instead of creating its target', () => {
    const target = path.join(base, 'outside', 'new.json');
    fs.symlinkSync(target, path.join(runs, 'suite-latest.json'));
    writeArtifactFile(
      path.join(runs, 'suite-latest.json'),
      '{}',
      path.join(base, 'store'),
    );
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(path.join(runs, 'suite-latest.json')).isFile()).toBe(
      true,
    );
  });

  it('writeArtifactFile refuses a linked eval-runs directory', () => {
    fs.rmSync(runs, { recursive: true });
    fs.symlinkSync(path.join(base, 'outside'), runs);
    expect(() =>
      writeArtifactFile(
        path.join(runs, 'suite-latest.json'),
        '{}',
        path.join(base, 'store'),
      ),
    ).toThrow(/refused/);
    expect(fs.readdirSync(path.join(base, 'outside'))).toEqual(['secret.env']);
  });

  it('writeArtifactFile refuses a linked ancestor of a nested output', () => {
    fs.rmSync(runs, { recursive: true });
    fs.symlinkSync(path.join(base, 'outside'), runs);
    expect(() =>
      writeArtifactFile(
        path.join(runs, 'daily', 'gates.json'),
        '{}',
        path.join(base, 'store'),
      ),
    ).toThrow(/refused/);
    expect(fs.readdirSync(path.join(base, 'outside'))).toEqual(['secret.env']);
  });

  it('loadRunArtifact does not read an artifact through a link', () => {
    fs.writeFileSync(
      secret,
      JSON.stringify({ total: 1, passed: 1, failed: 0, skipped: 0 }),
    );
    fs.symlinkSync(secret, path.join(runs, 'gates-latest.json'));
    const status = loadRunArtifact(
      path.join(runs, 'gates-latest.json'),
      new Date(),
    );
    expect(status.available).toBe(false);
  });
});

describe('writeArtifactFile default root (the project directory)', () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  it('refuses an --out under any linked directory in the project, not only store/', () => {
    process.chdir(base);
    fs.mkdirSync(path.join(base, 'groups', 'g'), { recursive: true });
    fs.symlinkSync(
      path.join(base, 'outside'),
      path.join(base, 'groups', 'g', 'reports'),
    );
    expect(() =>
      writeArtifactFile('groups/g/reports/gates.json', '{}'),
    ).toThrow(/refused/);
    expect(fs.readdirSync(path.join(base, 'outside'))).toEqual(['secret.env']);
  });
});

describe('state-snapshot (root, output committed to the repo)', () => {
  it('does not open store/messages.db through a planted link', () => {
    // A host database elsewhere that happens to have the snapshot's tables.
    const hostDb = path.join(base, 'outside', 'other.db');
    const db = new Database(hostDb);
    db.exec(
      "CREATE TABLE scheduled_tasks (id TEXT, prompt TEXT); INSERT INTO scheduled_tasks VALUES ('x', 'HOST-SECRET');" +
        'CREATE TABLE registered_groups (jid TEXT);',
    );
    db.close();
    const store = path.join(base, 'store');
    fs.symlinkSync(hostDb, path.join(store, 'messages.db'));
    let out = '';
    try {
      out = execFileSync(
        'node',
        ['scripts/state-snapshot.mjs', path.join(store, 'messages.db')],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch {
      /* refusing is fine */
    }
    expect(out).not.toContain('HOST-SECRET');
  });
});
