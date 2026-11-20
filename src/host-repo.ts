/**
 * The host-owned copy of the program repo, and the only place where the host
 * runs git with a working tree or a credential.
 *
 * Two trust levels:
 *
 *   host repo   PROGRAM_HOST_REPO (default: "program-repo-host" in the folder
 *               of the read mirror, so /srv/repos/program-repo-host). Not mounted
 *               into any container. It holds the credentialed remote. The
 *               host's own writes (audit log, sensor triage) are files in its
 *               working tree and are committed here. Every fetch from and
 *               push to the real origin runs here.
 *   checkout    PROGRAM_REPO. Mounted read-write into the agent container, so
 *               everything in it, .git included, is data written by the agent.
 *               The host runs no git command with it as the repository. It
 *               moves commits out with a fetch from its path: the source side
 *               is `git upload-pack`, which runs no hook and obeys no
 *               command-valued setting of the repository it serves.
 *               probeUploadPackIsolation() checks that claim against the git
 *               binary on this host before the first import.
 *
 * What comes out of the checkout is checked before it is pushed
 * (checkImported): it must share history with the host's branch, and no new
 * commit may change a protected file. An author address in the checkout
 * proves nothing, so every commit from there counts as not written by an
 * admin.
 *
 * The agent's checkout gets new commits from a read-only export of this repo
 * (exportPaths), mounted into the container; the agent's own git pulls from
 * it there, with the container's privileges. The host never updates the
 * checkout.
 *
 * Git here runs as the checkout owner when the host is root, as before, so
 * the credential an existing deployment uses for pushing keeps working.
 */
import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { protectedGovernanceRule } from './governance-protection.js';
import { BOT_GIT_AUTHOR_EMAIL } from './instance-identity.js';
import {
  hasOriginCredential,
  originCredentialEnv,
  originCredentialProblem,
  redactOriginCredential,
  splitOriginCredential,
} from './origin-credential.js';
import { realPathOfNearestExisting } from './real-path.js';
import { logger } from './logger.js';
import { CHECKOUT_OWNER, getProgramRepoPath } from './program-repo.js';
import {
  isExpectedOrigin,
  mirrorOriginUrl,
  readMirrorPath,
} from './program-origin.js';

/** The one branch the host moves. The read mirror follows the same branch. */
export const KB_BRANCH = 'main';
const BRANCH_REF = `refs/heads/${KB_BRANCH}`;
const ORIGIN_REF = `refs/remotes/origin/${KB_BRANCH}`;
const UNTRUSTED_REF = `refs/untrusted/checkout/${KB_BRANCH}`;

/** Folders of the host repo's working tree that the host writes and commits. */
export const HOST_WRITTEN_DIRS = [
  'discussions/audit-log',
  'discussions/kb-triage',
] as const;

/** Cap for one git step that talks to the origin. */
export const HOST_GIT_NETWORK_TIMEOUT_MS = 30_000;
/** Cap for one local git step. */
export const HOST_GIT_LOCAL_TIMEOUT_MS = 15_000;
/**
 * Cap for one whole sync (commit, fetch, import, push). Past it, the only
 * steps still allowed are the two that undo a rebase (HOST_SYNC_UNDO_MS).
 * Shutdown waits for at most two syncs; pm2-kill-timeout.test.ts ties the
 * process manager's kill timeout to these numbers.
 */
export const HOST_SYNC_BUDGET_MS = 180_000;
export const HOST_SYNC_UNDO_MS = 2 * HOST_GIT_LOCAL_TIMEOUT_MS;

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Where the host-owned repository lives: PROGRAM_HOST_REPO, or by default
 * beside the read mirror, the other host-owned repository (a folder the host
 * user can already write). Read at call time (tests stub it).
 */
export function getHostRepoPath(): string {
  return (
    process.env.PROGRAM_HOST_REPO ||
    path.join(path.dirname(path.resolve(readMirrorPath())), 'program-repo-host')
  );
}

/**
 * The read-only export the container pulls from: a bare repository shell
 * whose only content is the branch tip, plus the host repo's object folder.
 * The host repo's config (which names the origin, and so may hold a token)
 * is in neither.
 */
export function exportPaths(): { repo: string; objects: string } {
  const host = getHostRepoPath();
  return {
    repo: `${host.replace(/\/+$/, '')}-export.git`,
    objects: path.join(host, '.git', 'objects'),
  };
}

/** Container paths of the export; agent-runner reads the two variables. */
export const EXPORT_CONTAINER_REPO = '/workspace/kb-upstream.git';
export const EXPORT_CONTAINER_OBJECTS = '/workspace/kb-upstream-objects';

// ── origin ──────────────────────────────────────────────────────────────

/**
 * True for a URL shape git handles with a built-in transport. A remote
 * helper ("ext::cmd", "fd::3") or a leading dash is refused.
 */
export function isPlainGitUrl(url: string): boolean {
  if (!url || /[\s\0]/.test(url) || url.startsWith('-')) return false;
  if (/^[A-Za-z0-9+.-]+::/.test(url)) return false;
  return (
    /^(https|ssh|file):\/\/[^\s]+$/.test(url) ||
    url.startsWith('/') ||
    /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)
  );
}

/** The last origin read from the settings, as set. For redaction only. */
let lastOriginAsSet = '';

/**
 * The origin as the host's settings give it, credential included. Private to
 * this module: the value may hold a token, so it goes to git's environment
 * (hostGitEnv) and nowhere else.
 */
function originAsSet(): { url: string | null; problem?: string } {
  let url = process.env.PROGRAM_ORIGIN_URL || '';
  let source = 'PROGRAM_ORIGIN_URL';
  if (!url) {
    source = 'the read mirror';
    try {
      url = mirrorOriginUrl();
    } catch {
      url = '';
    }
  }
  if (!url) return { url: null };
  if (!isPlainGitUrl(url))
    return { url: null, problem: `the origin from ${source} is not a git URL` };
  const credentialProblem = originCredentialProblem(url);
  if (credentialProblem) return { url: null, problem: credentialProblem };
  if (process.env.PROGRAM_ORIGIN_PATTERN && !isExpectedOrigin(url))
    return {
      url: null,
      problem: `the origin from ${source} does not match PROGRAM_ORIGIN_PATTERN`,
    };
  lastOriginAsSet = url;
  return { url };
}

