import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  logTerminalCommit,
  logTripwireOnce,
  logTripwireSuppressionOnce,
} from '../audit-log.js';
import { getRepoReader } from '../repo-reader.js';
import { logger } from '../logger.js';
import {
  isAdminAuthorEmail,
  protectedGovernanceRule,
} from '../governance-protection.js';
import {
  BOT_GIT_AUTHOR_EMAIL,
  INTAKE_GIT_AUTHOR_EMAIL,
} from '../instance-identity.js';

const execFileP = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// GitHub push webhook — refresh the read mirror on every push, and synthesize
// audit-log entries for terminal commits (any commit whose author is not a
// known bot identity). Bot pushes — including Coordinator's own audit-log commits —
// refresh the mirror but are not re-logged (logTerminalCommit is not called),
// which prevents infinite loops. The writable checkout is never pulled by the
// host; containers pull it themselves at task start.
// ─────────────────────────────────────────────────────────────────────────────

const BOT_AUTHORS = new Set([BOT_GIT_AUTHOR_EMAIL, INTAKE_GIT_AUTHOR_EMAIL]);

const KB_INCLUDE_PREFIXES = [
  'discussions/DECISIONS.md',
  'discussions/ACTION_ITEMS.md',
  'discussions/OPEN_QUESTIONS.md',
  'discussions/PARKED.md',
  'discussions/PENDING_MEETINGS.md',
  'docs/faq.md',
  'discussions/LEARNING_INFRASTRUCTURE.md',
  'courses/',
  'program/',
  'design/',
  'strategy/',
  'CLAUDE.md',
  '_agent-inbox/done/',
];

const KB_EXCLUDE_PREFIXES = [
  'discussions/raw/',
  'discussions/audit-log/',
  'discussions/drafts/',
  'discussions/kb-triage/',
  'discussions/lint-reports/',
  'discussions/quality-review/',
  'reference/',
];

interface GithubCommit {
  id: string;
  timestamp: string;
  message: string;
  author: { name: string; email: string; username?: string };
  added?: string[];
  modified?: string[];
  removed?: string[];
}

interface GithubPushPayload {
  ref: string;
  before: string;
  after: string;
  forced?: boolean;
  commits: GithubCommit[];
}

type OwnerAlert = (message: string) => Promise<void>;

function verifyGithubSignature(
  signature: string | undefined,
  rawBody: string,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isKbPath(path: string): boolean {
  if (KB_EXCLUDE_PREFIXES.some((ex) => path.startsWith(ex))) return false;
  return KB_INCLUDE_PREFIXES.some((inc) => path.startsWith(inc));
}

function commitKbFiles(c: GithubCommit): string[] {
  const all = [...(c.added || []), ...(c.modified || []), ...(c.removed || [])];
  return all.filter(isKbPath);
}

function protectedPaths(c: GithubCommit): Array<{
  path: string;
  rule: 'G11' | 'G39';
}> {
  const all = [...(c.added || []), ...(c.modified || []), ...(c.removed || [])];
  return all.flatMap((path) => {
    const rule = protectedGovernanceRule(path);
    return rule ? [{ path, rule }] : [];
  });
}

/**
 * Blob hash of `relPath` at `rev`, or null if absent/unreadable.
 * Null always means "cannot prove", never "no change" — callers fail closed.
 */
async function blobAt(
  mirrorPath: string,
  rev: string,
  relPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', mirrorPath, 'rev-parse', `${rev}:${relPath}`],
      { timeout: 10_000 },
    );
    const blob = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(blob) ? blob : null;
  } catch {
    return null;
  }
}

/**
 * Authors of every commit touching `relPath` in `from..to`, with
 * --full-history so history simplification cannot hide a bot commit whose
 * change was later reverted. null = could not determine (callers fail closed).
 */
