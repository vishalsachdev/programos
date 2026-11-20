/**
 * Keep the program-repo checkout current from the host's export.
 *
 * The host does not run git in the checkout (the agent can write its
 * .git/config and hooks, and git obeys both). Instead the host mounts a
 * read-only export of its own repository at KB_UPSTREAM_REPO, and git runs
 * here, inside the container, with the container's privileges:
 *
 *   - `git pull` in the checkout is pointed at the export, for the whole
 *     session, through this container's own git config. The checkout's
 *     config is not changed. `git push` keeps its real address.
 *   - one pull runs before the agent starts, so the agent reads the current
 *     state. It fast-forwards; local commits are rebased on top. If it
 *     fails, the agent starts on the state it has.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';

/** Reads KB_UPSTREAM_REPO and KB_CHECKOUT, which the host sets. */
export type KbUpstreamEnv = Record<string, string | undefined>;

type Run = (args: string[], cwd?: string) => string;

const defaultRun: Run = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Git config entries (key, value) that point pulls at the export. */
export function upstreamConfig(
  upstream: string,
  originUrl: string,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [['safe.directory', upstream]];
  if (originUrl && originUrl !== upstream) {
    entries.push([`url.${upstream}.insteadOf`, originUrl]);
    // Without this the rewrite above would also send pushes to the export.
    entries.push([`url.${originUrl}.pushInsteadOf`, originUrl]);
  }
  return entries;
}

/**
 * Returns what happened, for the container log. Never throws: a stale
 * checkout is not a reason to drop the turn.
 */
export function syncFromUpstream(
  env: KbUpstreamEnv = process.env,
  run: Run = defaultRun,
  exists: (p: string) => boolean = fs.existsSync,
): 'skipped' | 'pulled' | 'failed' {
  const upstream = env.KB_UPSTREAM_REPO;
  const checkout = env.KB_CHECKOUT;
  if (!upstream || !checkout || !exists(upstream) || !exists(checkout))
    return 'skipped';
  try {
    let originUrl = '';
    try {
      originUrl = run(
        ['config', '--get', 'remote.origin.url'],
        checkout,
      ).trim();
    } catch {
      /* no origin: the explicit pull below still works */
    }
    for (const [key, value] of upstreamConfig(upstream, originUrl))
      run([
        'config',
        '--global',
        key === 'safe.directory' ? '--add' : '--replace-all',
        key,
        value,
      ]);
    // Only the branch the host moves. On any other branch the agent pulls
    // when it chooses to.
    let branch = '';
    try {
      branch = run(['symbolic-ref', '--short', '-q', 'HEAD'], checkout).trim();
    } catch {
      /* detached HEAD */
    }
    if (branch !== 'main') return 'skipped';
    try {
      run(['pull', '--rebase', '--autostash', upstream, 'main'], checkout);
    } catch (err) {
      try {
        run(['rebase', '--abort'], checkout);
      } catch {
        /* no rebase in progress */
      }
      throw err;
    }
    try {
      // So `git status` compares with what was just pulled.
      run(['fetch', '--quiet', 'origin'], checkout);
    } catch {
      /* cosmetic */
    }
    return 'pulled';
  } catch {
    return 'failed';
  }
}
