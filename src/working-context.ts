/**
 * Working-context handoff — Coordinator's private per-user WORKING layer.
 *
 * The runtime analogue of /start-session + /wrap-up-session: a small,
 * human-readable JSON file per user that carries *tentative* state between
 * sessions — active threads, half-decisions, in-progress reasoning, and
 * user-style cues. It is deliberately NOT the institutional KB:
 * DECISIONS/ACTION_ITEMS/OPEN_QUESTIONS facts never live here, and a
 * tentative position that becomes real graduates to DECISIONS.md via the
 * KB Write Protocol and leaves this layer.
 *
 * Storage: data/working-context/<userKey>.json on the bot's own filesystem
 * (data/ is gitignored — never committed to the shared program-repo repo).
 * Inspectable over SSH; entries are timestamped and decay naturally.
 *
 * Lifecycle:
 *   READ  — on container start (session start) the host loads the store,
 *           filters to the decay window, and injects a clearly-labeled
 *           tentative block into the agent prompt. Entries older than the
 *           window are pruned to <userKey>.archive.json at the same time.
 *   WRITE — agent-driven. The store dir is mounted writable into the main
 *           group's container at /workspace/working-context, and the
 *           injected block instructs the agent to update its file at the
 *           end of each substantive exchange. (There is no agent-side
 *           "session close" hook where an LLM is still available — the
 *           container is torn down by a host-written _close sentinel — so
 *           per-exchange updates are the crash-safe boundary.)
 *
 * PRIVACY GATE: scoped to the single admin user only (the main
 * program-telegram group). Per-student stores are BLOCKED on the open
 * "Coordinator user privacy" question — the store is keyed by userKey so
 * generalizing later is trivial, but resolveWorkingContextUser() must not
 * be widened until that question is resolved by Avery.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, TIMEZONE } from './config.js';
import { handoffExample, parseHandoff } from './handoff.js';
import {
  ensureDirInTree,
  listFilesInTree,
  readFileInTree,
  readFileInTreeAsync,
  writeFileInTree,
} from './host-fs-safety.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface WorkingContextEntry {
  /** ISO timestamp (date or datetime) when the entry was written/updated. */
  ts: string;
  /** thread = active workstream · position = tentative lean/half-decision ·
   *  reasoning = in-progress "evaluating X because Y" · style = user cue ·
   *  handoff = something handed to a person with a reply expected (G42-adjacent;
   *  carries the extra fields HandoffEntry declares and is reported by the
   *  weekly exceptions digest rather than injected into the prompt). */
  type: 'thread' | 'position' | 'reasoning' | 'style' | 'handoff';
  /**
   * Required for the four conversational types. Optional ONLY for `handoff`,
   * which Coordinator writes as structured fields (`to` / `artifact` / `expected`)
   * with no prose body — validating `text` on those would silently drop every
   * real handoff.
   */
  text?: string;
  /** Optional KB references (file paths / heading names). Reference only —
   *  never a substitute for the KB entry itself. */
  refs?: string[];
}

const VALID_TYPES = new Set([
  'thread',
  'position',
  'reasoning',
  'style',
  'handoff',
]);

/**
 * Types that are conversational working notes and belong in the injected
 * prompt section. `handoff` is deliberately absent: it is structured
 * digest data (recipient / artifact / ping_after / gotcha) that renders as
 * noise in a prose note list, and the weekly exceptions report is its
 * surface. It must still survive `loadWorkingContext`; otherwise
 * every persisted handoff is silently dropped on read and
 * the register can never report one.
 */
const INJECTED_TYPES = new Set(['thread', 'position', 'reasoning', 'style']);

/** Decay window: entries older than this are excluded on read and pruned. */
export const DEFAULT_DECAY_WINDOW_DAYS = 14;
/** Cap on entries injected into the prompt (most recent first). */
const MAX_INJECTED_ENTRIES = 40;
/** Cap on rendered characters of the injected entry list. */
const MAX_INJECTED_CHARS = 6000;