async function pathAuthorsIntroduced(
  mirrorPath: string,
  from: string,
  to: string,
  relPath: string,
): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      [
        '-C',
        mirrorPath,
        'log',
        '--full-history',
        '--format=%ae',
        `${from}..${to}`,
        '--',
        relPath,
      ],
      { timeout: 10_000 },
    );
    return stdout.split('\n').filter(Boolean);
  } catch (err) {
    logger.warn(
      { err, from, to, relPath },
      'GitHub push: merge-range authorship check failed; keeping tripwire alert',
    );
    return null;
  }
}

/**
 * Protected paths a MERGE commit should not be blamed for.
 *
 * GitHub's push payload lists, for a merge, every file arriving from the other
 * parent — and the merge's author is whoever ran `git merge`. So when Coordinator
 * merges an admin commit that touched program/EMAIL_ALLOWLIST.md, the bot gets
 * blamed for an edit it did not make, and the alert tells the admin to revert
 * a legitimate change. A security channel that
 * cries wolf on routine merges stops being read.
 *
 * A path is exonerated ONLY when the merge's content for it is byte-identical
 * to a parent whose version of that path was admin-authored. Therefore:
 *   - a merge that resolves a conflict by writing NEW content (matching neither
 *     parent) still alerts — that is a real bot edit;
 *   - a merge that takes a NON-admin parent's content still alerts;
 *   - a non-merge commit is never exonerated here.
 *
 * Fails CLOSED: any unreadable SHA, missing blob, or git failure leaves the
 * path un-exonerated and the alert intact, matching rangeAuthorsForPath above.
 */
export async function mergeAdminExoneratedPaths(
  mirrorPath: string,
  sha: string,
  paths: ReturnType<typeof protectedPaths>,
): Promise<Map<string, string>> {
  // path -> sha of the parent that supplied the admin-authored content
  const exonerated = new Map<string, string>();
  if (!/^[0-9a-f]{40}$/i.test(sha)) return exonerated;

  let parents: string[];
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', mirrorPath, 'rev-list', '--parents', '-n', '1', sha],
      { timeout: 10_000 },
    );
    parents = stdout.trim().split(/\s+/).slice(1);
  } catch (err) {
    logger.warn(
      { err, sha },
      'GitHub push: merge-parent lookup failed; keeping tripwire alert',
    );
    return exonerated;
  }
  if (parents.length < 2) return exonerated; // not a merge
  const [firstParent, ...sideParents] = parents;

  for (const { path: relPath } of paths) {
    const mergeBlob = await blobAt(mirrorPath, sha, relPath);
    if (!mergeBlob) continue; // absent/deleted at the merge — never exonerate
    for (const parent of sideParents) {
      const parentBlob = await blobAt(mirrorPath, parent, relPath);
      if (!parentBlob || parentBlob !== mergeBlob) continue;

      // Content matching a parent is NOT sufficient. Requiring only that
      // "some admin last touched this path in that parent's history" lets an
      // attacker branch from ANY old admin commit, add an unrelated commit so
      // the path's last author is still that admin, and merge the stale file
      // back in — silently restoring a removed allowlist member.
      //
      // So also require this merge to be INTRODUCING admin work: the range
      // firstParent..sideParent must contain at least one commit touching the
      // path, and every such commit must be admin-authored. A replay branch
      // introduces no new commits for the path, so the range is empty and the
      // alert stands.
      const introduced = await pathAuthorsIntroduced(
        mirrorPath,
        firstParent,
        parent,
        relPath,
      );
      if (introduced === null || introduced.length === 0) continue;
      if (!introduced.every((email) => isAdminAuthorEmail(email))) continue;

      exonerated.set(relPath, parent);
      break;
    }
  }
  return exonerated;
}