/**
 * The origin the host fetches from and pushes to. It comes from the host's
 * own settings only: PROGRAM_ORIGIN_URL, or else the origin of the read
 * mirror (a host-owned repository). Never from the checkout, whose config the
 * agent can write. When PROGRAM_ORIGIN_PATTERN is set the URL as set must
 * match it. Null when the host has no origin (a development run, the tests).
 *
 * The URL returned holds no credential: a user name, password or token
 * written in the setting is taken out (origin-credential.ts), so the value
 * may be stored in the host repo's config, put on a command line or logged.
 * Credentialed git gets the credential through its environment.
 */
export function expectedOriginUrl(): { url: string | null; problem?: string } {
  const origin = originAsSet();
  if (!origin.url) return origin;
  return { url: splitOriginCredential(origin.url).bare };
}

// ── running git ─────────────────────────────────────────────────────────

/**
 * Settings given on every command line. The host repo's own config and the
 * host user's config are trusted; these make the important ones explicit and
 * independent of both.
 */
const FIXED_CONFIG = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.symlinks=false',
  'core.quotePath=false',
  'protocol.ext.allow=never',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'push.recurseSubmodules=no',
  'commit.gpgSign=false',
  'advice.detachedHead=false',
].flatMap((kv) => ['-c', kv]);

/** Variables a credentialed git may need from the host's own environment. */
const CREDENTIAL_ENV = [
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSL_CAINFO',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'XDG_RUNTIME_DIR',
];

export interface HostGitMode {
  /**
   * true: the host user's git config and credentials apply (fetch from and
   * push to the origin). false: no system or user config at all; only the
   * host repo's own config and the fixed settings.
   */
  credentialed: boolean;
}

/**
 * Environment for host git, built from nothing: no GIT_* variable of the host
 * process reaches git, so GIT_DIR, GIT_INDEX_FILE and the like cannot point
 * it elsewhere.
 */
export function hostGitEnv(mode: HostGitMode): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    // Also set by a patched upload-pack itself; harmless elsewhere.
    GIT_NO_LAZY_FETCH: '1',
    GIT_AUTHOR_NAME: 'Coordinator',
    GIT_AUTHOR_EMAIL: BOT_GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: 'Coordinator',
    GIT_COMMITTER_EMAIL: BOT_GIT_AUTHOR_EMAIL,
  };
  if (mode.credentialed) {
    // The checkout owner's home, as before this module existed: that is
    // where an existing deployment keeps the credential it pushes with.
    env.HOME = CHECKOUT_OWNER.home;
    for (const key of CREDENTIAL_ENV)
      if (process.env[key]) env[key] = process.env[key];
    // A credential written in the origin setting: the host repo's config and
    // every command line name the origin without it, and git puts it back
    // from here. Only a process of the same user (or root) can read this.
    Object.assign(env, originCredentialEnv(originAsSet().url));
  } else {
    env.HOME = '/nonexistent';
    env.XDG_CONFIG_HOME = '/nonexistent';
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = '/dev/null';
    env.GIT_ATTR_NOSYSTEM = '1';
  }
  return env;
}

/**
 * execFile options for host git: in the host repo, as the checkout owner
 * when the host is root (never as root), with the environment above.
 */
export function hostGitOptions(
  mode: HostGitMode,
  { isRoot: root }: { isRoot: boolean } = { isRoot: isRoot() },
  cwd = getHostRepoPath(),
  timeout = mode.credentialed
    ? HOST_GIT_NETWORK_TIMEOUT_MS
    : HOST_GIT_LOCAL_TIMEOUT_MS,
): {
  cwd: string;
  uid?: number;
  gid?: number;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
} {
  return {
    cwd,
    env: hostGitEnv(mode),
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    ...(root ? { uid: CHECKOUT_OWNER.uid, gid: CHECKOUT_OWNER.gid } : {}),
  };
}

function spawnOptions(mode: HostGitMode, cwd: string, timeout: number) {
  return hostGitOptions(mode, { isRoot: isRoot() }, cwd, timeout);
}

export interface GitError extends Error {
  stderr?: string;
  code?: number | string | null;
}

/**
 * What git or Node said, for a log line, an alert or a result. Git hides a
 * password in most messages but not in all ("could not read Password for
 * 'https://<user>@host'"), and Node's "Command failed: ..." quotes the whole
 * command line, so every form of the origin's credential is taken out here.
 */
function errorText(err: unknown): string {
  const e = err as GitError;
  return redactOriginCredential(String(e?.stderr || e?.message || err), [
    process.env.PROGRAM_ORIGIN_URL,
    lastOriginAsSet,
  ])
    .trim()
    .slice(0, 500);
}

/** One sync's deadline; each step gets the smaller of its cap and what is left. */
class Budget {
  private readonly end: number;
  constructor(ms: number) {
    this.end = Date.now() + ms;
  }
  step(cap: number): number {
    const left = this.end - Date.now();
    if (left <= 0) throw new Error('host repo sync ran out of time');
    return Math.min(cap, left);
  }
}

function gitAsync(
  args: string[],
  mode: HostGitMode,
  timeout: number,
  cwd = getHostRepoPath(),
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      [...FIXED_CONFIG, ...args],
      spawnOptions(mode, cwd, timeout),
      (err, stdout, stderr) =>
        err
          ? reject(Object.assign(err, { stderr: String(stderr) }))
          : resolve(String(stdout)),
    );
  });
}