/** Path of the store dir inside the (main) agent container. */
export const CONTAINER_WORKING_CONTEXT_DIR = '/workspace/working-context';

export function getDecayWindowMs(): number {
  const days = parseInt(
    process.env.WORKING_CONTEXT_WINDOW_DAYS ||
      String(DEFAULT_DECAY_WINDOW_DAYS),
    10,
  );
  const safeDays =
    Number.isFinite(days) && days > 0 ? days : DEFAULT_DECAY_WINDOW_DAYS;
  return safeDays * 24 * 60 * 60 * 1000;
}

/** Container user; host rewrites of the store stay editable by the agent. */
const CONTAINER_OWNER = { uid: 1000, gid: 1000 };

export function getWorkingContextDir(baseDir: string = DATA_DIR): string {
  return path.join(baseDir, 'working-context');
}

const USER_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidUserKey(userKey: string): boolean {
  return USER_KEY_PATTERN.test(userKey);
}

/**
 * Resolve which user's working context (if any) applies to this group.
 *
 * PRIVACY GATE — admin-only for now. Only the main control group
 * (program-telegram, i.e. Avery) gets a working-context store. Do NOT widen
 * this to email/web-chat/student groups until the open "Coordinator user privacy"
 * question is resolved. The per-userKey store layout means generalizing
 * later requires only changing this function.
 */
export function resolveWorkingContextUser(
  group: RegisteredGroup,
): string | null {
  if (group.isMain !== true) return null;
  return resolveAdminUserKey();
}

/**
 * The configured admin key, falling back to `avery` when unset or invalid.
 *
 * Callers must go through this rather than reading the env var directly:
 * `loadWorkingContext` validates the key inside `storeFilePath`, which
 * THROWS before its own try/catch, so a malformed `WORKING_CONTEXT_ADMIN_KEY`
 * propagates out. In the scheduler that would abort the whole exceptions
 * report, leaving the digest task to consume a stale file.
 */
export function resolveAdminUserKey(): string {
  const key = process.env.WORKING_CONTEXT_ADMIN_KEY || 'avery';
  return isValidUserKey(key) ? key : 'avery';
}

function storeFilePath(userKey: string, baseDir: string): string {
  if (!isValidUserKey(userKey)) {
    throw new Error(`Invalid working-context user key "${userKey}"`);
  }
  return path.join(getWorkingContextDir(baseDir), `${userKey}.json`);
}

function archiveFilePath(userKey: string, baseDir: string): string {
  if (!isValidUserKey(userKey)) {
    throw new Error(`Invalid working-context user key "${userKey}"`);
  }
  return path.join(getWorkingContextDir(baseDir), `${userKey}.archive.json`);
}

/**
 * Entries that must NOT decay out of the store on the normal 14-day window.
 *
 * An unresolved handoff is the one thing here whose whole purpose is to
 * outlive the conversation that created it: `ts` is when it was SENT, but it
 * stays actionable until a reply arrives, which is often well past `ping_after`
 * — the longer it goes unanswered, the more it matters and the more certainly
 * plain `ts` decay would delete it. Archiving it would silently drop exactly
 * the overdue items the weekly register exists to surface. Resolved handoffs
 * decay normally; they are history.
 */
function isDecayExempt(e: WorkingContextEntry): boolean {
  // Only a VALID unresolved handoff is exempt — parseHandoff is the single
  // authority on validity, and isEntry has already dropped invalid ones on
  // read, so a malformed entry can never be exempt-but-invisible.
  const h = parseHandoff(e);
  return h !== null && !h.resolved;
}

