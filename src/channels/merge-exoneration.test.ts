import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeAdminExoneratedPaths } from './github-push-events.js';

const ADMIN = 'avery.personal@gmail.com';
const BOT = 'program-bot@example.org';
const FILE = 'program/EMAIL_ALLOWLIST.md';
const PATHS = [{ path: FILE, rule: 'G39' as const }];

let dir: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

function commitAs(msg: string, email: string, extra: string[] = []) {
  git('add', '-A');
  git(
    '-c',
    `user.email=${email}`,
    '-c',
    'user.name=T',
    'commit',
    '--no-gpg-sign',
    ...extra,
    '-m',
    msg,
  );
  return git('rev-parse', 'HEAD');
}
const mergeAs = (email: string, branch: string, extra: string[] = []) =>
  git(
    '-c',
    `user.email=${email}`,
    '-c',
    'user.name=T',
    'merge',
    '--no-gpg-sign',
    '--no-ff',
    ...extra,
    '-m',
    `merge ${branch}`,
    branch,
  );

function writeAllowlist(content: string) {
  fs.mkdirSync(path.join(dir, 'program'), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), content);
}

/**
 * Shape under test: main is the BOT's branch (first parent),
 * the admin's allowlist change arrives from the SIDE branch (second parent).
 */
function botMainAdminSide() {
  writeAllowlist('alice\n');
  commitAs('base', ADMIN);
  git('branch', 'adminwork');
  fs.writeFileSync(path.join(dir, 'audit.txt'), 'entries');
  commitAs('bot audit log', BOT); // main = bot, first parent
  git('checkout', '--quiet', 'adminwork');
  writeAllowlist('alice\namir\n');
  commitAs('admin onboards tariq', ADMIN); // side = admin change
  git('checkout', '--quiet', 'main');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-exon-'));
  execFileSync('git', ['-C', dir, 'init', '--quiet', '-b', 'main']);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('mergeAdminExoneratedPaths (G39 merge-awareness)', () => {
  it('does NOT exonerate a non-merge commit', async () => {
    writeAllowlist('alice\n');
    commitAs('base', ADMIN);
    writeAllowlist('alice\nmallory\n');
    const sha = commitAs('bot edits allowlist', BOT);
    expect([
      ...(await mergeAdminExoneratedPaths(dir, sha, PATHS)).keys(),
    ]).toEqual([]);
  });

  it('exonerates a merge that inherits a NEW admin change (the real db24498 shape)', async () => {
    botMainAdminSide();
    mergeAs(BOT, 'adminwork');
    const sha = git('rev-parse', 'HEAD');
    expect([
      ...(await mergeAdminExoneratedPaths(dir, sha, PATHS)).keys(),
    ]).toEqual([FILE]);
  });

  it('BLOCKS the replay bypass: merging a stale admin revision back in', async () => {
    // Attacker branches from an OLD
    // admin commit whose allowlist still contains a since-removed member, adds
    // an unrelated commit so the path's last author is still that admin, then
    // merges the stale file back into main. Content matches a parent and that
    // parent's last author for the path IS an admin — so a naive check passes.
    writeAllowlist('alice\nmallory\n');
    const oldAdmin = commitAs('admin: allowlist with mallory', ADMIN);
    writeAllowlist('alice\n');
    commitAs('admin: REMOVE mallory', ADMIN); // main: mallory revoked
    git('checkout', '--quiet', '-b', 'replay-old', oldAdmin);
    commitAs('unrelated side-branch commit', BOT, ['--allow-empty']);
    git('checkout', '--quiet', 'main');
    mergeAs(BOT, 'replay-old', ['--no-commit']);
    git('checkout', 'replay-old', '--', FILE); // restore the stale allowlist
    git('add', '-A');
    git(
      '-c',
      `user.email=${BOT}`,
      '-c',
      'user.name=T',
      'commit',
      '--no-gpg-sign',
      '-m',
      'merge side branch',
    );
    const sha = git('rev-parse', 'HEAD');
    // Sanity: the attack really did restore mallory.
    expect(fs.readFileSync(path.join(dir, FILE), 'utf8')).toContain('mallory');

    // NON-VACUITY GUARD. The superseded rule was "content matches some parent
    // AND that parent's last author for the path is an admin". Assert that
    // rule WOULD have been fooled here — otherwise this test could pass for
    // reasons unrelated to the fix and silently stop protecting anything.
    const parents = git('rev-list', '--parents', '-n', '1', sha)
      .split(/\s+/)
      .slice(1);
    const mergeBlob = git('rev-parse', `${sha}:${FILE}`);
    const oldRuleWouldExonerate = parents.some((parent) => {
      let parentBlob: string;
      try {
        parentBlob = git('rev-parse', `${parent}:${FILE}`);
      } catch {
        return false;
      }
      if (parentBlob !== mergeBlob) return false;
      const lastAuthor = git('log', '-1', '--format=%ae', parent, '--', FILE);
      return lastAuthor === ADMIN;
    });
    expect(oldRuleWouldExonerate).toBe(true);

    // The hardened rule must refuse it.
    expect([
      ...(await mergeAdminExoneratedPaths(dir, sha, PATHS)).keys(),
    ]).toEqual([]);
  });

  it('still alerts when the merge writes NEW content matching neither parent', async () => {
    botMainAdminSide();
    mergeAs(BOT, 'adminwork', ['--no-commit']);
    writeAllowlist('alice\namir\nmallory\n'); // bot smuggles a row in
    git('add', '-A');
    git(
      '-c',
      `user.email=${BOT}`,
      '-c',
      'user.name=T',
      'commit',
      '--no-gpg-sign',
      '-m',
      'merge+edit',
    );
    const sha = git('rev-parse', 'HEAD');
    expect([
      ...(await mergeAdminExoneratedPaths(dir, sha, PATHS)).keys(),
    ]).toEqual([]);
  });

  it('still alerts when the merge takes a NON-admin parent content', async () => {
    writeAllowlist('alice\n');
    commitAs('base', ADMIN);
    git('branch', 'botwork');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
    commitAs('admin unrelated', ADMIN);
    git('checkout', '--quiet', 'botwork');
    writeAllowlist('alice\nmallory\n');
    commitAs('bot edits allowlist', BOT);
    git('checkout', '--quiet', 'main');
    mergeAs(BOT, 'botwork');
    const sha = git('rev-parse', 'HEAD');
    expect([
      ...(await mergeAdminExoneratedPaths(dir, sha, PATHS)).keys(),
    ]).toEqual([]);
  });

  it('still alerts when a merge DELETES the protected file', async () => {
    writeAllowlist('alice\n');
    commitAs('base', ADMIN);
    git('branch', 'botwork');
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
    commitAs('admin unrelated', ADMIN);
    git('checkout', '--quiet', 'botwork');
    fs.rmSync(path.join(dir, FILE));
    commitAs('bot deletes allowlist', BOT);
    git('checkout', '--quiet', 'main');
    mergeAs(BOT, 'botwork');
    const sha = git('rev-parse', 'HEAD');
    expect([
      ...(await mergeAdminExoneratedPaths(dir, sha, PATHS)).keys(),
    ]).toEqual([]);
  });

  it('BLOCKS an admin commit followed by a bot revert on the same side branch', async () => {
    // The sharpest attack on condition (3): make the range non-empty and
    // admin-looking by putting a REAL admin commit on the side branch, then
    // quietly revert the file to an older revision in a later bot commit on
    // that same branch. Condition (2) then matches the bot's content while
    // condition (3) sees an admin author. It must fail because --full-history
    // also lists the BOT commit in the range — history simplification must not
    // be allowed to prune the admin/revert pair as a no-op.
    writeAllowlist('alice\nmallory\n');
    commitAs('admin: old revision with mallory', ADMIN);
    writeAllowlist('alice\n');
    commitAs('admin: REMOVE mallory', ADMIN);
    git('branch', 'sidework');
    fs.writeFileSync(path.join(dir, 'audit.txt'), 'entries');
    commitAs('bot audit log', BOT); // main = first parent
    git('checkout', '--quiet', 'sidework');
    writeAllowlist('alice\nbob\n');
    commitAs('admin: legitimately add bob', ADMIN); // real admin work
    writeAllowlist('alice\nmallory\n'); // bot reverts to the old bad revision
    commitAs('bot: quiet revert', BOT);
    git('checkout', '--quiet', 'main');
    mergeAs(BOT, 'sidework');
    const sha = git('rev-parse', 'HEAD');
    expect(fs.readFileSync(path.join(dir, FILE), 'utf8')).toContain('mallory');
    expect([
      ...(await mergeAdminExoneratedPaths(dir, sha, PATHS)).keys(),
    ]).toEqual([]);
  });

  it('fails CLOSED on an unparseable sha', async () => {
    expect([
      ...(await mergeAdminExoneratedPaths(dir, 'not-a-sha', PATHS)).keys(),
    ]).toEqual([]);
  });

  it('fails CLOSED when the repo path is unusable', async () => {
    const out = await mergeAdminExoneratedPaths(
      path.join(dir, 'nope'),
      '0'.repeat(40),
      PATHS,
    );
    expect([...out.keys()]).toEqual([]);
  });
});
