import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'state-snapshot-pull.sh');

// Sandboxed HOME: the script touches $HOME/.cron-sentinels, and the user's
// global git config (rerere, pull.rebase) must not leak into the fixture.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

const SNAPSHOT =
  JSON.stringify({ scheduled_tasks: [{ id: 'task-1' }] }, null, 2) + '\n';

let sandbox: string;

afterEach(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true });
});

function env(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: home, ...IDENTITY };
}

function git(home: string, cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: env(home), encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function sentinel(home: string): string {
  return join(home, '.cron-sentinels', 'nanoclaw-state-snapshot');
}

/** A work clone with one pushed base commit on main. */
function baseRepo() {
  sandbox = mkdtempSync(join(tmpdir(), 'state-snapshot-pull-'));
  const home = join(sandbox, 'home');
  const origin = join(sandbox, 'origin.git');
  const work = join(sandbox, 'work');
  mkdirSync(home);

  git(home, sandbox, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(home, sandbox, 'init', '--quiet', '-b', 'main', work);
  writeFileSync(join(work, 'notes.md'), 'base\n');
  git(home, work, 'add', 'notes.md');
  git(home, work, 'commit', '--quiet', '-m', 'base');
  git(home, work, 'remote', 'add', 'origin', origin);
  // Stands in for a global pull.rebase=true, which the sandboxed HOME hides.
  git(home, work, 'config', 'pull.rebase', 'true');
  git(home, work, 'push', '--quiet', '-u', 'origin', 'main');
  return { home, origin, work };
}

/**
 * Shape under test: local main holds an unpushed merge commit plus a
 * commit that conflicts with one pushed to origin meanwhile.
 */
function divergedRepo() {
  const { home, work } = baseRepo();
  const other = join(sandbox, 'other');

  git(home, work, 'checkout', '--quiet', '-b', 'side');
  writeFileSync(join(work, 'side.md'), 'side\n');
  git(home, work, 'add', 'side.md');
  git(home, work, 'commit', '--quiet', '-m', 'side');
  git(home, work, 'checkout', '--quiet', 'main');
  git(home, work, 'merge', '--quiet', '--no-ff', '-m', 'merge side', 'side');
  writeFileSync(join(work, 'notes.md'), 'local\n');
  git(home, work, 'commit', '--quiet', '-am', 'local edit');

  git(home, sandbox, 'clone', '--quiet', join(sandbox, 'origin.git'), other);
  writeFileSync(join(other, 'notes.md'), 'remote\n');
  git(home, other, 'commit', '--quiet', '-am', 'remote edit');
  git(home, other, 'push', '--quiet', 'origin', 'main');

  return { home, work };
}

/**
 * An earlier run committed the snapshot but its push failed, so local main
 * is one snapshot commit ahead; today's snapshot is byte-identical.
 */
function strandedSnapshotRepo(pushWorks: boolean) {
  const { home, origin, work } = baseRepo();
  mkdirSync(join(work, 'ops', 'state-snapshot'), { recursive: true });
  writeFileSync(join(work, 'ops', 'state-snapshot', 'db-state.json'), SNAPSHOT);
  git(home, work, 'add', 'ops/state-snapshot/db-state.json');
  git(home, work, 'commit', '--quiet', '-m', 'ops: state snapshot 2026-09-10');
  if (!pushWorks) {
    git(
      home,
      work,
      'remote',
      'set-url',
      '--push',
      'origin',
      '/nonexistent.git',
    );
  }
  const fixture = join(sandbox, 'snapshot.json');
  writeFileSync(fixture, SNAPSHOT);
  return { home, origin, work, fixture };
}

function runScript(home: string, work: string, fixture?: string) {
  return spawnSync('bash', [SCRIPT], {
    env: {
      ...env(home),
      STATE_SNAPSHOT_REPO: work,
      ...(fixture ? { STATE_SNAPSHOT_CMD: `cat '${fixture}'` } : {}),
    },
    encoding: 'utf-8',
  });
}

describe('state-snapshot-pull.sh', () => {
  it('refuses a diverged main without rebasing, and leaves the sentinel stale', () => {
    const { home, work } = divergedRepo();
    const headBefore = git(home, work, 'rev-parse', 'HEAD');

    const result = runScript(home, work);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot fast-forward/);
    expect(git(home, work, 'branch', '--show-current')).toBe('main');
    expect(git(home, work, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(home, work, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(work, '.git', 'rebase-merge'))).toBe(false);
    expect(existsSync(join(work, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(existsSync(sentinel(home))).toBe(false);
  });

  it('fails without refreshing the sentinel when an earlier snapshot commit never reached origin', () => {
    const { home, work, fixture } = strandedSnapshotRepo(false);

    const result = runScript(home, work, fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not on origin/);
    expect(existsSync(sentinel(home))).toBe(false);
  });

  it('publishes a stranded snapshot commit before refreshing the sentinel', () => {
    const { home, origin, work, fixture } = strandedSnapshotRepo(true);
    const localHead = git(home, work, 'rev-parse', 'HEAD');

    const result = runScript(home, work, fixture);

    expect(result.status).toBe(0);
    expect(git(home, origin, 'rev-parse', 'main')).toBe(localHead);
    expect(existsSync(sentinel(home))).toBe(true);
  });

  it('refuses to publish unpushed non-snapshot commits', () => {
    // Shape under test: local main holds unpushed human work.
    const { home, origin, work } = baseRepo();
    const originBefore = git(home, origin, 'rev-parse', 'main');
    writeFileSync(join(work, 'notes.md'), 'unpushed human work\n');
    git(home, work, 'commit', '--quiet', '-am', 'docs: unpushed work');
    const fixture = join(sandbox, 'snapshot.json');
    writeFileSync(fixture, SNAPSHOT);

    const result = runScript(home, work, fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/non-snapshot/);
    expect(git(home, origin, 'rev-parse', 'main')).toBe(originBefore);
    expect(existsSync(sentinel(home))).toBe(false);
  });

  it('fails closed when listing unpushed commits fails', () => {
    const { home, work } = baseRepo();
    const fixture = join(sandbox, 'snapshot.json');
    writeFileSync(fixture, SNAPSHOT);

    // The snapshot step runs after the pull; losing the upstream ref there
    // makes every later @{u} query fail, which must not read as "nothing".
    const result = runScriptWithCmd(
      home,
      work,
      `git update-ref -d refs/remotes/origin/main && cat '${fixture}'`,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot list commits not on origin/);
    expect(existsSync(sentinel(home))).toBe(false);
  });

  it('fails closed when counting unpushed commits fails after committing', () => {
    const { home, work } = baseRepo();
    const hooks = join(sandbox, 'hooks');
    mkdirSync(hooks);
    // Runs between the snapshot commit and the publish check.
    writeFileSync(
      join(hooks, 'post-commit'),
      '#!/bin/sh\ngit update-ref -d refs/remotes/origin/main\n',
      { mode: 0o755 },
    );
    git(home, work, 'config', 'core.hooksPath', hooks);
    const fixture = join(sandbox, 'snapshot.json');
    writeFileSync(fixture, SNAPSHOT);

    const result = runScript(home, work, fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot count commits not on origin/);
    expect(existsSync(sentinel(home))).toBe(false);
  });
});

function runScriptWithCmd(home: string, work: string, cmd: string) {
  return spawnSync('bash', [SCRIPT], {
    env: { ...env(home), STATE_SNAPSHOT_REPO: work, STATE_SNAPSHOT_CMD: cmd },
    encoding: 'utf-8',
  });
}
