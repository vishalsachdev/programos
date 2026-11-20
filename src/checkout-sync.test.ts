/**
 * Host-side pull and push of the program-repo checkout, against a real git
 * remote: a local bare repository. The "agent" is a plain commit made in the
 * checkout, as the container would make it.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  pushCheckoutAfterTurn,
  runCheckoutPush,
  setCheckoutPushAlerter,
  syncCheckoutBeforeTurn,
} from './checkout-sync.js';

let tmp: string;
let remote: string;
let checkout: string;
let other: string;

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.org'];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...ID, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function commitFile(repo: string, name: string, text: string): string {
  fs.writeFileSync(path.join(repo, name), text);
  git(repo, 'add', name);
  git(repo, 'commit', '-m', `add ${name}`);
  return git(repo, 'rev-parse', 'HEAD');
}
function remoteHas(sha: string): boolean {
  try {
    return git(remote, 'branch', '--contains', sha).includes('main');
  } catch {
    return false; // the remote does not have the commit at all
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-sync-'));
  remote = path.join(tmp, 'remote.git');
  checkout = path.join(tmp, 'checkout');
  other = path.join(tmp, 'other');
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], {
    stdio: 'ignore',
  });
  git(tmp, 'clone', '-q', remote, checkout);
  // The agent sets its identity in the checkout (groups/global/CLAUDE.md).
  git(checkout, 'config', 'user.name', 'Coordinator');
  git(checkout, 'config', 'user.email', 'program-bot@example.org');
  git(checkout, 'checkout', '-q', '-b', 'main');
  commitFile(checkout, 'README.md', 'start\n');
  git(checkout, 'push', '-q', '-u', 'origin', 'main');
  git(tmp, 'clone', '-q', remote, other);
  vi.stubEnv('PROGRAM_REPO', checkout);
});

afterEach(() => {
  setCheckoutPushAlerter(null);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pushCheckoutAfterTurn', () => {
  it('puts a commit made in the checkout on the remote', async () => {
    const sha = commitFile(checkout, 'decision.md', 'agent wrote this\n');
    expect(remoteHas(sha)).toBe(false);
    expect(await pushCheckoutAfterTurn()).toBe('pushed');
    expect(git(remote, 'rev-parse', 'main')).toBe(sha);
  });

  it('does nothing, and runs no push, when the checkout has no new commit', async () => {
    const calls: string[][] = [];
    const outcome = await pushCheckoutAfterTurn(async (args) => {
      calls.push(args);
      return execFileSync('git', args, { cwd: checkout, encoding: 'utf8' });
    });
    expect(outcome).toBe('nothing');
    expect(calls).toEqual([['rev-list', '--count', '@{upstream}..HEAD']]);
  });

  it('when a person pushed first, rebases the agent commit on top and pushes', async () => {
    const theirs = commitFile(other, 'human.md', 'a person wrote this\n');
    git(other, 'push', '-q', 'origin', 'main');
    commitFile(checkout, 'decision.md', 'agent wrote this\n');
    // An uncommitted audit-log line, as the host always has.
    fs.writeFileSync(path.join(checkout, 'audit.md'), 'pending\n');

    expect(await pushCheckoutAfterTurn()).toBe('pushed');
    const log = git(remote, 'log', '--format=%s', 'main');
    expect(log.split('\n')).toEqual([
      'add decision.md',
      'add human.md',
      'add README.md',
    ]);
    expect(remoteHas(theirs)).toBe(true);
    expect(fs.readFileSync(path.join(checkout, 'audit.md'), 'utf8')).toBe(
      'pending\n',
    );
  });

  it('reports a failed push to the operator once per unpushed HEAD', async () => {
    const alerts: string[] = [];
    setCheckoutPushAlerter(async (text) => {
      alerts.push(text);
    });
    const sha = commitFile(checkout, 'decision.md', 'agent wrote this\n');
    fs.renameSync(remote, `${remote}.gone`);

    expect(await pushCheckoutAfterTurn()).toBe('failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('Knowledge-base push failed');
    expect(alerts[0]).toContain(sha.slice(0, 12));

    // Same HEAD, still failing: no second alert.
    expect(await pushCheckoutAfterTurn()).toBe('failed');
    expect(alerts).toHaveLength(1);

    // A new commit that also cannot be pushed alerts again.
    commitFile(checkout, 'second.md', 'more\n');
    expect(await pushCheckoutAfterTurn()).toBe('failed');
    expect(alerts).toHaveLength(2);

    // The remote is back: the commits go out and nothing is left behind.
    fs.renameSync(`${remote}.gone`, remote);
    expect(await pushCheckoutAfterTurn()).toBe('pushed');
    expect(remoteHas(sha)).toBe(true);
    expect(alerts).toHaveLength(2);
  });

  it('leaves the working tree clean of a half-done rebase when it fails', async () => {
    const r: string[][] = [];
    await expect(
      runCheckoutPush(async (args) => {
        r.push(args);
        if (args[0] === 'push' || args[0] === 'pull') throw new Error('no');
        return '';
      }),
    ).rejects.toThrow();
    expect(r).toEqual([
      ['push'],
      ['pull', '--rebase', '--autostash'],
      ['rebase', '--abort'],
    ]);
  });

  it('alerts once, not on every turn, when the branch has no upstream', async () => {
    const alerts: string[] = [];
    setCheckoutPushAlerter(async (text) => {
      alerts.push(text);
    });
    git(checkout, 'branch', '--unset-upstream');
    commitFile(checkout, 'decision.md', 'agent wrote this\n');
    expect(await pushCheckoutAfterTurn()).toBe('failed');
    expect(await pushCheckoutAfterTurn()).toBe('failed');
    expect(alerts).toHaveLength(1);
  });

  it('is skipped where there is no checkout', async () => {
    vi.stubEnv('PROGRAM_REPO', path.join(tmp, 'missing'));
    expect(await pushCheckoutAfterTurn()).toBe('skipped');
    expect(await syncCheckoutBeforeTurn()).toBe('skipped');
  });
});

describe('syncCheckoutBeforeTurn', () => {
  it('brings in what a person pushed', async () => {
    const theirs = commitFile(other, 'human.md', 'a person wrote this\n');
    git(other, 'push', '-q', 'origin', 'main');
    expect(await syncCheckoutBeforeTurn()).toBe('pulled');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(theirs);
  });

  it('fails without touching local work when the histories diverged', async () => {
    commitFile(other, 'human.md', 'a person wrote this\n');
    git(other, 'push', '-q', 'origin', 'main');
    const mine = commitFile(checkout, 'decision.md', 'agent wrote this\n');
    expect(await syncCheckoutBeforeTurn()).toBe('failed');
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(mine);
    expect(git(checkout, 'status', '--porcelain')).toBe('');
  });
});