function isEntry(value: unknown): value is WorkingContextEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  // Handoffs delegate ENTIRELY to the single owner — before any shared
  // checks. The refs check below must never apply to them: parseHandoff
  // treats refs as unvalidated decoration, so a `refs: [null]` handoff that
  // the register would report must not be silently dropped here
  // (loader/register disagreement).
  if (e.type === 'handoff') {
    return parseHandoff(e) !== null;
  }
  const baseOk =
    typeof e.ts === 'string' &&
    !Number.isNaN(Date.parse(e.ts)) &&
    typeof e.type === 'string' &&
    VALID_TYPES.has(e.type) &&
    (e.refs === undefined ||
      (Array.isArray(e.refs) && e.refs.every((r) => typeof r === 'string')));
  if (!baseOk) return false;
  return typeof e.text === 'string' && e.text.trim().length > 0;
}

/**
 * Load all valid entries for a user. Tolerates a missing, empty, corrupt,
 * or agent-mangled file (invalid entries are dropped, never thrown on).
 */
export function loadWorkingContext(
  userKey: string,
  baseDir: string = DATA_DIR,
): WorkingContextEntry[] {
  const file = storeFilePath(userKey, baseDir);
  try {
    // Agent-writable dir: never read through a planted link or FIFO.
    const raw = readFileInTree(path.dirname(file), path.basename(file));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch (err) {
    logger.warn({ userKey, err }, 'working-context: unreadable store file');
    return [];
  }
}

/**
 * Async twin of `loadWorkingContext`, for callers on an async path.
 *
 * The scheduler runs inside the shared event loop: a synchronous read there
 * stalls every concurrent channel handler until it returns, and this file is
 * agent-written so its size is not bounded by anything we control. Same
 * tolerance as the sync version — missing, empty, corrupt, or agent-mangled
 * files yield [] rather than throwing.
 */
export async function loadWorkingContextAsync(
  userKey: string,
  baseDir: string = DATA_DIR,
): Promise<WorkingContextEntry[]> {
  let file: string;
  try {
    file = storeFilePath(userKey, baseDir);
  } catch (err) {
    logger.warn({ userKey, err }, 'working-context: invalid user key');
    return [];
  }
  try {
    const raw = await readFileInTreeAsync(
      path.dirname(file),
      path.basename(file),
    );
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      logger.warn({ userKey, err }, 'working-context: unreadable store file');
    }
    return [];
  }
}