async function alertProtectedPathViolation(
  commit: GithubCommit,
  paths: ReturnType<typeof protectedPaths>,
  alertOwner: OwnerAlert | undefined,
  mirrorPath: string,
): Promise<void> {
  if (
    !alertOwner ||
    paths.length === 0 ||
    isAdminAuthorEmail(commit.author.email)
  ) {
    return;
  }
  // Drop paths this commit only inherited by merging an admin's work.
  const exonerated = await mergeAdminExoneratedPaths(
    mirrorPath,
    commit.id,
    paths,
  );
  const blamed = paths.filter(({ path }) => !exonerated.has(path));
  if (exonerated.size > 0) {
    const suppressedPaths = [...exonerated.keys()];
    logger.info(
      {
        commit: commit.id,
        exonerated: suppressedPaths,
        stillBlamed: blamed.map(({ path }) => path),
      },
      'GitHub push: merge inherited admin-authored protected path(s); not alerting on those',
    );
    // Durable trace: a control that can decline to fire must record its
    // non-firings, or a bad suppression leaves no evidence anywhere.
    logTripwireSuppressionOnce({
      key: commit.id,
      paths: suppressedPaths.join(', '),
      authorEmail: commit.author.email,
      supplyingParent: [...new Set(exonerated.values())].join(', '),
      detail:
        `Merge ${commit.id.slice(0, 12)} changed protected path(s) only by inheriting an ` +
        'admin-authored change from a merged parent (content byte-identical, and every ' +
        'commit introducing it in that range was admin-authored). No owner alert sent.',
    });
  }
  if (blamed.length === 0) return;
  const rules = [...new Set(blamed.map(({ rule }) => rule))].join('/');
  const pathList = blamed.map(({ path }) => path).join(', ');
  // Durable audit record first — the violation must survive an unreachable
  // or misconfigured alert channel.
  logTripwireOnce({
    key: commit.id,
    rules,
    paths: pathList,
    authorEmail: commit.author.email,
    detail: `Non-admin commit ${commit.id.slice(0, 12)} changed protected path(s).`,
  });
  try {
    await alertOwner(
      `[${rules}] Protected-path tripwire: non-admin commit ${commit.id.slice(0, 12)} ` +
        `by ${commit.author.email || '(missing author email)'} changed ${pathList}. ` +
        'Review and revert the commit. EMAIL_ALLOWLIST.md reads remain pinned to the last admin-authored revision.',
    );
  } catch (err) {
    logger.error(
      { err, commit: commit.id, authorEmail: commit.author.email, paths },
      'GitHub push: protected-path owner alert failed',
    );
    throw err;
  }
}

async function getChangedPaths(
  repoPath: string,
  before: string,
  after: string,
): Promise<string[]> {
  if (!/^[0-9a-f]{40}$/i.test(before) || !/^[0-9a-f]{40}$/i.test(after)) {
    throw new Error('GitHub push: invalid before/after SHA');
  }
  const { stdout } = await execFileP(
    'git',
    ['-C', repoPath, 'diff', '--name-only', before, after, '--'],
    { timeout: 10_000 },
  );
  return stdout.split('\n').filter(Boolean);
}

