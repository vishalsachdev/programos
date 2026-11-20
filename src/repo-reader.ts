import { execFile, execFileSync } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import path from 'path';

import { logger } from './logger.js';
import {
  hasOriginCredential,
  originCredentialEnv,
  redactOriginCredential,
  splitOriginCredential,
} from './origin-credential.js';
import {
  checkoutOriginUrl,
  isExpectedOrigin,
  isPlaceholderOrigin,
  mirrorOriginUrl,
  readMirrorPath,
} from './program-origin.js';

export { isExpectedOrigin };
import { isAdminAuthorEmail } from './governance-protection.js';
import { INTAKE_GIT_AUTHOR_EMAIL } from './instance-identity.js';

const execFileAsync = promisify(execFile);

/**
 * Read-only view of the program-repo repo, served from a pinned commit in a
 * local bare mirror — never from the writable checkout. A pinned SHA cannot
 * be "half-pulled", which removes the read-race class behind an
 * `allowlist unavailable` failure at the root.
 *
 * Failure posture: fail closed at cold start (no SHA → reads return null),
 * fail stale after that (fetch failure keeps the last-good SHA — stale beats
 * half-pulled). Both paths log loudly.
 */
/**
 * The environment of a git process that talks to the origin for the mirror:
 * the host's own, plus the credential of PROGRAM_ORIGIN_URL when it has one.
 * The mirror's config and the command line name the origin without it.
 */
function mirrorGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...originCredentialEnv(process.env.PROGRAM_ORIGIN_URL, process.env),
  };
}

/** An error's message for a log line, without the origin's credential. */
function mirrorErrorText(err: any): string {
  return redactOriginCredential(String(err?.message ?? err), [
    process.env.PROGRAM_ORIGIN_URL,
  ]);
}

/** Benign "the file/revision just isn't there" stderr patterns from git. */
const BENIGN_MISSING_RE =
  /does not exist in|Not a valid object name|bad revision|path .* does not exist/i;

/** Stderr from an execFileSync error as a string (Buffer or string or absent). */
function stderrOf(err: any): string {
  const raw = err?.stderr;
  if (raw == null) return '';
  return Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
}

/** Minimum gap between un-forced fetches (refresh() success cooldown). */
const FETCH_COOLDOWN_MS = 30_000;
const ALLOWLIST_PATH = 'program/EMAIL_ALLOWLIST.md';

interface PathCommitAuthor {
  sha: string;
  email: string;
}

/**
 * Why this host counts as serving a real program repo, or null when it
 * serves the placeholder (a fresh clone before adaptation, the tests).
 *
 * Real means either of:
 *  - PROGRAM_ORIGIN_PATTERN or PROGRAM_ORIGIN_URL is set: the operator
 *    named their own origin;
 *  - the read mirror or the live checkout has an origin that is not the
 *    placeholder repo's. This covers a mirror that was cloned by hand, which
 *    needs no PROGRAM_ORIGIN_PATTERN.
 * A repo that is missing or has no origin does not count.
 *
 * The reason never includes the URL, which can carry a token.
 */
export function realProgramRepoReason(): string | null {
  if (process.env.PROGRAM_ORIGIN_PATTERN) {
    return 'PROGRAM_ORIGIN_PATTERN is set';
  }
  const set = process.env.PROGRAM_ORIGIN_URL;
  if (set && !isPlaceholderOrigin(set)) return 'PROGRAM_ORIGIN_URL is set';
  const sources: Array<[string, () => string]> = [
    ['read mirror', mirrorOriginUrl],
    ['program repo checkout', checkoutOriginUrl],
  ];
  for (const [name, read] of sources) {
    let url: string;
    try {
      url = read();
    } catch {
      continue;
    }
    if (url && !isPlaceholderOrigin(url)) {
      return `the origin of the ${name} is not the placeholder example-org/program-repo`;
    }
  }
  return null;
}

