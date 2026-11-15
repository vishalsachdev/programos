/**
 * RC-018: pinned allowlist snapshot for the container precheck.
 *
 * The container's `send_email` tool warns the agent, at call time, about
 * recipients the host will refuse. It must judge from the same revision the
 * host gate reads — the admin-verified mirror served by `RepoReader` — not
 * the writable checkout, which can be stale or carry an unverified edit.
 * The host writes that text into the group's
 * IPC dir on every container start; the container reads it first and falls
 * back to the checkout only when the file is absent.
 */
import fs from 'fs';
import path from 'path';
import { parseEmailAllowlist } from './channels/webhook-allowlist.js';
import { logger } from './logger.js';

export const ALLOWLIST_SNAPSHOT_FILENAME = 'email-allowlist.snapshot.md';
const ALLOWLIST_REL_PATH = 'program/EMAIL_ALLOWLIST.md';

export interface AllowlistTextSource {
  readFile(relPath: string): string | null;
  /**
   * Revision the allowlist is SERVED from (RepoReader.allowlistPin — the
   * protected-path pin, which can advance independently of the repo tip).
   * When present, the text is cached per revision.
   */
  currentSha?: string | null;
}

// One `git show` per allowlist-pin advance, not per container start: the
// read is synchronous (RepoReader) and container starts happen on the shared
// event loop. Accepted residual: the first
// start after a pin change still does one local `git show`, the same call
// the per-reply sensor path already makes.
let cached: { sha: string; text: string } | null = null;

// Last text written per IPC dir (one per group). Kept per group, not
// globally: a container started under revision A keeps judging from A after
// another group's start advances the cache to B.
const lastWritten = new Map<string, string>();
// Groups whose last start had NO snapshot (mirror unreadable): their tool
// told the agent every send is unverified, so the host must confirm every
// successful send with a note.
const unverifiedDirs = new Set<string>();

/**
 * Write the pinned allowlist into `ipcDir`. Returns true when a snapshot was
 * written. When the source has no allowlist, any stale snapshot is removed so
 * the container never judges from an old copy.
 */
export function writeAllowlistSnapshot(
  ipcDir: string,
  source: AllowlistTextSource,
): boolean {
  const target = path.join(ipcDir, ALLOWLIST_SNAPSHOT_FILENAME);
  const sha = source.currentSha ?? null;
  let text: string | null = null;
  if (sha && cached && cached.sha === sha) {
    text = cached.text;
  } else {
    try {
      text = source.readFile(ALLOWLIST_REL_PATH);
    } catch (err) {
      logger.warn({ err }, 'Allowlist snapshot: pinned read failed');
    }
    if (text !== null && sha) cached = { sha, text };
  }
  if (text === null) {
    cached = null;
    lastWritten.delete(ipcDir);
    unverifiedDirs.add(ipcDir);
    fs.rmSync(target, { force: true });
    return false;
  }
  // Atomic replace: a container of the same group may be reading the file
  // while another starts; a truncate-then-write would expose an empty list.
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, target);
  lastWritten.set(ipcDir, text);
  unverifiedDirs.delete(ipcDir);
  return true;
}

/**
 * Sent addresses absent from ANY group's last-written snapshot. The send
 * path does not know which group's container asked (email threads use a
 * thread jid as sourceGroup), so the check is a union across groups: a
 * corrective note is written whenever some running container could have
 * warned "not sent" for an address the host then delivered. Over-reporting
 * is a harmless true statement; under-reporting is the incident.
 */
export function addressesMissingFromLastSnapshot(
  addresses: string[],
): string[] {
  if (unverifiedDirs.size > 0) return [...addresses];
  if (lastWritten.size === 0) return [];
  const allowedSets = [...lastWritten.values()].map(parseEmailAllowlist);
  return addresses.filter((a) => {
    const key = a.trim().toLowerCase();
    return allowedSets.some((set) => !set.has(key));
  });
}

export function _resetAllowlistSnapshotForTests(): void {
  cached = null;
  lastWritten.clear();
  unverifiedDirs.clear();
}

/**
 * Rebuild the per-group "last written" memory from disk after a restart, so
 * the outbox replay that runs before any container starts can still detect
 * an allowlist advance since a container's snapshot.
 */
export function hydrateAllowlistSnapshots(rootDir: string): number {
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(rootDir, entry.name);
    try {
      const text = fs.readFileSync(
        path.join(dir, ALLOWLIST_SNAPSHOT_FILENAME),
        'utf8',
      );
      lastWritten.set(dir, text);
      count += 1;
    } catch {
      // no snapshot for this group
    }
  }
  return count;
}