async function alertUncoveredForcedChanges(
  payload: GithubPushPayload,
  mirrorPath: string,
  alertOwner: OwnerAlert | undefined,
): Promise<void> {
  // GitHub truncates the push payload's commits[] at 20 — a protected change
  // in a dropped commit would be invisible to the per-commit loop, so a
  // possibly-truncated push gets the same range-diff coverage as a forced one.
  const maybeTruncated = payload.commits.length >= 20;
  if ((!payload.forced && !maybeTruncated) || !alertOwner) return;
  // All-zero SHAs (branch create/delete) have no diffable range.
  if (/^0{40}$/.test(payload.before) || /^0{40}$/.test(payload.after)) return;
  const covered = new Set(
    payload.commits.flatMap((commit) =>
      protectedPaths(commit).map(({ path }) => path),
    ),
  );
  let changed: string[];
  try {
    changed = await getChangedPaths(mirrorPath, payload.before, payload.after);
  } catch (err) {
    // A forced update we cannot diff (pre-force tip absent from the mirror —
    // exactly the shape a history rewrite takes) still needs eyes on it.
    // Degrade to a manual-review alert instead of crashing the handler.
    logger.error(
      { err, before: payload.before, after: payload.after },
      'GitHub push: forced-update diff failed; alerting for manual review',
    );
    logTripwireOnce({
      key: `${payload.before}..${payload.after}`,
      rules: 'G11/G39',
      paths: '(range not diffable)',
      detail: `${payload.forced ? 'Forced' : 'Large (truncated commit list)'} main update could not be diffed against the mirror; protected-path coverage unverified — review manually.`,
    });
    await alertOwner(
      `[G11/G39] Protected-path tripwire: ${payload.forced ? 'forced' : 'large'} main update ${payload.before.slice(0, 12)} → ` +
        `${payload.after.slice(0, 12)} could not be diffed against the mirror. ` +
        'Review the forced update manually.',
    );
    return;
  }
  const candidates = changed
    .filter((path) => !covered.has(path))
    .flatMap((path) => {
      const rule = protectedGovernanceRule(path);
      return rule ? [{ path, rule }] : [];
    });
  // Admin exemption, mirroring the per-commit path: a protected change whose
  // every range author is an admin is authorized — paging the owner about
  // their own edits desensitizes the tripwire channel. Unverifiable
  // authorship (git failure, empty log under history simplification) keeps
  // the alert.
  const uncovered: Array<{ path: string; rule: 'G11' | 'G39' }> = [];
  for (const entry of candidates) {
    const authors = await rangeAuthorsForPath(
      mirrorPath,
      payload.before,
      payload.after,
      entry.path,
    );
    const allAdmin =
      authors !== null &&
      authors.length > 0 &&
      authors.every((email) => isAdminAuthorEmail(email));
    if (!allAdmin) uncovered.push(entry);
  }
  if (uncovered.length === 0) return;
  const rules = [...new Set(uncovered.map(({ rule }) => rule))].join('/');
  const paths = uncovered.map(({ path }) => path).join(', ');
  logTripwireOnce({
    key: `${payload.before}..${payload.after}`,
    rules,
    paths,
    detail: `${payload.forced ? 'Forced' : 'Large (truncated commit list)'} main update changed protected path(s) outside the webhook commit list.`,
  });
  await alertOwner(
    `[${rules}] Protected-path tripwire: ${payload.forced ? 'forced' : 'large'} main update ${payload.before.slice(0, 12)} → ` +
      `${payload.after.slice(0, 12)} changed ${paths}, outside the webhook commit list. Review the forced update immediately.`,
  );
}

async function rangeAuthorsForPath(
  mirrorPath: string,
  before: string,
  after: string,
  relPath: string,
): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      [
        '-C',
        mirrorPath,
        'log',
        '--format=%ae',
        `${before}..${after}`,
        '--',
        relPath,
      ],
      { timeout: 10_000 },
    );
    return stdout.split('\n').filter(Boolean);
  } catch (err) {
    logger.warn(
      { err, before, after, relPath },
      'GitHub push: range authorship check failed; keeping tripwire alert',
    );
    return null;
  }
}

async function getCommitNumstat(
  repoPath: string,
  sha: string,
): Promise<Map<string, string>> {
  // Returns path -> "+N -M" (or "(binary)") from `git show --numstat`.
  const stats = new Map<string, string>();
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'show', '--no-patch', '--format=', '--numstat', sha],
      { timeout: 10_000 },
    );
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split('\t');
      if (parts.length !== 3) continue;
      const [adds, dels, path] = parts;
      stats.set(
        path,
        adds === '-' || dels === '-' ? '(binary)' : `+${adds} -${dels}`,
      );
    }
  } catch (err: any) {
    logger.debug({ err: err?.message, sha }, 'GitHub push: numstat failed');
  }
  return stats;
}