export class RepoReader {
  private sha: string | null = null;
  private allowlistSha: string | null = null;
  /** Repo SHA the allowlist pin decision was last successfully verified
   * against. Lags this.sha after a transient author-check failure, which is
   * the signal refresh() uses to retry the reconcile. */
  private allowlistVerifiedSha: string | null = null;
  private lastRejectedAllowlistCommit: string | null = null;
  private lastFetchOkAt = 0;

  constructor(readonly mirrorPath: string) {}

  /**
   * Resolve the initial pinned SHA. If the mirror is missing (fresh/rebuilt
   * deployment), attempt to bootstrap it from the live checkout's origin
   * first. Returns false (and logs) on failure.
   */
  init(): boolean {
    this.sha = this.resolveSha();
    if (!this.sha && this.bootstrapMirror()) {
      this.sha = this.resolveSha();
    }
    if (this.sha) this.secureStoredOrigin();
    if (this.sha) {
      this.reconcileAllowlistSha(this.sha);
    }
    if (!this.sha) {
      logger.error(
        { mirror: this.mirrorPath },
        'RepoReader: no readable SHA at init — repo reads will fail closed. ' +
          'Set PROGRAM_ORIGIN_URL, or create the mirror manually: git clone --mirror <origin-url> ' +
          this.mirrorPath,
      );
    }
    return this.sha !== null;
  }

  /**
   * Bootstrap the bare mirror by cloning PROGRAM_ORIGIN_URL, the origin the
   * operator set. The URL is not taken from the live checkout: its
   * .git/config is container-writable. Called only when init() finds no
   * readable SHA — i.e. the mirror is missing or not a repo. Returns true if
   * a clone succeeded.
   */
  private bootstrapMirror(): boolean {
    // Read at call time (not via config import) so tests can stub it.
    const originUrl = process.env.PROGRAM_ORIGIN_URL || '';
    if (!originUrl) {
      logger.warn(
        { mirror: this.mirrorPath },
        'RepoReader: mirror bootstrap skipped — PROGRAM_ORIGIN_URL is not set',
      );
      return false;
    }
    if (!isExpectedOrigin(originUrl)) {
      logger.warn(
        { mirror: this.mirrorPath },
        'RepoReader: mirror bootstrap refused — PROGRAM_ORIGIN_URL is not the expected origin',
      );
      return false;
    }
    // The mirror's config and this command line get the URL without its
    // credential; git reads the credential from its environment
    // (origin-credential.ts). Logged: the URL without it.
    const origin = splitOriginCredential(originUrl).bare;
    try {
      execFileSync(
        'git',
        ['clone', '--mirror', '--', origin, this.mirrorPath],
        {
          timeout: 120_000,
          env: mirrorGitEnv(),
        },
      );
      logger.info(
        { originUrl: origin, mirror: this.mirrorPath },
        'RepoReader: bootstrapped read mirror from PROGRAM_ORIGIN_URL',
      );
      return true;
    } catch (err: any) {
      logger.warn(
        {
          err: mirrorErrorText(err),
          originUrl: origin,
          mirror: this.mirrorPath,
        },
        'RepoReader: mirror bootstrap clone failed',
      );
      return false;
    }
  }