/** Entries within the decay window, newest first. */
export function filterRecentEntries(
  entries: WorkingContextEntry[],
  now: Date = new Date(),
  windowMs: number = getDecayWindowMs(),
): WorkingContextEntry[] {
  const cutoff = now.getTime() - windowMs;
  return entries
    .filter((e) => {
      const t = Date.parse(e.ts);
      // Entries "from the future" (clock skew, bad agent write) still count
      // as recent rather than silently vanishing.
      return t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

/**
 * Rewrite the store keeping only in-window entries; expired entries are
 * appended to <userKey>.archive.json (kept for inspection, never re-read).
 * Called on session start so stale tentative positions can't resurface.
 */
export function pruneStaleEntries(
  userKey: string,
  baseDir: string = DATA_DIR,
  now: Date = new Date(),
  windowMs: number = getDecayWindowMs(),
): void {
  const all = loadWorkingContext(userKey, baseDir);
  if (all.length === 0) return;
  const cutoff = now.getTime() - windowMs;
  const isStale = (e: WorkingContextEntry) =>
    Date.parse(e.ts) < cutoff && !isDecayExempt(e);
  const fresh = all.filter((e) => !isStale(e));
  const stale = all.filter(isStale);
  if (stale.length === 0) return;

  try {
    const archiveFile = archiveFilePath(userKey, baseDir);
    const dir = getWorkingContextDir(baseDir);
    let archived: WorkingContextEntry[] = [];
    try {
      const raw = readFileInTree(dir, path.basename(archiveFile));
      const parsed: unknown = raw === null ? null : JSON.parse(raw);
      if (Array.isArray(parsed)) archived = parsed.filter(isEntry);
    } catch {
      // Corrupt or linked archive: start fresh rather than losing the store.
    }
    // The agent (uid 1000) edits the store, so rewritten files go back to it.
    writeFileInTree(
      dir,
      path.basename(archiveFile),
      JSON.stringify([...archived, ...stale], null, 2) + '\n',
      CONTAINER_OWNER,
    );
    writeFileInTree(
      dir,
      path.basename(storeFilePath(userKey, baseDir)),
      JSON.stringify(fresh, null, 2) + '\n',
      CONTAINER_OWNER,
    );
    logger.info(
      { userKey, archivedCount: stale.length, keptCount: fresh.length },
      'working-context: pruned stale entries',
    );
  } catch (err) {
    logger.warn({ userKey, err }, 'working-context: prune failed');
  }
}

/**
 * Retention (src/retention.ts): drop archive entries written before
 * `cutoffMs` from every `<userKey>.archive.json`. The archive is kept for
 * inspection and never read back, so no pending work depends on it. The live
 * store file is not touched. An element without a readable `ts`, and a file
 * that is not a JSON array, are left as they are. With `dryRun` nothing is
 * written and the counts are the ones a real run removes.
 */
export function pruneWorkingContextArchives(
  cutoffMs: number,
  dryRun: boolean,
  baseDir: string = DATA_DIR,
): { deleted: number; kept: number } {
  const dir = getWorkingContextDir(baseDir);
  let deleted = 0;
  let kept = 0;
  for (const file of listFilesInTree(dir) ?? []) {
    if (!file.name.endsWith('.archive.json')) continue;
    if (!isValidUserKey(file.name.slice(0, -'.archive.json'.length))) continue;
    let parsed: unknown;
    try {
      const raw = readFileInTree(dir, file.name);
      parsed = raw === null ? null : JSON.parse(raw);
    } catch {
      continue; // unreadable, linked or corrupt: leave it
    }
    if (!Array.isArray(parsed)) continue;
    const isOld = (e: unknown): boolean => {
      const ts = (e as { ts?: unknown } | null)?.ts;
      if (typeof ts !== 'string') return false;
      const at = Date.parse(ts);
      return Number.isFinite(at) && at < cutoffMs;
    };
    const fresh = parsed.filter((e) => !isOld(e));
    const removed = parsed.length - fresh.length;
    deleted += removed;
    kept += fresh.length;
    if (removed === 0 || dryRun) continue;
    writeFileInTree(
      dir,
      file.name,
      JSON.stringify(fresh, null, 2) + '\n',
      CONTAINER_OWNER,
    );
  }
  return { deleted, kept };
}

/** Ensure the store dir (and the user's file) exist so the container mount
 *  has something to bind and the agent has a file to edit. */
export function ensureWorkingContextStore(
  userKey: string,
  baseDir: string = DATA_DIR,
): string {
  const dir = ensureDirInTree(getWorkingContextDir(baseDir));
  const file = storeFilePath(userKey, baseDir);
  let hasStore = false;
  try {
    hasStore = fs.lstatSync(file).isFile();
  } catch {
    // absent
  }
  // A planted link is replaced by an empty store, never written through.
  if (!hasStore)
    writeFileInTree(dir, path.basename(file), '[]\n', CONTAINER_OWNER);
  return dir;
}

function renderEntryLine(e: WorkingContextEntry): string {
  const date = e.ts.slice(0, 10);
  const refs =
    e.refs && e.refs.length > 0 ? ` (refs: ${e.refs.join(', ')})` : '';
  return `- [${date}] (${e.type}) ${e.text ?? ''}${refs}`;
}

/**
 * Build the prompt section injected at session start. Always includes the
 * guardrail framing and maintenance instructions (so the agent knows how to
 * write the layer even when it is empty); entries themselves are filtered
 * to the decay window and capped.
 */
export function buildWorkingContextSection(
  userKey: string,
  baseDir: string = DATA_DIR,
  now: Date = new Date(),
): string {
  const recent = filterRecentEntries(
    loadWorkingContext(userKey, baseDir),
    now,
  ).filter((e) => INJECTED_TYPES.has(e.type));

  const lines: string[] = [];
  let used = 0;
  for (const e of recent.slice(0, MAX_INJECTED_ENTRIES)) {
    const line = renderEntryLine(e);
    if (used + line.length > MAX_INJECTED_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }

  const entriesBlock =
    lines.length > 0 ? lines.join('\n') : '(no active working notes)';
  const filePath = `${CONTAINER_WORKING_CONTEXT_DIR}/${userKey}.json`;
  const windowDays = Math.round(getDecayWindowMs() / (24 * 60 * 60 * 1000));

  return [
    `<working_context user="${userKey}" tentative="true" window_days="${windowDays}">`,
    `These are YOUR private working notes from recent sessions with this user (last ~${windowDays} days). They are TENTATIVE and possibly stale — never state them as fact. When surfacing one, present it as dated and tentative, e.g. "last session you were leaning X (${now.toISOString().slice(0, 10)} note — may be stale)". If anything here conflicts with the KB (DECISIONS.md / ACTION_ITEMS.md / OPEN_QUESTIONS.md), the KB always wins.`,
    ``,
    entriesBlock,
    ``,
    `Maintenance (do this yourself at the end of each substantive exchange):`,
    `- Update ${filePath} — a JSON array of {"ts": "<ISO date>", "type": "thread|position|reasoning|style", "text": "...", "refs": ["optional/kb/paths.md"]}.`,
    `- One extra type, "handoff", for something you handed to a person with a reply expected. It has its own shape (no "text" field) — copy this exactly and fill in the values:`,
    `  ${JSON.stringify(handoffExample(now, TIMEZONE))}`,
    `  All of those fields are required. "ping_after" must be exactly YYYY-MM-DD. Handoffs do NOT appear in the list above — they surface in the Monday exceptions digest once past "ping_after". Set "resolved": true once the reply arrives; unresolved handoffs are deliberately kept past the ${windowDays}-day window so a long-overdue one cannot vanish.`,
    `- ONLY when a handoff carries a real trap, add a "gotcha": "<the trap>" field to it. That makes it surface in the digest IMMEDIATELY, before "ping_after" — so never add it speculatively and never leave placeholder text in it, or you raise a false alarm every week.`,
    `- The file must stay valid JSON. If a write would malform it, rewrite the whole array rather than patching — an unparseable file makes ALL of these notes disappear, not just the bad entry.`,
    `- Record only WORKING state: active threads, tentative positions/half-decisions, in-progress reasoning, user-style cues. NEVER record KB facts, decisions, or institutional record here — those belong in the KB via the KB Write Protocol.`,
    `- When a tentative position becomes a real decision, graduate it to DECISIONS.md (KB Write Protocol) and REMOVE it from these notes.`,
    `- Rewrite/refresh an entry's ts when a thread is still active; entries older than ${windowDays} days are archived automatically.`,
    `- Skip the update for trivial exchanges (acknowledgements, single-fact lookups).`,
    `</working_context>`,
  ].join('\n');
}

/**
 * Convenience: everything the host read-path needs at session start.
 * Returns the injectable section, or null when the group has no
 * working-context user (privacy gate) — in which case nothing is mounted
 * or injected.
 */
export function prepareWorkingContext(
  group: RegisteredGroup,
  baseDir: string = DATA_DIR,
  now: Date = new Date(),
): { userKey: string; section: string } | null {
  const userKey = resolveWorkingContextUser(group);
  if (!userKey) return null;
  try {
    ensureWorkingContextStore(userKey, baseDir);
    pruneStaleEntries(userKey, baseDir, now);
    return {
      userKey,
      section: buildWorkingContextSection(userKey, baseDir, now),
    };
  } catch (err) {
    logger.warn(
      { userKey, err },
      'working-context: prepare failed; continuing without it',
    );
    return null;
  }
}