async function handleGithubPush(
  payload: GithubPushPayload,
  alertOwner?: OwnerAlert,
  onMirrorRefreshed?: () => void,
): Promise<void> {
  // Only react to pushes on main
  if (payload.ref !== 'refs/heads/main') {
    logger.debug({ ref: payload.ref }, 'GitHub push: ignoring non-main ref');
    return;
  }

  // The push webhook is the authoritative "new commit exists" signal — always
  // fetch, bypassing the refresh() success-cooldown.
  const { advanced, sha } = getRepoReader().refresh({ force: true });
  logger.info({ advanced, sha }, 'GitHub push: read mirror refreshed');
  if (advanced) onMirrorRefreshed?.();
  // No ownership repair: host git in the checkout runs as its owner (uid
  // 1000), so nothing root-owned is left behind, and a root `chown -R` over a
  // container-writable tree is itself a hazard.

  let logged = 0;
  let skippedBot = 0;
  let skippedNoKb = 0;
  // Alert failures are collected, not thrown mid-loop: an undeliverable
  // tripwire ping must not abort audit logging for the remaining commits.
  // The first failure is rethrown after the loop so the delivery still
  // surfaces as failed in GitHub's webhook UI.
  const alertFailures: unknown[] = [];

  for (const c of payload.commits) {
    try {
      await alertProtectedPathViolation(
        c,
        protectedPaths(c),
        alertOwner,
        getRepoReader().mirrorPath,
      );
    } catch (err) {
      alertFailures.push(err);
    }
    // The settings are stored in lower case; git keeps the author's case.
    if (BOT_AUTHORS.has((c.author?.email ?? '').toLowerCase())) {
      skippedBot++;
      continue;
    }
    const kbPaths = commitKbFiles(c);
    if (kbPaths.length === 0) {
      skippedNoKb++;
      continue;
    }
    // The pushed commit is guaranteed present in the mirror (just fetched),
    // not necessarily in the live checkout (containers pull it later).
    const numstat = await getCommitNumstat(getRepoReader().mirrorPath, c.id);
    const kbFiles = kbPaths.map((p) => ({
      path: p,
      stats: numstat.get(p) || '?',
    }));
    const subject = (c.message || '').split('\n')[0].trim() || '(no subject)';
    const written = logTerminalCommit({
      sha: c.id,
      authorEmail: c.author.email,
      subject,
      kbFiles,
      commitIso: c.timestamp,
    });
    if (written === 'write-failed') {
      // A dropped audit entry must fail the delivery (500) — the entry is
      // idempotent on the commit SHA, so a manual redelivery re-attempts it.
      alertFailures.push(
        new Error(`terminal-commit audit entry failed for ${c.id}`),
      );
      continue;
    }
    logged++;
  }

  try {
    await alertUncoveredForcedChanges(
      payload,
      getRepoReader().mirrorPath,
      alertOwner,
    );
  } catch (err) {
    alertFailures.push(err);
  }

  logger.info(
    {
      ref: payload.ref,
      logged,
      skippedBot,
      skippedNoKb,
      total: payload.commits.length,
    },
    'GitHub push: processed',
  );

  if (alertFailures.length > 0) {
    throw alertFailures[0];
  }
}

// Route /api/github-push — refresh the program-repo read mirror and
// synthesize audit-log entries for terminal commits (non-bot authors).
// Closes the visibility gap between Coordinator-mediated channels (which log
// every interaction) and direct author commits (which previously were
// invisible to the audit trail).
export function handleGithubPushRequest(
  req: IncomingMessage,
  res: ServerResponse,
  githubPushSecret: string | undefined,
  alertOwner?: OwnerAlert,
  onMirrorRefreshed?: () => void,
): void {
  if (!githubPushSecret) {
    res.writeHead(503);
    res.end('GitHub push webhook not configured');
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const rawBody = Buffer.concat(chunks).toString();
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!verifyGithubSignature(sig, rawBody, githubPushSecret)) {
        logger.warn(
          { sig: sig?.slice(0, 16) },
          'GitHub push: invalid signature',
        );
        res.writeHead(401);
        res.end('Bad signature');
        return;
      }
      const payload = JSON.parse(rawBody) as GithubPushPayload;
      await handleGithubPush(payload, alertOwner, onMirrorRefreshed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      logger.error({ err }, 'GitHub push: handler error');
      // A mirror or owner-alert failure marks the delivery failed in
      // GitHub's webhook UI (GitHub never auto-retries; redelivery is
      // manual, and logTerminalCommit is idempotent on the commit SHA).
      res.writeHead(500);
      res.end('error logged');
    }
  });
}