  /**
   * A mirror made by an earlier version, or cloned by hand, can hold the
   * origin's token in its config. When PROGRAM_ORIGIN_URL names the same
   * address and holds a credential (the same one or a newer one), the stored
   * URL is rewritten without the credential (git then reads it from the
   * setting). Otherwise the config is the credential's only home:
   * it is left as it is, made readable by its owner only, and a warning
   * says how to move it. Never throws.
   */
  private secureStoredOrigin(): void {
    try {
      const stored = execFileSync(
        'git',
        ['-C', this.mirrorPath, 'config', '--get', 'remote.origin.url'],
        {
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).trim();
      if (!hasOriginCredential(stored)) return;
      const configFile = path.join(this.mirrorPath, 'config');
      const st = fs.lstatSync(configFile);
      if (!st.isSymbolicLink() && (st.mode & 0o077) !== 0) {
        fs.chmodSync(configFile, 0o600);
        logger.warn(
          { path: configFile, was: (st.mode & 0o777).toString(8) },
          'RepoReader: the read mirror config holds a credential and was readable by other users; now private to its owner',
        );
      }
      // Same address, and the setting carries a credential of its own: the
      // stored one is not needed. It may be an older token than the setting's
      // (rotated before this start); git would go on using the stored one,
      // because the rewrite from the setting matches the bare address only.
      const setting = process.env.PROGRAM_ORIGIN_URL || '';
      if (
        hasOriginCredential(setting) &&
        splitOriginCredential(stored).bare ===
          splitOriginCredential(setting).bare
      ) {
        execFileSync(
          'git',
          [
            '-C',
            this.mirrorPath,
            'config',
            'remote.origin.url',
            splitOriginCredential(stored).bare,
          ],
          { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        logger.warn(
          { mirror: this.mirrorPath },
          'RepoReader: the read mirror stored the origin URL with a credential; it was rewritten without it. ' +
            'The credential is now read from PROGRAM_ORIGIN_URL at each fetch.',
        );
      } else {
        logger.warn(
          { mirror: this.mirrorPath },
          'RepoReader: the read mirror config holds a credential in its origin URL. ' +
            'To take it out of the file, set PROGRAM_ORIGIN_URL to the same URL and restart, ' +
            'or use an SSH deploy key.',
        );
      }
    } catch (err: any) {
      logger.debug(
        { err: mirrorErrorText(err), mirror: this.mirrorPath },
        'RepoReader: stored origin of the read mirror not checked',
      );
    }
  }

  get currentSha(): string | null {
    return this.sha;
  }

  /**
   * Revision the protected allowlist is currently served from (falls back
   * to the tip when no separate pin is held). Cache key for the container
   * allowlist snapshot (RC-018).
   */
  get allowlistPin(): string | null {
    return this.allowlistSha ?? this.sha;
  }

  /**
   * Fetch the mirror and advance the pinned SHA; keep last-good on failure.
   *
   * A successful fetch starts a 30s cooldown: un-forced calls within it skip
   * the (blocking, up to 30s) network fetch — refresh() runs per outbound
   * reply via the behaviour-sensor, so back-to-back replies must not stack
   * synchronous fetches on the event loop. A FAILED fetch does not start the
   * cooldown (retries aren't suppressed). Pass `{ force: true }` when there is
   * an authoritative "new commit exists" signal (the github-push webhook).
   */
  refresh(opts?: { force?: boolean }): {
    advanced: boolean;
    sha: string | null;
  } {
    // A pin whose verification lags the current SHA means the author check
    // failed transiently (at init, or during an advancing refresh). The
    // reconcile is purely local (mirror git log), so retry BEFORE the
    // cooldown and fetch — an upstream/network outage must not prolong an
    // unavailable or stale allowlist when a good revision sits in the mirror.
    if (this.sha && this.allowlistVerifiedSha !== this.sha) {
      this.reconcileAllowlistSha(this.sha);
    }
    if (!opts?.force && Date.now() - this.lastFetchOkAt < FETCH_COOLDOWN_MS) {
      return { advanced: false, sha: this.sha };
    }
    try {
      execFileSync(
        'git',
        [
          '-C',
          this.mirrorPath,
          'fetch',
          'origin',
          '+refs/heads/main:refs/heads/main',
        ],
        { timeout: 30_000, env: mirrorGitEnv() },
      );
    } catch (err: any) {
      logger.warn(
        {
          err: mirrorErrorText(err),
          mirror: this.mirrorPath,
          lastGood: this.sha,
        },
        'RepoReader: fetch failed; serving last-good SHA',
      );
      return { advanced: false, sha: this.sha };
    }
    return this.adoptFetchedTip();
  }

  /**
   * refresh() without blocking the event loop: the fetch runs as an async
   * child process; adopting the new tip (local rev-parse + allowlist
   * reconcile) is shared with refresh(), so the pin rules are identical.
   * For timers and other off-request callers (routed approvals hourly scan).
   */
  async refreshAsync(opts?: { force?: boolean }): Promise<{
    advanced: boolean;
    sha: string | null;
  }> {
    if (this.sha && this.allowlistVerifiedSha !== this.sha) {
      this.reconcileAllowlistSha(this.sha);
    }
    if (!opts?.force && Date.now() - this.lastFetchOkAt < FETCH_COOLDOWN_MS) {
      return { advanced: false, sha: this.sha };
    }
    try {
      await execFileAsync(
        'git',
        [
          '-C',
          this.mirrorPath,
          'fetch',
          'origin',
          '+refs/heads/main:refs/heads/main',
        ],
        { timeout: 30_000, env: mirrorGitEnv() },
      );
    } catch (err: any) {
      logger.warn(
        {
          err: mirrorErrorText(err),
          mirror: this.mirrorPath,
          lastGood: this.sha,
        },
        'RepoReader: async fetch failed; serving last-good SHA',
      );
      return { advanced: false, sha: this.sha };
    }
    return this.adoptFetchedTip();
  }

  /** After a successful fetch: move to the new tip and re-pin the allowlist. */
  private adoptFetchedTip(): { advanced: boolean; sha: string | null } {
    this.lastFetchOkAt = Date.now();
    const next = this.resolveSha();
    if (next && next !== this.sha) {
      this.sha = next;
      this.reconcileAllowlistSha(next);
      return { advanced: true, sha: next };
    }
    return { advanced: false, sha: this.sha };
  }

  /**
   * SHA to serve relPath from: the admin-verified allowlist pin for the
   * protected allowlist path (normalized, so './'-prefixed or
   * backslash-separated spellings cannot slip past the pin), the ordinary
   * tip for everything else. Single choke point for all read methods.
   */
  private shaFor(relPath: string): string | null {
    const normalized = path.posix
      .normalize(relPath.replaceAll('\\', '/'))
      .replace(/^\.\//, '');
    return normalized === ALLOWLIST_PATH ? this.allowlistSha : this.sha;
  }

  /** File content at the pinned SHA, or null (missing file / no SHA). */
  readFile(relPath: string): string | null {
    const readSha = this.shaFor(relPath);
    if (!readSha) return null;
    try {
      return execFileSync(
        'git',
        ['-C', this.mirrorPath, 'show', `${readSha}:${relPath}`],
        { encoding: 'utf-8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      );
    } catch (err: any) {
      // A missing file is normal; anything else (corrupted/deleted mirror)
      // must leave a log trail — otherwise every allowlist read fails
      // silently and looks identical to "sender not on allowlist".
      if (!BENIGN_MISSING_RE.test(stderrOf(err))) {
        this.warnReadFailure(err, relPath);
      }
      return null;
    }
  }

  /** Received .eml content, anchored to the Worker's original creation commit. */
  async readFileAtCreationAsync(relPath: string): Promise<string | null> {
    const tip = this.sha;
    if (
      !tip ||
      !relPath.startsWith('discussions/raw/') ||
      !relPath.endsWith('.eml') ||
      /(^|\/)\.\.(\/|$)/.test(relPath)
    )
      return null;
    try {
      const { stdout: history } = await execFileAsync(
        'git',
        [
          '-C',
          this.mirrorPath,
          'log',
          '--reverse',
          '--no-renames',
          '--diff-filter=A',
          '--format=%H%x00%ae',
          tip,
          '--',
          relPath,
        ],
        { encoding: 'utf-8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      );
      const [sha, author] = history.trim().split('\n')[0].split('\0');
      // A delayed webhook must never select a later agent-authored version.
      // The setting is stored in lower case; git keeps the author's case.
      if (
        !/^[0-9a-f]{40}$/.test(sha) ||
        (author ?? '').toLowerCase() !== INTAKE_GIT_AUTHOR_EMAIL
      )
        return null;
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.mirrorPath, 'show', `${sha}:${relPath}`],
        { encoding: 'utf-8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout;
    } catch (err) {
      if (!BENIGN_MISSING_RE.test(stderrOf(err)))
        this.warnReadFailure(err, relPath);
      return null;
    }
  }

  /** Pinned text for HTTP intake without blocking the event loop. */
  async readFileAsync(relPath: string): Promise<string | null> {
    const readSha = this.shaFor(relPath);
    if (!readSha) return null;
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.mirrorPath, 'show', `${readSha}:${relPath}`],
        { encoding: 'utf-8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return stdout;
    } catch (err) {
      if (!BENIGN_MISSING_RE.test(stderrOf(err)))
        this.warnReadFailure(err, relPath);
      return null;
    }
  }

  /**
   * File content at the pinned SHA as a raw Buffer (no encoding — lossless
   * for binary/MIME content such as .eml files), or null (missing file /
   * no SHA).
   */
  readFileBuffer(relPath: string): Buffer | null {
    const readSha = this.shaFor(relPath);
    if (!readSha) return null;
    try {
      return execFileSync(
        'git',
        ['-C', this.mirrorPath, 'show', `${readSha}:${relPath}`],
        // 64 MB: a base64-encoded attachment inflates the .eml ~1.37x, so the
        // 20 MB extraction limit needs well over 16 MB of raw MIME headroom.
        { timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (err: any) {
      if (!BENIGN_MISSING_RE.test(stderrOf(err))) {
        this.warnReadFailure(err, relPath);
      }
      return null;
    }
  }

  /**
   * Entry names directly under a directory at the pinned SHA (files and
   * subdirectory names, no trailing slash), or null (missing dir / no SHA).
   */
  listDir(relPath: string): string[] | null {
    if (!this.sha) return null;
    try {
      const out = execFileSync(
        'git',
        [
          '-C',
          this.mirrorPath,
          'ls-tree',
          '--name-only',
          `${this.sha}:${relPath}`,
        ],
        { encoding: 'utf-8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      );
      return out.split('\n').filter((l) => l.trim().length > 0);
    } catch (err: any) {
      if (!BENIGN_MISSING_RE.test(stderrOf(err))) {
        this.warnReadFailure(err, relPath);
      }
      return null;
    }
  }

  /**
   * Whether `hashRef` (full or abbreviated hex) resolves to a commit object
   * in the mirror. Used by the behaviour-sensor's G51 pre-check on commit
   * hashes presented in outbound replies. Ambiguous abbreviations and non-commit
   * objects count as NOT verifiable — the caller FLAGs, never FAILs.
   */
  commitExists(hashRef: string): boolean {
    if (!this.sha) return false;
    if (!/^[0-9a-f]{7,40}$/i.test(hashRef)) return false;
    try {
      execFileSync(
        'git',
        ['-C', this.mirrorPath, 'cat-file', '-e', `${hashRef}^{commit}`],
        { timeout: 10_000 },
      );
      return true;
    } catch {
      // Missing/ambiguous/non-commit — all mean "not verifiable here".
      return false;
    }
  }

  exists(relPath: string): boolean {
    const readSha = this.shaFor(relPath);
    if (!readSha) return false;
    try {
      execFileSync(
        'git',
        ['-C', this.mirrorPath, 'cat-file', '-e', `${readSha}:${relPath}`],
        { timeout: 10_000 },
      );
      return true;
    } catch (err: any) {
      const stderr = stderrOf(err);
      // `cat-file -e` exits 1 with empty stderr for a normal missing file.
      const benign =
        BENIGN_MISSING_RE.test(stderr) ||
        (err?.status === 1 && stderr.trim() === '');
      if (!benign) {
        this.warnReadFailure(err, relPath);
      }
      return false;
    }
  }

  private warnReadFailure(err: any, relPath: string): void {
    logger.warn(
      {
        err: err?.message,
        stderr: stderrOf(err).slice(0, 200),
        relPath,
        sha: this.sha,
        mirror: this.mirrorPath,
      },
      'RepoReader: read failed (mirror problem?)',
    );
  }

  private resolveSha(): string | null {
    try {
      return execFileSync(
        'git',
        ['-C', this.mirrorPath, 'rev-parse', 'refs/heads/main'],
        { encoding: 'utf-8', timeout: 10_000 },
      ).trim();
    } catch (err: any) {
      logger.warn(
        { err: err?.message, mirror: this.mirrorPath },
        'RepoReader: rev-parse failed',
      );
      return null;
    }
  }

  private reconcileAllowlistSha(candidateSha: string): void {
    // O(1) fast path: if the allowlist blob at the candidate is byte-identical
    // to the blob we already serve, the content was previously accepted —
    // advance the pin without any history walk. This keeps the hot path
    // (refresh on every inbound/outbound message) off `git log` entirely for
    // the overwhelmingly common commits that do not touch the allowlist.
    if (this.allowlistSha) {
      const candidateOid = this.pathBlobOid(candidateSha, ALLOWLIST_PATH);
      const servingOid = this.pathBlobOid(this.allowlistSha, ALLOWLIST_PATH);
      if (candidateOid && servingOid && candidateOid === servingOid) {
        this.allowlistSha = candidateSha;
        this.allowlistVerifiedSha = candidateSha;
        this.lastRejectedAllowlistCommit = null;
        return;
      }
    }

    const history = this.pathCommitAuthors(candidateSha, ALLOWLIST_PATH);
    if (history === null) {
      // Transient verification failure (mirror lock, timeout). Keep serving
      // the last-good pin rather than dropping it — nulling it here would
      // take the allowlist "unavailable", which under permissive fallback
      // widens (not narrows) inbound reach.
      logger.error(
        { candidateSha, servingSha: this.allowlistSha, path: ALLOWLIST_PATH },
        'RepoReader: allowlist author check failed; keeping last-good pin',
      );
      return;
    }
    // Every branch below is a completed verification against candidateSha.
    this.allowlistVerifiedSha = candidateSha;
    const latest = history[0];
    if (!latest) {
      this.allowlistSha = null;
      return;
    }
    if (isAdminAuthorEmail(latest.email)) {
      this.allowlistSha = candidateSha;
      this.lastRejectedAllowlistCommit = null;
      return;
    }

    // Always recompute the newest admin-authored revision — an admin commit
    // followed by a bot commit must advance the pin to the admin revision,
    // not freeze on whatever was pinned before either landed.
    this.allowlistSha =
      history.find((entry) => isAdminAuthorEmail(entry.email))?.sha ??
      this.allowlistSha;
    if (this.lastRejectedAllowlistCommit !== latest.sha) {
      this.lastRejectedAllowlistCommit = latest.sha;
      logger.error(
        {
          rejectedCommit: latest.sha,
          authorEmail: latest.email,
          servingSha: this.allowlistSha,
          path: ALLOWLIST_PATH,
        },
        'RepoReader: rejected non-admin allowlist revision; serving last-good',
      );
    }
  }

  /** Blob OID of relPath at sha, or null (missing file / git error). */
  private pathBlobOid(sha: string, relPath: string): string | null {
    try {
      return execFileSync(
        'git',
        ['-C', this.mirrorPath, 'rev-parse', `${sha}:${relPath}`],
        { encoding: 'utf-8', timeout: 10_000 },
      ).trim();
    } catch {
      return null;
    }
  }

  /**
   * Commits touching relPath, newest first, bounded. Returns null on git
   * failure — callers must distinguish "could not verify" from "no history".
   */
  private pathCommitAuthors(
    candidateSha: string,
    relPath: string,
  ): PathCommitAuthor[] | null {
    try {
      const out = execFileSync(
        'git',
        [
          '-C',
          this.mirrorPath,
          'log',
          '-n',
          '200',
          '--format=%H%x09%ae',
          candidateSha,
          '--',
          relPath,
        ],
        { encoding: 'utf-8', timeout: 10_000 },
      );
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, email] = line.split('\t');
          return { sha, email };
        })
        .filter((entry) => Boolean(entry.sha && entry.email));
    } catch (err: any) {
      logger.error(
        { err: err?.message, candidateSha, relPath, mirror: this.mirrorPath },
        'RepoReader: could not verify protected-file author',
      );
      return null;
    }
  }
}

let singleton: RepoReader | null = null;

/** Process-wide reader over the program-repo read mirror. */
export function getRepoReader(): RepoReader {
  if (!singleton) {
    singleton = new RepoReader(readMirrorPath());
    singleton.init();
  }
  return singleton;
}