function gitSync(
  args: string[],
  mode: HostGitMode = { credentialed: false },
  cwd = getHostRepoPath(),
): string {
  return execFileSync('git', [...FIXED_CONFIG, ...args], {
    ...spawnOptions(mode, cwd, HOST_GIT_LOCAL_TIMEOUT_MS),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const LOCAL: HostGitMode = { credentialed: false };
const REMOTE: HostGitMode = { credentialed: true };

// ── creating the host repo ──────────────────────────────────────────────

function inside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Why the host repo's location is unsafe, or null. It must not be reachable
 * through the one mount the host knows the agent can write: the checkout.
 * (mount-security.ts separately refuses to mount the host repo or its export
 * as an extra mount.)
 */
export function hostRepoPlacementProblem(): string | null {
  const host = getHostRepoPath();
  const checkout = getProgramRepoPath();
  if (!path.isAbsolute(host)) return 'PROGRAM_HOST_REPO must be absolute';
  if (inside(checkout, host) || inside(host, checkout))
    return 'PROGRAM_HOST_REPO and PROGRAM_REPO must not contain each other';
  return hostRepoLinkProblem(host, checkout);
}

/**
 * A PROGRAM_HOST_REPO that is a symbolic link (or sits below one). The host
 * works in the folder the link leads to, so that folder is the one that has
 * to be safe: outside the agent's checkout and outside the project folder
 * (both are mounted into a container), a folder, and owned by the user the
 * host runs as (or, for a host that runs as root, by the user it hands the
 * repositories to). Null when the path holds no link, or the link leads to
 * such a folder.
 */
function hostRepoLinkProblem(host: string, checkout: string): string | null {
  // The nearest existing folder decides: at the first start the repo's own
  // folder is not there yet, and a link above it must still be seen.
  const real = realPathOfNearestExisting(host);
  if (real === path.resolve(host)) return null;
  const realCheckout = realPathOfNearestExisting(checkout);
  if (inside(realCheckout, real) || inside(real, realCheckout))
    return `PROGRAM_HOST_REPO leads through a symbolic link to ${real}, which is inside PROGRAM_REPO or contains it. The agent can write there`;
  if (inside(realPathOfNearestExisting(process.cwd()), real))
    return `PROGRAM_HOST_REPO leads through a symbolic link to ${real}, inside the project folder, which the main group's container can read`;
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    // Nothing there yet: the host creates it, as its own.
    return null;
  }
  if (!st.isDirectory())
    return `PROGRAM_HOST_REPO leads through a symbolic link to ${real}, which is not a folder`;
  const uid = process.getuid?.();
  if (
    uid !== undefined &&
    st.uid !== uid &&
    !(uid === 0 && st.uid === CHECKOUT_OWNER.uid)
  )
    return `PROGRAM_HOST_REPO leads through a symbolic link to ${real}, which belongs to another user. Point the setting at a folder the host's user owns`;
  return null;
}

/** Paths no container may mount read-write: the host repo and its export. */
export function hostOwnedGitPaths(): string[] {
  return [getHostRepoPath(), exportPaths().repo, readMirrorPath()];
}

function mkdirOwned(dir: string): void {
  if (fs.existsSync(dir)) return;
  fs.mkdirSync(dir, { recursive: true });
  if (isRoot()) fs.chownSync(dir, CHECKOUT_OWNER.uid, CHECKOUT_OWNER.gid);
}

/** Set the mode of a path the host owns; a failure is logged, not thrown. */
function makePrivate(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    logger.error(
      { err: errorText(err), path: target },
      'Host repo: could not make this path private to its owner',
    );
  }
}

/** Host repos already made private and checked by this process. */
const securedHostRepos = new Set<string>();

/**
 * Make the host repo private to its owner and take any credential out of its
 * stored origin. Runs once per process for a repo that exists, so the first
 * start after an upgrade repairs a repo made by an earlier version:
 *
 *  - the folder becomes mode 0700 and `.git/config` 0600 (an earlier version
 *    created them 0755 and 0644 under the usual umask, and the config could
 *    hold the origin's token);
 *  - a `remote.origin.url` with a user name, password or token is rewritten
 *    without it. The credential now reaches git through its environment.
 *
 * The container is not affected: it mounts `.git/objects` and the export,
 * never this folder or its config. A failure here is logged and is not
 * fatal; the sync's own check (ensureOriginRemote) repeats the rewrite.
 */
function secureHostRepo(): void {
  const host = getHostRepoPath();
  if (securedHostRepos.has(host)) return;
  // The folder the path leads to: a PROGRAM_HOST_REPO that is a symbolic
  // link is repaired at its target, which the placement check
  // (hostRepoLinkProblem) has accepted as the host's own.
  const real = realOrResolved(host);
  const targets: Array<[string, number]> = [
    [real, 0o700],
    [path.join(real, '.git', 'config'), 0o600],
  ];
  try {
    for (const [target, mode] of targets) {
      const st = fs.lstatSync(target);
      if (st.isSymbolicLink()) {
        // Only `.git/config` can be one here. Its mode is the mode of
        // whatever it points at, which is not this host's to change.
        logger.error(
          { path: target },
          'Host repo: this path is a symbolic link, so its permissions were not checked. Replace it with a regular file',
        );
        continue;
      }
      if ((st.mode & 0o077) === 0) continue;
      fs.chmodSync(target, mode);
      logger.warn(
        { path: target, was: (st.mode & 0o777).toString(8) },
        'Host repo: was readable by other users of this machine; now private to its owner',
      );
    }
    let stored = '';
    try {
      stored = gitSync(['config', '--get', 'remote.origin.url']).trim();
    } catch {
      /* no origin stored yet */
    }
    if (hasOriginCredential(stored)) {
      gitSync([
        'config',
        'remote.origin.url',
        splitOriginCredential(stored).bare,
      ]);
      logger.warn(
        { host },
        'Host repo: the stored origin URL held a credential; it was rewritten without it. ' +
          'The credential is now read from the origin setting at each fetch and push. ' +
          'Treat the old token as exposed if other people have accounts on this machine, and replace it.',
      );
    }
    securedHostRepos.add(host);
  } catch (err) {
    logger.error(
      { err: errorText(err), host },
      'Host repo: could not make the repository private or check its stored origin',
    );
  }
}

function writeOwned(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  if (isRoot()) fs.chownSync(tmp, CHECKOUT_OWNER.uid, CHECKOUT_OWNER.gid);
  fs.renameSync(tmp, file);
}

function hostRepoExists(): boolean {
  return fs.existsSync(path.join(getHostRepoPath(), '.git', 'HEAD'));
}

function refSha(ref: string): string | null {
  try {
    return gitSync(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
      .trim()
      .toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Create the host repo if it is missing. Local and synchronous (no network),
 * so the first audit write of a fresh process can call it. The history is
 * seeded from the read mirror when there is one: a host-owned full copy, so
 * an existing deployment needs no network and no operator step here.
 * Never reads the checkout.
 */
export function ensureHostRepo(): void {
  // Checked on every call, also for a repo that exists: with a wrong setting
  // "the host repo" could be the agent's checkout itself.
  const problem = hostRepoPlacementProblem();
  if (problem) throw new Error(`host repo refused: ${problem}`);
  if (hostRepoExists()) {
    secureHostRepo();
    return;
  }
  const host = getHostRepoPath();
  // A test fixture may provide a bare ".git" folder with nothing in it.
  if (fs.existsSync(path.join(host, '.git'))) return;
  mkdirOwned(host);
  // Private from the first moment, whatever the umask: git creates the
  // config inside a folder no other user can enter.
  makePrivate(host, 0o700);
  gitSync(['init', '-q', '--template=', host], LOCAL, host);
  makePrivate(path.join(host, '.git', 'config'), 0o600);
  gitSync(['symbolic-ref', 'HEAD', BRANCH_REF]);
  for (const [key, value] of [
    ['core.symlinks', 'false'],
    ['core.sparseCheckout', 'true'],
    ['core.sparseCheckoutCone', 'false'],
  ])
    gitSync(['config', key, value]);
  const info = path.join(host, '.git', 'info');
  mkdirOwned(info);
  // Only the folders the host writes are ever files on the host's disk.
  writeOwned(
    path.join(info, 'sparse-checkout'),
    HOST_WRITTEN_DIRS.map((d) => `/${d}/\n`).join(''),
  );
  // Highest-precedence attributes: nothing a commit puts in .gitattributes
  // can turn on a conversion or a filter for the host's working tree.
  writeOwned(
    path.join(info, 'attributes'),
    '* -text -filter -ident -working-tree-encoding\n',
  );
  const mirror = readMirrorPath();
  if (fs.existsSync(path.join(mirror, 'HEAD'))) {
    try {
      gitSync([
        '-c',
        'protocol.file.allow=always',
        'fetch',
        '-q',
        '--no-tags',
        '--no-write-fetch-head',
        '--',
        `file://${path.resolve(mirror)}`,
        `+${BRANCH_REF}:${ORIGIN_REF}`,
      ]);
      adoptOriginIfUnborn();
    } catch (err) {
      logger.warn(
        { err: errorText(err), mirror },
        'Host repo: could not seed from the read mirror; the first fetch will',
      );
    }
  }
  ensureExport();
  logger.info({ host }, 'Host repo: created');
}

/**
 * First adoption of the origin's branch by a host repo that has no commit
 * yet. Files the host wrote before this moment (audit entries of a first
 * start without network) are kept: each is appended to the origin's version.
 */
function adoptOriginIfUnborn(): boolean {
  if (refSha(BRANCH_REF) || !refSha(ORIGIN_REF)) return false;
  const host = getHostRepoPath();
  const aside = path.join(host, `.pre-adopt-${process.pid}`);
  const kept: Array<{ rel: string; text: Buffer }> = [];
  for (const dir of HOST_WRITTEN_DIRS) {
    const abs = path.join(host, dir);
    if (!fs.existsSync(abs)) continue;
    for (const name of fs.readdirSync(abs)) {
      const file = path.join(abs, name);
      if (fs.lstatSync(file).isFile())
        kept.push({ rel: path.join(dir, name), text: fs.readFileSync(file) });
    }
  }
  if (kept.length) {
    fs.renameSync(path.join(host, 'discussions'), aside);
  }
  gitSync(['update-ref', BRANCH_REF, ORIGIN_REF]);
  gitSync(['reset', '-q', '--hard']);
  for (const { rel, text } of kept) {
    const target = path.join(host, rel);
    mkdirOwned(path.dirname(target));
    const fd = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW,
      0o644,
    );
    try {
      fs.writeSync(fd, text);
      if (isRoot()) fs.fchownSync(fd, CHECKOUT_OWNER.uid, CHECKOUT_OWNER.gid);
    } finally {
      fs.closeSync(fd);
    }
  }
  fs.rmSync(aside, { recursive: true, force: true });
  return true;
}

/** Create or refresh the export shell and point it at the host's branch tip. */
export function ensureExport(): void {
  const { repo } = exportPaths();
  for (const dir of [
    repo,
    path.join(repo, 'objects'),
    path.join(repo, 'objects', 'info'),
    path.join(repo, 'refs'),
    path.join(repo, 'refs', 'heads'),
  ])
    mkdirOwned(dir);
  const files: Array<[string, string]> = [
    ['HEAD', `ref: ${BRANCH_REF}\n`],
    ['config', '[core]\n\trepositoryformatversion = 0\n\tbare = true\n'],
    // A container path: the export is only ever used inside the container.
    ['objects/info/alternates', `${EXPORT_CONTAINER_OBJECTS}\n`],
  ];
  for (const [rel, content] of files) {
    const file = path.join(repo, rel);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content)
      writeOwned(file, content);
  }
  const sha = hostRepoExists() ? refSha(BRANCH_REF) : null;
  const tipFile = path.join(repo, 'refs', 'heads', KB_BRANCH);
  if (sha) writeOwned(tipFile, `${sha}\n`);
}

// ── container mounts ────────────────────────────────────────────────────

export interface MountLike {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Drop any extra mount that contains, or sits inside, a host-owned git
 * repository (the host repo, its export, the read mirror). Those hold the
 * credentialed remote; a container must never get one, in any mode.
 */
export function withoutHostOwnedGitPaths<T extends MountLike>(
  mounts: T[],
  groupName = '',
): T[] {
  const owned = hostOwnedGitPaths().map(realOrResolved);
  return mounts.filter((m) => {
    const mount = realOrResolved(m.hostPath);
    const hit = owned.some((o) => inside(o, mount) || inside(mount, o));
    if (hit)
      logger.error(
        { group: groupName, hostPath: m.hostPath },
        'Mount refused: it would expose a host-owned git repository',
      );
    return !hit;
  });
}

/** The mount that is the program-repo checkout, when it is writable. */
function writableCheckoutMount<T extends MountLike>(
  mounts: T[],
): T | undefined {
  const checkout = realOrResolved(getProgramRepoPath());
  return mounts.find(
    (m) => !m.readonly && realOrResolved(m.hostPath) === checkout,
  );
}

/**
 * Read-only mounts of the export, for a container that has the checkout
 * writable. The container's own git pulls new commits from there
 * (container/agent-runner/src/kb-upstream.ts).
 */
export function exportMountsFor(mounts: MountLike[]): MountLike[] {
  if (!writableCheckoutMount(mounts)) return [];
  try {
    ensureHostRepo();
    ensureExport();
  } catch (err) {
    logger.warn(
      { err: errorText(err) },
      'Host repo: the export for the container is not available',
    );
    return [];
  }
  const { repo, objects } = exportPaths();
  if (!fs.existsSync(repo) || !fs.existsSync(objects)) return [];
  return [
    { hostPath: repo, containerPath: EXPORT_CONTAINER_REPO, readonly: true },
    {
      hostPath: objects,
      containerPath: EXPORT_CONTAINER_OBJECTS,
      readonly: true,
    },
  ];
}

/** Container environment that goes with exportMountsFor. */
export function exportEnvFor(mounts: MountLike[]): Record<string, string> {
  const checkout = writableCheckoutMount(mounts);
  if (
    !checkout ||
    !mounts.some((m) => m.containerPath === EXPORT_CONTAINER_REPO)
  )
    return {};
  return {
    KB_UPSTREAM_REPO: EXPORT_CONTAINER_REPO,
    KB_CHECKOUT: checkout.containerPath,
  };
}

// ── the upload-pack probe ───────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean;
  gitVersion: string;
  /** What ran although it must not, or why the probe could not finish. */
  fired: string[];
}

let probeCache: ProbeResult | null = null;

/** Test hook: forget the cached probe result. */
export function _resetHostRepoStateForTests(): void {
  probeCache = null;
  securedHostRepos.clear();
  lastOriginAsSet = '';
  alerted.clear();
  alerter = null;
  queue = Promise.resolve();
}

/**
 * Check, with the git binary on this host, that a fetch out of a hostile
 * repository runs nothing that repository names. The probe repository has a
 * canary in every hook, in core.fsmonitor, in uploadpack.packObjectsHook, in
 * core.sshCommand and behind a promisor remote (an old upload-pack fetches a
 * missing object from it, through a transport the repository picks). The
 * result is cached for the life of the process.
 */
export function probeUploadPackIsolation(): ProbeResult {
  if (probeCache) return probeCache;
  let gitVersion = 'unknown';
  const fired: string[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-git-probe-'));
  try {
    if (isRoot()) fs.chownSync(dir, CHECKOUT_OWNER.uid, CHECKOUT_OWNER.gid);
    fs.chmodSync(dir, 0o700);
    const run = (args: string[], cwd: string) => gitSync(args, LOCAL, cwd);
    gitVersion = run(['--version'], dir).trim();
    const canary = path.join(dir, 'canary');
    const script = path.join(dir, 'canary.sh');
    const src = path.join(dir, 'src');
    const evil = path.join(dir, 'evil');
    const sink = path.join(dir, 'sink.git');
    const write = (file: string, text: string, mode = 0o644) => {
      fs.writeFileSync(file, text, { mode });
      if (isRoot()) fs.chownSync(file, CHECKOUT_OWNER.uid, CHECKOUT_OWNER.gid);
    };
    write(script, `#!/bin/sh\necho "$*" >> '${canary}'\n`, 0o755);

    run(['init', '-q', '--template=', src], dir);
    run(['symbolic-ref', 'HEAD', BRANCH_REF], src);
    run(['config', 'uploadpack.allowFilter', 'true'], src);
    write(path.join(src, 'file'), `probe ${Date.now()}\n`);
    run(['add', 'file'], src);
    run(['commit', '-q', '-m', 'probe'], src);
    // A partial clone: the blob is missing, so serving it needs a lazy fetch.
    run(
      [
        '-c',
        'protocol.file.allow=always',
        'clone',
        '-q',
        '--template=',
        '--no-checkout',
        '--filter=blob:none',
        `file://${src}`,
        evil,
      ],
      dir,
    );
    const hooks = path.join(evil, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    if (isRoot()) fs.chownSync(hooks, CHECKOUT_OWNER.uid, CHECKOUT_OWNER.gid);
    for (const hook of [
      'pre-upload-pack',
      'post-upload-pack',
      'reference-transaction',
      'pre-auto-gc',
      'post-index-change',
      'post-checkout',
    ])
      write(
        path.join(hooks, hook),
        `#!/bin/sh\necho "hook:${hook}" >> '${canary}'\n`,
        0o755,
      );
    for (const [key, value] of [
      ['remote.origin.url', `ext::${script} lazy-fetch`],
      ['protocol.ext.allow', 'always'],
      ['core.fsmonitor', `${script} fsmonitor`],
      ['core.sshCommand', `${script} ssh`],
      ['core.alternateRefsCommand', `${script} alternate-refs`],
      ['uploadpack.packObjectsHook', `${script} pack-objects-hook`],
      ['core.hooksPath', hooks],
    ])
      run(['config', key, value], evil);

    run(['init', '-q', '--bare', '--template=', sink], dir);
    try {
      run(
        [
          '-c',
          'protocol.file.allow=always',
          'fetch',
          '-q',
          '--no-tags',
          '--no-write-fetch-head',
          '--',
          `file://${evil}`,
          `+${BRANCH_REF}:refs/probe/x`,
        ],
        sink,
      );
    } catch {
      // Expected on a patched git: the missing blob cannot be served.
    }
    if (fs.existsSync(canary))
      fired.push(
        ...new Set(
          fs
            .readFileSync(canary, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => l.split(' ')[0]),
        ),
      );
  } catch (err) {
    fired.push(`probe could not run: ${errorText(err)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  probeCache = { ok: fired.length === 0, gitVersion, fired };
  if (!probeCache.ok)
    logger.error(
      { ...probeCache },
      'Host repo: this git runs commands named by a repository it only serves. ' +
        'Commits will NOT be taken from the agent checkout. Upgrade git.',
    );
  return probeCache;
}

// ── checks on what came out of the checkout ─────────────────────────────

export type ImportRefusal =
  | 'no-isolation'
  | 'not-a-plain-checkout'
  | 'fetch-failed'
  | 'unrelated-history'
  | 'protected-file'
  | 'host-folder-entry'
  | 'rebase-conflict';

export interface SyncResult {
  /** A commit of host-written files was made in this run. */
  committed: boolean;
  /** Commits from the checkout that joined the host's branch in this run. */
  imported: number;
  /** The origin received the host's branch in this run. */
  pushed: boolean;
  /** Why nothing was taken from the checkout, when that is the case. */
  refused?: { reason: ImportRefusal; detail: string };
  /** A step that failed; the host's commits stay local and are retried. */
  failed?: string;
}

/** The checkout's .git must be a real folder: not a link, not a gitfile. */
function checkoutIsPlain(): boolean {
  try {
    const st = fs.lstatSync(path.join(getProgramRepoPath(), '.git'));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Paths changed by the commits `tip` has and the host does not, as git lists
 * them per commit. `-c` makes a merge list a path only when it differs from
 * every parent, so a clean merge of an admin's change is not blamed and a
 * change made inside a merge commit is.
 */
async function newCommitPaths(
  tip: string,
  budget: Budget,
): Promise<{ commits: number; paths: string[] }> {
  const not = [BRANCH_REF, ...(refSha(ORIGIN_REF) ? [ORIGIN_REF] : [])];
  const range = [tip, '--not', ...not];
  const count = await gitAsync(
    ['rev-list', '--count', ...range],
    LOCAL,
    budget.step(HOST_GIT_LOCAL_TIMEOUT_MS),
  );
  const names = await gitAsync(
    ['log', '--format=', '--name-only', '-z', '--no-renames', '-c', ...range],
    LOCAL,
    budget.step(HOST_GIT_LOCAL_TIMEOUT_MS),
  );
  return {
    commits: parseInt(count, 10) || 0,
    paths: [...new Set(names.split(/[\0\n]/).filter(Boolean))],
  };
}

/**
 * The folders the host writes must be plain folders of plain files in
 * whatever the host checks out. A link or a submodule entry there would end
 * up under the host's own writes. (core.symlinks=false already keeps a link
 * from being created on the host's disk; this keeps the log's files files.)
 */
async function hostFolderProblem(
  tip: string,
  budget: Budget,
): Promise<string | null> {
  const t = () => budget.step(HOST_GIT_LOCAL_TIMEOUT_MS);
  const parents = [
    ...new Set(
      HOST_WRITTEN_DIRS.flatMap((d) =>
        d.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')),
      ),
    ),
  ];
  const lines = async (args: string[]) =>
    (await gitAsync(['ls-tree', '-z', ...args], LOCAL, t()))
      .split('\0')
      .filter(Boolean);
  for (const line of await lines([tip, '--', ...parents]))
    if (!line.startsWith('040000 tree '))
      return `${line.split('\t')[1]} is not a folder`;
  for (const line of await lines(['-r', tip, '--', ...HOST_WRITTEN_DIRS]))
    if (!/^100(644|755) blob /.test(line))
      return `${line.split('\t')[1]} is not a plain file`;
  return null;
}

async function isAncestor(a: string, b: string, budget: Budget) {
  try {
    await gitAsync(
      ['merge-base', '--is-ancestor', a, b],
      LOCAL,
      budget.step(HOST_GIT_LOCAL_TIMEOUT_MS),
    );
    return true;
  } catch (err) {
    if ((err as GitError).code === 1) return false;
    throw err;
  }
}

// ── alerts ──────────────────────────────────────────────────────────────

let alerter: ((text: string) => Promise<void>) | null = null;
const alerted = new Set<string>();

/** Wired at startup to the operator alert channel. */
export function setHostRepoAlerter(
  fn: ((text: string) => Promise<void>) | null,
): void {
  alerter = fn;
  alerted.clear();
}

/** Forget the alerts of one kind once that problem is gone. */
function clearAlerts(prefix: string): void {
  for (const key of alerted) if (key.startsWith(prefix)) alerted.delete(key);
}

/** One alert per stuck state (`key`), not one per retry. */
async function alertOnce(key: string, text: string): Promise<void> {
  if (!alerter || alerted.has(key)) return;
  alerted.add(key);
  await alerter(text).catch((err) =>
    logger.error(
      { err: errorText(err) },
      'Host repo: operator alert was not delivered',
    ),
  );
}

// ── the sync ────────────────────────────────────────────────────────────

let queue: Promise<unknown> = Promise.resolve();

/** Run `fn` after every host repo operation already queued. */
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => {},
    () => {},
  );
  return result;
}

async function ensureOriginRemote(url: string, budget: Budget): Promise<void> {
  const t = () => budget.step(HOST_GIT_LOCAL_TIMEOUT_MS);
  let current = '';
  try {
    current = (
      await gitAsync(['config', '--get', 'remote.origin.url'], LOCAL, t())
    ).trim();
  } catch {
    /* not set yet */
  }
  // `url` holds no credential (expectedOriginUrl), so neither does this
  // command line nor the config it writes. A stored URL that still has one
  // differs from `url` and is replaced here.
  if (current === url) return;
  await gitAsync(['config', 'remote.origin.url', url], LOCAL, t());
  await gitAsync(
    ['config', 'remote.origin.fetch', `+${BRANCH_REF}:${ORIGIN_REF}`],
    LOCAL,
    t(),
  );
}

async function fetchOrigin(budget: Budget): Promise<void> {
  await gitAsync(
    ['fetch', '-q', '--no-tags', '--no-write-fetch-head', 'origin'],
    REMOTE,
    budget.step(HOST_GIT_NETWORK_TIMEOUT_MS),
  );
}

/**
 * Move the host's branch on top of `onto` (the origin's branch, or a checked
 * tip from the checkout that already contains the host's branch). A fast
 * forward when nothing local is ahead; a rebase of the host's unpushed
 * commits otherwise. A file the host is writing at this moment is stashed
 * and put back. On a conflict the rebase is undone and the error thrown.
 */
async function rebaseBranchOnto(onto: string, budget: Budget): Promise<void> {
  try {
    await gitAsync(
      ['rebase', '-q', '--autostash', onto],
      LOCAL,
      budget.step(HOST_GIT_NETWORK_TIMEOUT_MS),
    );
  } catch (err) {
    await gitAsync(
      ['rebase', '--abort'],
      LOCAL,
      HOST_GIT_LOCAL_TIMEOUT_MS,
    ).catch(() => {});
    throw err;
  }
}

async function commitHostWrites(
  count: number,
  budget: Budget,
): Promise<boolean> {
  const host = getHostRepoPath();
  const dirs = HOST_WRITTEN_DIRS.filter((d) =>
    fs.existsSync(path.join(host, d)),
  );
  if (dirs.length === 0) return false;
  const t = () => budget.step(HOST_GIT_LOCAL_TIMEOUT_MS);
  await gitAsync(['add', '-A', '--', ...dirs], LOCAL, t());
  try {
    await gitAsync(['diff', '--cached', '--quiet'], LOCAL, t());
    return false; // nothing staged
  } catch (err) {
    if ((err as GitError).code !== 1) throw err;
  }
  await gitAsync(
    [
      'commit',
      '-q',
      '-m',
      `Audit log: ${count} entries`,
      `--author=Coordinator <${BOT_GIT_AUTHOR_EMAIL}>`,
      '--no-verify',
    ],
    LOCAL,
    t(),
  );
  return true;
}

/**
 * Take the checkout's branch into the host repo and, when it passes the
 * checks, onto the host's branch. Returns the number of commits taken.
 */
async function importFromCheckout(
  budget: Budget,
  refetchOrigin: (() => Promise<void>) | null,
): Promise<{ imported: number; refused?: SyncResult['refused'] }> {
  const checkout = path.resolve(getProgramRepoPath());
  if (!fs.existsSync(path.join(checkout, '.git'))) return { imported: 0 };
  const refuse = (reason: ImportRefusal, detail: string) => ({
    imported: 0,
    refused: { reason, detail },
  });
  if (!checkoutIsPlain())
    return refuse(
      'not-a-plain-checkout',
      'the .git of the checkout is a file or a link, not a folder',
    );
  const probe = probeUploadPackIsolation();
  if (!probe.ok)
    return refuse(
      'no-isolation',
      `${probe.gitVersion} ran: ${probe.fired.join(', ')}`,
    );
  const t = () => budget.step(HOST_GIT_LOCAL_TIMEOUT_MS);
  const base = refSha(BRANCH_REF);
  // With no commit of its own the host has nothing to compare against.
  if (!base) return { imported: 0 };

  try {
    // The source side is `git upload-pack` in the checkout. It is asked for
    // one fixed branch; the checkout's other refs, its tags, its config and
    // its hooks play no part. Objects are verified as they arrive.
    await gitAsync(
      [
        '-c',
        'protocol.file.allow=always',
        '-c',
        'fetch.fsckObjects=true',
        'fetch',
        '-q',
        '--no-tags',
        '--no-write-fetch-head',
        '--no-recurse-submodules',
        '--',
        `file://${checkout}`,
        `+${BRANCH_REF}:${UNTRUSTED_REF}`,
      ],
      LOCAL,
      budget.step(HOST_GIT_NETWORK_TIMEOUT_MS),
    );
  } catch (err) {
    return refuse('fetch-failed', errorText(err));
  }
  const tip = refSha(UNTRUSTED_REF);
  const drop = () =>
    gitAsync(['update-ref', '-d', UNTRUSTED_REF], LOCAL, t()).catch(() => {});
  if (!tip) return refuse('fetch-failed', 'the checkout has no such branch');
  try {
    if (await isAncestor(tip, base, budget)) return { imported: 0 };

    const commonWith = async (rev: string) => {
      try {
        return (await gitAsync(['merge-base', rev, tip], LOCAL, t())).trim();
      } catch {
        return '';
      }
    };
    if (!(await commonWith(base)))
      return refuse(
        'unrelated-history',
        `checkout tip ${tip.slice(0, 12)} shares no commit with the host's branch`,
      );

    let fresh = await newCommitPaths(tip, budget);
    let hits = fresh.paths.filter((p) => protectedGovernanceRule(p));
    if (hits.length && refetchOrigin) {
      // The container may have pulled an admin's commit that the host has
      // not fetched yet. Look again with the origin's current branch.
      await refetchOrigin().catch(() => {});
      fresh = await newCommitPaths(tip, budget);
      hits = fresh.paths.filter((p) => protectedGovernanceRule(p));
    }
    if (hits.length)
      return refuse(
        'protected-file',
        `a commit in the checkout changes ${hits.join(', ')} (tip ${tip.slice(0, 12)})`,
      );
    if (fresh.commits === 0) return { imported: 0 };
    const folderProblem = await hostFolderProblem(tip, budget);
    if (folderProblem)
      return refuse(
        'host-folder-entry',
        `${folderProblem} at checkout tip ${tip.slice(0, 12)}`,
      );

    // The refetch above may have moved the host's branch.
    const head = refSha(BRANCH_REF)!;
    try {
      if (await isAncestor(head, tip, budget)) {
        // The checkout already contains the host's branch: fast-forward.
        await rebaseBranchOnto(tip, budget);
      } else {
        // The host's branch moved (a person pushed, or the host committed).
        // Replay the checkout's own commits on top of it. Commits that are
        // already there in another form come out empty and are dropped.
        await gitAsync(
          [
            'rebase',
            '-q',
            '--autostash',
            '--onto',
            BRANCH_REF,
            await commonWith(head),
            tip,
          ],
          LOCAL,
          budget.step(HOST_GIT_NETWORK_TIMEOUT_MS),
        );
        await gitAsync(['checkout', '-q', '-B', KB_BRANCH], LOCAL, t());
      }
    } catch (err) {
      await gitAsync(
        ['rebase', '--abort'],
        LOCAL,
        HOST_GIT_LOCAL_TIMEOUT_MS,
      ).catch(() => {});
      await gitAsync(
        ['checkout', '-q', KB_BRANCH],
        LOCAL,
        HOST_GIT_LOCAL_TIMEOUT_MS,
      ).catch(() => {});
      return refuse('rebase-conflict', errorText(err));
    }
    const joined = await gitAsync(
      ['rev-list', '--count', `${head}..${BRANCH_REF}`],
      LOCAL,
      t(),
    );
    return { imported: parseInt(joined, 10) || 0 };
  } finally {
    await drop();
  }
}

async function pushBranch(budget: Budget): Promise<void> {
  const push = () =>
    gitAsync(
      [
        'push',
        '-q',
        '--no-verify',
        '--no-recurse-submodules',
        'origin',
        `${BRANCH_REF}:${BRANCH_REF}`,
      ],
      REMOTE,
      budget.step(HOST_GIT_NETWORK_TIMEOUT_MS),
    );
  try {
    await push();
    return;
  } catch {
    // The origin moved (a person pushed, or the mail intake committed):
    // rebase on top of it and push again, as the audit commit always did.
  }
  await fetchOrigin(budget);
  await rebaseBranchOnto(ORIGIN_REF, budget);
  await push();
}

export interface SyncOptions {
  /** Number for the commit subject ("Audit log: N entries"). */
  count?: number;
  /** Fetch the origin first (before a turn). A push fetches when it must. */
  fetchOrigin?: boolean;
}

async function runSync(opts: SyncOptions): Promise<SyncResult> {
  const result: SyncResult = { committed: false, imported: 0, pushed: false };
  const budget = new Budget(HOST_SYNC_BUDGET_MS);
  ensureHostRepo();
  const host = getHostRepoPath();
  // A fixture folder with an empty ".git" is not a repository: nothing to do.
  if (!hostRepoExists()) return result;
  const fail = (step: string, err: unknown) => {
    result.failed = `${step}: ${errorText(err)}`;
    logger.warn({ step, err: errorText(err), host }, 'Host repo: step failed');
  };

  const origin = expectedOriginUrl();
  if (origin.problem) {
    result.failed = `origin: ${origin.problem}`;
    await alertOnce(
      `origin:${origin.problem}`,
      `Knowledge-base sync is stopped: ${origin.problem}. Nothing is fetched or pushed until the setting is fixed.`,
    );
  }
  let fetched = false;
  const doFetch = async () => {
    await fetchOrigin(budget);
    fetched = true;
    if (!adoptOriginIfUnborn()) await rebaseBranchOnto(ORIGIN_REF, budget);
  };
  if (origin.url) {
    try {
      await ensureOriginRemote(origin.url, budget);
      // A host repo with no commit yet takes the origin's history before it
      // commits anything of its own.
      if (!refSha(BRANCH_REF)) await doFetch();
    } catch (err) {
      fail('fetch', err);
    }
  }
  // Still no history although there is an origin (it could not be reached,
  // or the setting is wrong): commit nothing. The entries stay as files and
  // are committed on top of the origin's history at a later sync.
  if ((origin.url || origin.problem) && !refSha(BRANCH_REF)) return result;

  try {
    result.committed = await commitHostWrites(opts.count ?? 0, budget);
  } catch (err) {
    fail('commit', err);
    return result;
  }

  if (origin.url && opts.fetchOrigin && !fetched) {
    try {
      await doFetch();
    } catch (err) {
      fail('fetch', err);
    }
  }

  try {
    const taken = await importFromCheckout(
      budget,
      origin.url && !fetched ? doFetch : null,
    );
    result.imported = taken.imported;
    if (!taken.refused) clearAlerts('refused:');
    if (taken.refused) {
      result.refused = taken.refused;
      logger.error(
        { ...taken.refused },
        'Host repo: nothing taken from the agent checkout',
      );
      await alertOnce(
        `refused:${taken.refused.reason}:${taken.refused.detail}`,
        `Knowledge-base sync: the host did not take the agent's commits (${taken.refused.reason}). ` +
          `${taken.refused.detail}. They stay in the checkout on the host and are not pushed. ` +
          `The host's own commits are still pushed.`,
      );
    }
  } catch (err) {
    fail('import', err);
  }

  if (origin.url) {
    const head = refSha(BRANCH_REF);
    if (head && head !== refSha(ORIGIN_REF)) {
      try {
        await pushBranch(budget);
        result.pushed = true;
        clearAlerts('push:');
        logger.info({ head }, 'Host repo: pushed');
      } catch (err) {
        fail('push', err);
        await alertOnce(
          `push:${head}`,
          `Knowledge-base push failed. Commits made on this host are not on the remote (HEAD ${head.slice(0, 12)}). ` +
            `The host retries at the next sync. Reason: ${errorText(err)}`,
        );
      }
    }
  }

  try {
    ensureExport();
  } catch (err) {
    fail('export', err);
  }
  return result;
}

/**
 * Commit the host's pending writes, take checked commits from the agent
 * checkout, and push. Serialized: two syncs never share the working tree.
 * Never throws; `failed` and `refused` say what did not happen.
 */
export function syncHostRepo(opts: SyncOptions = {}): Promise<SyncResult> {
  return queued(async () => {
    try {
      return await runSync(opts);
    } catch (err) {
      logger.error({ err: errorText(err) }, 'Host repo: sync failed');
      return {
        committed: false,
        imported: 0,
        pushed: false,
        failed: `sync: ${errorText(err)}`,
      };
    }
  });
}
