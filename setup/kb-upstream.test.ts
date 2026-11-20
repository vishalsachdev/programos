import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  syncFromUpstream,
  upstreamConfig,
} from '../container/agent-runner/src/kb-upstream.js';

// What runs INSIDE the container: git there pulls the checkout from the
// host's read-only export. Real git; the "container" is a temp HOME.

let root: string;
let home: string;
let upstream: string;
let checkout: string;
const ORIGIN_URL = 'git@git.example.org:team/kb.git';

function env(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.org',
    GIT_COMMITTER_NAME: 'Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.org',
    GIT_TERMINAL_PROMPT: '0',
  };
}

const run = (args: string[], cwd?: string) =>
  execFileSync('git', args, {
    cwd: cwd ?? root,
    env: env(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function commitUpstream(file: string, text: string): void {
  const work = path.join(root, 'work');
  if (!fs.existsSync(work)) run(['clone', '-q', upstream, work]);
  run(['pull', '-q', 'origin', 'main'], work);
  fs.writeFileSync(path.join(work, file), text);
  run(['add', '-A'], work);
  run(['commit', '-q', '-m', `host: ${file}`], work);
  run(['push', '-q', 'origin', 'main'], work);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-up-')));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  upstream = path.join(root, 'kb-upstream.git');
  checkout = path.join(root, 'checkout');
  run(['init', '-q', '--bare', upstream]);
  run(['symbolic-ref', 'HEAD', 'refs/heads/main'], upstream);
  const seed = path.join(root, 'seed');
  run(['init', '-q', seed]);
  run(['symbolic-ref', 'HEAD', 'refs/heads/main'], seed);
  fs.writeFileSync(path.join(seed, 'a.md'), 'one\n');
  run(['add', '-A'], seed);
  run(['commit', '-q', '-m', 'seed'], seed);
  run(['push', '-q', upstream, 'main'], seed);
  run(['clone', '-q', upstream, checkout]);
  // The checkout's origin is the real remote, which the container cannot reach.
  run(['remote', 'set-url', 'origin', ORIGIN_URL], checkout);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const sync = () =>
  syncFromUpstream({ KB_UPSTREAM_REPO: upstream, KB_CHECKOUT: checkout }, run);

describe('syncFromUpstream (inside the container)', () => {
  it('does nothing without the two variables or the mounts', () => {
    expect(syncFromUpstream({}, run)).toBe('skipped');
    expect(
      syncFromUpstream(
        { KB_UPSTREAM_REPO: path.join(root, 'missing'), KB_CHECKOUT: checkout },
        run,
      ),
    ).toBe('skipped');
  });

  it('fast-forwards the checkout to what the host exported', () => {
    commitUpstream('b.md', 'from the host\n');
    expect(sync()).toBe('pulled');
    expect(fs.readFileSync(path.join(checkout, 'b.md'), 'utf8')).toBe(
      'from the host\n',
    );
    expect(run(['status', '--porcelain', '--branch'], checkout)).toBe(
      '## main...origin/main\n',
    );
  });

  it('keeps local commits and uncommitted changes, rebased on top', () => {
    fs.writeFileSync(path.join(checkout, 'local.md'), 'agent\n');
    run(['add', '-A'], checkout);
    run(['commit', '-q', '-m', 'agent: local'], checkout);
    fs.writeFileSync(path.join(checkout, 'a.md'), 'one\nuncommitted\n');
    commitUpstream('b.md', 'from the host\n');
    expect(sync()).toBe('pulled');
    expect(run(['log', '--format=%s'], checkout).trim().split('\n')).toEqual([
      'agent: local',
      'host: b.md',
      'seed',
    ]);
    expect(fs.readFileSync(path.join(checkout, 'a.md'), 'utf8')).toBe(
      'one\nuncommitted\n',
    );
  });

  it('drops a local commit that the host already pushed in rebased form', () => {
    fs.writeFileSync(path.join(checkout, 'local.md'), 'agent\n');
    run(['add', '-A'], checkout);
    run(['commit', '-q', '-m', 'agent: local'], checkout);
    // The host replayed the same change on top of someone else's commit.
    commitUpstream('b.md', 'someone else\n');
    commitUpstream('local.md', 'agent\n');
    expect(sync()).toBe('pulled');
    expect(run(['rev-parse', 'HEAD'], checkout)).toBe(
      run(['rev-parse', 'main'], upstream),
    );
  });

  it('on a conflict, leaves the checkout as it was and reports the failure', () => {
    fs.writeFileSync(path.join(checkout, 'a.md'), 'agent version\n');
    run(['commit', '-q', '-am', 'agent: a'], checkout);
    const before = run(['rev-parse', 'HEAD'], checkout);
    commitUpstream('a.md', 'host version\n');
    expect(sync()).toBe('failed');
    expect(run(['rev-parse', 'HEAD'], checkout)).toBe(before);
    expect(run(['status', '--porcelain'], checkout)).toBe('');
    expect(fs.existsSync(path.join(checkout, '.git', 'rebase-merge'))).toBe(
      false,
    );
  });

  it("points the agent's own `git pull` at the export, and leaves `git push` and the checkout's config alone", () => {
    const configBefore = fs.readFileSync(
      path.join(checkout, '.git', 'config'),
      'utf8',
    );
    sync();
    commitUpstream('c.md', 'later\n');
    // What the prompts tell the agent to run.
    run(['pull', '-q'], checkout);
    expect(fs.existsSync(path.join(checkout, 'c.md'))).toBe(true);
    expect(run(['remote', 'get-url', 'origin'], checkout).trim()).toBe(
      upstream,
    );
    expect(
      run(['remote', 'get-url', '--push', 'origin'], checkout).trim(),
    ).toBe(ORIGIN_URL);
    expect(fs.readFileSync(path.join(checkout, '.git', 'config'), 'utf8')).toBe(
      configBefore,
    );
  });

  it('leaves another branch alone', () => {
    run(['checkout', '-q', '-b', 'side'], checkout);
    commitUpstream('b.md', 'from the host\n');
    expect(sync()).toBe('skipped');
    expect(fs.existsSync(path.join(checkout, 'b.md'))).toBe(false);
  });

  it('builds the rewrite only when the checkout has a different origin', () => {
    expect(upstreamConfig('/up.git', '')).toEqual([
      ['safe.directory', '/up.git'],
    ]);
    expect(upstreamConfig('/up.git', '/up.git')).toHaveLength(1);
    expect(upstreamConfig('/up.git', ORIGIN_URL)).toEqual([
      ['safe.directory', '/up.git'],
      ['url./up.git.insteadOf', ORIGIN_URL],
      [`url.${ORIGIN_URL}.pushInsteadOf`, ORIGIN_URL],
    ]);
  });
});
