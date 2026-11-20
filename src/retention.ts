/**
 * Retention for the stores on the host that no other code prunes.
 *
 * Each store has one setting, a whole number of days. The default, 0, means
 * "keep forever": with no retention setting the host starts no timer and
 * deletes nothing here, exactly as before this file existed.
 *
 * Rules every store follows:
 *  - Nothing a pending operation needs is deleted. Each store's function
 *    says what that is for it.
 *  - Files are found and removed through src/host-fs-safety.ts, so a link
 *    planted by a container is never followed and never deleted through.
 *  - A run is planned first and then applied: a dry run and a real run over
 *    the same state report the same counts.
 *  - One log line per run, with counts and no content.
 *
 * The program repo and the audit log are not pruned here or anywhere:
 * docs/data-handling.md, "Retention and deletion".
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { ASSISTANT_NAME, DATA_DIR, GROUPS_DIR, STORE_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { EXCEPTIONS_REPORT_LOOKBACK_MS } from './exceptions-report.js';
import { isValidGroupFolder } from './group-folder.js';
import {
  assertSafeDbPath,
  listFilesInTree,
  unlinkFileInTree,
} from './host-fs-safety.js';
import { logger } from './logger.js';
import { approvedEmailOutreachTaskId } from './send-email-capability.js';
import { pruneWorkingContextArchives } from './working-context.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 100 years. A larger value is a typing mistake, not a retention period. */
const MAX_DAYS = 36_500;

export const RETENTION_SETTINGS = {
  messages: 'RETENTION_MESSAGES_DAYS',
  routedApprovals: 'RETENTION_ROUTED_APPROVALS_DAYS',
  tasks: 'RETENTION_TASKS_DAYS',
  transcriptArchives: 'RETENTION_TRANSCRIPT_ARCHIVE_DAYS',
  uploads: 'RETENTION_UPLOADS_DAYS',
  workingContextArchive: 'RETENTION_WORKING_CONTEXT_ARCHIVE_DAYS',
  evals: 'RETENTION_EVALS_DAYS',
  ipcErrors: 'RETENTION_IPC_ERRORS_DAYS',
} as const;

export type RetentionStore = keyof typeof RETENTION_SETTINGS;
/** Days per store; 0 keeps everything. */
export type RetentionConfig = Record<RetentionStore, number>;

const STORES = Object.keys(RETENTION_SETTINGS) as RetentionStore[];

/**
 * One setting's value in days. Empty or absent is 0. Anything that is not a
 * whole number from 0 to MAX_DAYS throws: a negative number, a fraction
 * (which would delete data less than a day old), text, or a unit suffix.
 */
export function parseRetentionDays(
  key: string,
  raw: string | undefined,
): number {
  const value = (raw ?? '').trim();
  if (value === '') return 0;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${key} must be a whole number of days, 0 or more (got "${value}"). ` +
        '0 keeps everything. A fraction is refused because the shortest ' +
        'window is one day.',
    );
  }
  const days = Number(value);
  if (days > MAX_DAYS) {
    throw new Error(`${key} must be at most ${MAX_DAYS} days (got "${value}")`);
  }
  return days;
}

/**
 * Read every retention setting from the process environment, then `.env`
 * (the process environment wins, as in config.ts). Throws one error that
 * names every bad value. main() calls this first, so a bad value stops the
 * host before anything starts.
 */
export function readRetentionConfig(
  env: Record<string, string | undefined> = process.env,
  envFile: Record<string, string> = readEnvFile(
    Object.values(RETENTION_SETTINGS),
  ),
): RetentionConfig {
  const problems: string[] = [];
  const config = {} as RetentionConfig;
  for (const store of STORES) {
    const key = RETENTION_SETTINGS[store];
    try {
      config[store] = parseRetentionDays(key, env[key] || envFile[key]);
    } catch (err) {
      config[store] = 0;
      problems.push((err as Error).message);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `The host will not start with an invalid retention setting. ${problems.join(' ')} ` +
        'See config/instance.env.example.',
    );
  }
  return config;
}

export function retentionEnabled(config: RetentionConfig): boolean {
  return STORES.some((store) => config[store] > 0);
}

/** What one store's prune did (or, in a dry run, would do). */
export interface StoreResult {
  /** Rows, files or entries removed. */
  deleted: number;
  /** Old enough to delete, kept because something still needs it. */
  keptNeeded?: number;
  /** Refused by the path-safety checks (a link, a hard link). */
  refused?: number;
  /** The whole store was left alone, and why. */
  skipped?: string;
}

export type RetentionReport = Partial<Record<RetentionStore, StoreResult>>;

export interface RetentionPaths {
  storeDir: string;
  dataDir: string;
  groupsDir: string;
}

export interface RetentionDeps {
  /** The host's main SQLite store (store/messages.db). */
  db: Database.Database;
  now?: () => number;
  paths?: Partial<RetentionPaths>;
  /** Prefix of a bot message stored before the is_bot_message column. */
  botPrefix?: string;
  /**
   * Task ids that are never deleted. Default: the approved email-outreach
   * task (EMAIL_OUTREACH_TASK_ID), whose lifecycle belongs to the operator.
   */
  protectedTaskIds?: string[];
}

const ISO_GLOB = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*';

function cutoffFor(now: number, days: number): number {
  const cutoff = now - days * DAY_MS;
  // parseRetentionDays already guarantees this; checked again where the
  // delete is decided, so no caller can pass a shorter window.
  if (!Number.isInteger(days) || days < 1 || cutoff > now - DAY_MS) {
    throw new Error(
      `refused: a retention window of ${days} days is under one day`,
    );
  }
  return cutoff;
}

function deleteRowids(
  db: Database.Database,
  table: string,
  rowids: number[],
): void {
  const stmt = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
  db.transaction((ids: number[]) => {
    for (const id of ids) stmt.run(id);
  })(rowids);
}

/**
 * Decide and delete in one write transaction, so a second process (the
 * running host, when this is the script) cannot change a row between the
 * two. A dry run only reads, and its database may be opened read-only.
 */
function atomic<T>(db: Database.Database, dryRun: boolean, fn: () => T): T {
  return dryRun ? fn() : db.transaction(fn).immediate();
}

interface ChatCursor {
  chatJid: string;
  /** Messages after this are not yet answered. '' when unknown. */
  cursor: string;
  /** Timestamp of the newest bot message, the host's fallback cursor. */
  lastBot: string | null;
}

/**
 * The same cursor the host uses (src/index.ts, getOrRecoverCursor): the
 * saved per-chat cursor, else the newest bot message, else none. Returns
 * null when the saved state cannot be read; the caller then deletes nothing.
 */
function chatCursors(
  db: Database.Database,
  botPrefix: string,
): { seen: string; chats: ChatCursor[] } | null {
  const state = (key: string): string | undefined =>
    (
      db.prepare('SELECT value FROM router_state WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  let saved: Record<string, unknown> = {};
  const rawCursors = state('last_agent_timestamp');
  if (rawCursors) {
    try {
      const parsed: unknown = JSON.parse(rawCursors);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      )
        return null;
      saved = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  const chats = (
    db.prepare('SELECT DISTINCT chat_jid AS jid FROM messages').all() as {
      jid: string;
    }[]
  ).map(({ jid }): ChatCursor => {
    const lastBot =
      (
        db
          .prepare(
            `SELECT MAX(timestamp) AS ts FROM messages
             WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
          )
          .get(jid, `${botPrefix}:%`) as { ts: string | null }
      ).ts ?? null;
    const own = saved[jid];
    return {
      chatJid: jid,
      cursor: typeof own === 'string' && own ? own : (lastBot ?? ''),
      lastBot,
    };
  });
  return { seen: state('last_timestamp') ?? '', chats };
}

/**
 * `messages`: rows older than the window that the host has already
 * answered. Kept whatever their age:
 *  - a message after its chat's cursor (not yet processed; in a chat that
 *    needs a trigger word these wait as context for the next trigger);
 *  - a message the message loop has not seen yet;
 *  - every message of a chat with no cursor and no bot message;
 *  - the newest bot message of each chat, which the host uses to rebuild a
 *    lost cursor. Without it a restart with lost state would answer the
 *    whole remaining history again.
 */
function pruneMessages(
  db: Database.Database,
  cutoffMs: number,
  dryRun: boolean,
  botPrefix: string,
): StoreResult {
  return atomic(db, dryRun, () =>
    planAndPruneMessages(db, cutoffMs, dryRun, botPrefix),
  );
}

function planAndPruneMessages(
  db: Database.Database,
  cutoffMs: number,
  dryRun: boolean,
  botPrefix: string,
): StoreResult {
  const cursors = chatCursors(db, botPrefix);
  if (!cursors) return { deleted: 0, skipped: 'saved cursors unreadable' };
  const cutoff = new Date(cutoffMs).toISOString();
  const rowids: number[] = [];
  let keptNeeded = 0;
  const old = db.prepare(
    `SELECT rowid AS rowid, timestamp FROM messages
     WHERE chat_jid = ? AND timestamp < ? AND timestamp GLOB '${ISO_GLOB}'`,
  );
  for (const chat of cursors.chats) {
    for (const row of old.all(chat.chatJid, cutoff) as {
      rowid: number;
      timestamp: string;
    }[]) {
      const done =
        chat.cursor !== '' &&
        row.timestamp <= chat.cursor &&
        cursors.seen !== '' &&
        row.timestamp <= cursors.seen &&
        row.timestamp !== chat.lastBot;
      if (done) rowids.push(row.rowid);
      else keptNeeded++;
    }
  }
  if (!dryRun) deleteRowids(db, 'messages', rowids);
  return { deleted: rowids.length, keptNeeded };
}

/** Text of every message the host has not answered yet, in every chat. */
function pendingMessageText(db: Database.Database, botPrefix: string): string {
  const cursors = chatCursors(db, botPrefix);
  const all = (where: string, ...args: string[]): string[] =>
    (
      db.prepare(`SELECT content FROM messages ${where}`).all(...args) as {
        content: string | null;
      }[]
    ).map((r) => r.content ?? '');
  // Unreadable state: treat every stored message as pending.
  if (!cursors) return all('').join('\n');
  return cursors.chats
    .flatMap((chat) =>
      all('WHERE chat_jid = ? AND timestamp > ?', chat.chatJid, chat.cursor),
    )
    .join('\n');
}

/**
 * `routed_approvals`: rows closed or removed before the window have their
 * content cleared: title, sender, approver, subject, the quoted words, the
 * trusted addresses and the hold reason. The row itself stays, with its key
 * (the path of the mail file), status and dates. It has to: the scan creates
 * a row for any open entry in OPEN_QUESTIONS.md it has no row for, and a new
 * row mails the approver again. A kept, empty row answers "already handled"
 * exactly as the full row did, whenever the entry is reopened or re-added.
 * Not touched, whatever their age:
 *  - a row still waiting on someone (any status but closed or removed);
 *  - a row with a notice to the operator still owed (the notice quotes it);
 *  - a row with a relay handed to the outbox and not yet recorded.
 * `deleted` counts the rows cleared.
 */
function pruneRoutedApprovals(
  db: Database.Database,
  cutoffMs: number,
  dryRun: boolean,
): StoreResult {
  return atomic(db, dryRun, () => {
    const rowids = (
      db
        .prepare(
          `SELECT rowid AS rowid FROM routed_approvals
           WHERE status IN ('closed', 'removed')
             AND closed_at IS NOT NULL AND closed_at < ?
             AND pending_notice IS NULL
             AND relay_submitted <= relay_count
             AND (title <> '' OR sender <> '' OR sender_name IS NOT NULL
               OR approver_email IS NOT NULL OR approver_name IS NOT NULL
               OR subject IS NOT NULL OR quotes_json <> '[]'
               OR trusted_addresses_json <> '[]' OR hold_reason IS NOT NULL)`,
        )
        .all(cutoffMs) as { rowid: number }[]
    ).map((r) => r.rowid);
    if (!dryRun) {
      const clear = db.prepare(
        `UPDATE routed_approvals
         SET title = '', sender = '', sender_name = NULL,
             approver_email = NULL, approver_name = NULL, subject = NULL,
             quotes_json = '[]', trusted_addresses_json = '[]',
             hold_reason = NULL
         WHERE rowid = ?`,
      );
      for (const id of rowids) clear.run(id);
    }
    return { deleted: rowids.length };
  });
}

/**
 * `scheduled_tasks` and `task_run_logs`: one-time tasks that have run
 * (status `completed`), and run records, older than the window. An active or
 * paused task is never deleted, and neither are the run records of a task
 * that still exists and ran inside the window. The exceptions digest reads
 * the last seven days of run records, so the window used here is never
 * shorter than that. The newest run record is always kept, with its task:
 * `/health` reports how long ago the scheduler last ran from it. The
 * approved email-outreach task is never deleted: only the operator ends it.
 * The count is tasks plus run records.
 */
function pruneTasks(
  db: Database.Database,
  cutoffMs: number,
  now: number,
  dryRun: boolean,
  protectedTaskIds: string[],
): StoreResult {
  return atomic(db, dryRun, () =>
    planAndPruneTasks(db, cutoffMs, now, dryRun, protectedTaskIds),
  );
}

function planAndPruneTasks(
  db: Database.Database,
  cutoffMs: number,
  now: number,
  dryRun: boolean,
  protectedTaskIds: string[],
): StoreResult {
  const cutoff = new Date(
    Math.min(cutoffMs, now - EXCEPTIONS_REPORT_LOOKBACK_MS),
  ).toISOString();
  const newestRun = db
    .prepare(
      `SELECT rowid AS rowid, task_id FROM task_run_logs
       ORDER BY run_at DESC, rowid DESC LIMIT 1`,
    )
    .get() as { rowid: number; task_id: string } | undefined;
  const tasks = (
    db
      .prepare(
        `SELECT rowid AS rowid, id FROM scheduled_tasks
         WHERE status = 'completed'
           AND COALESCE(last_run, created_at) < ?
           AND COALESCE(last_run, created_at) GLOB '${ISO_GLOB}'`,
      )
      .all(cutoff) as { rowid: number; id: string }[]
  ).filter(
    (t) => !protectedTaskIds.includes(t.id) && t.id !== newestRun?.task_id,
  );
  const goneTasks = new Set(tasks.map((t) => t.id));
  const runs = (
    db
      .prepare(`SELECT rowid AS rowid, task_id, run_at FROM task_run_logs`)
      .all() as { rowid: number; task_id: string; run_at: string }[]
  ).filter(
    (r) =>
      r.rowid !== newestRun?.rowid &&
      (goneTasks.has(r.task_id) ||
        (r.run_at < cutoff && /^\d{4}-\d{2}-\d{2}T/.test(r.run_at))),
  );
  if (!dryRun) {
    // Run records first: they reference the task.
    deleteRowids(
      db,
      'task_run_logs',
      runs.map((r) => r.rowid),
    );
    deleteRowids(
      db,
      'scheduled_tasks',
      tasks.map((t) => t.rowid),
    );
  }
  return { deleted: tasks.length + runs.length };
}

/** The real group folders under groups/, by name. Links are left out. */
function groupFolders(groupsDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(groupsDir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!isValidGroupFolder(name)) return false;
    try {
      const st = fs.lstatSync(path.join(groupsDir, name));
      return st.isDirectory() && !st.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

/**
 * Delete the files directly in `root/relDir` that are older than the window
 * and that `wanted` accepts. Only single-link regular files are deleted. A
 * link on the path, and a link or hard link under a wanted name, count as
 * refused.
 */
function pruneFolder(
  root: string,
  relDir: string,
  cutoffMs: number,
  dryRun: boolean,
  wanted: (name: string) => 'delete' | 'needed' | 'ignore',
  result: StoreResult,
): void {
  let files;
  try {
    files = listFilesInTree(root, relDir, { includeUnsafe: true });
  } catch {
    result.refused = (result.refused ?? 0) + 1;
    return;
  }
  for (const file of files ?? []) {
    // A link or hard link under a name this store would delete is reported
    // and left alone. A link has no age of its own worth trusting.
    if (!file.plain) {
      if (wanted(file.name) !== 'ignore')
        result.refused = (result.refused ?? 0) + 1;
      continue;
    }
    if (file.mtimeMs >= cutoffMs) continue;
    const verdict = wanted(file.name);
    if (verdict === 'ignore') continue;
    if (verdict === 'needed') {
      result.keptNeeded = (result.keptNeeded ?? 0) + 1;
      continue;
    }
    if (dryRun) {
      result.deleted++;
      continue;
    }
    try {
      if (unlinkFileInTree(root, path.join(relDir, file.name)))
        result.deleted++;
    } catch {
      result.refused = (result.refused ?? 0) + 1;
    }
  }
}

/** The name the container hook gives a transcript archive. */
const TRANSCRIPT_ARCHIVE_RE = /^\d{4}-\d{2}-\d{2}-.+\.md$/;
/** The name src/image.ts gives a resized Telegram photo. */
const HOST_IMAGE_RE = /^img-\d+-[a-z0-9]{1,4}\.jpg$/;

/**
 * `groups/<group>/conversations/`: the Markdown transcript copies written
 * at compaction, by the name the hook gives them. The host never reads them;
 * the agent is told it may search them, and loses what is deleted. A file
 * the agent itself saved there under a `YYYY-MM-DD-<name>.md` name is
 * deleted too. Other files in that folder, and other folders, are not
 * touched.
 */
function pruneTranscriptArchives(
  groupsDir: string,
  cutoffMs: number,
  dryRun: boolean,
): StoreResult {
  const result: StoreResult = { deleted: 0 };
  for (const group of groupFolders(groupsDir)) {
    pruneFolder(
      path.join(groupsDir, group),
      'conversations',
      cutoffMs,
      dryRun,
      (name) => (TRANSCRIPT_ARCHIVE_RE.test(name) ? 'delete' : 'ignore'),
      result,
    );
  }
  return result;
}

/**
 * Telegram files: documents and their extracted text in
 * `data/telegram-uploads/<group>/`, and the resized photos the host wrote to
 * `groups/<group>/attachments/` (by the name the host gives them; anything
 * else there belongs to the agent). A file named in a message that has not
 * been answered yet is kept, with its extracted text.
 */
function pruneUploads(
  db: Database.Database,
  paths: RetentionPaths,
  cutoffMs: number,
  dryRun: boolean,
  botPrefix: string,
): StoreResult {
  const result: StoreResult = { deleted: 0 };
  const pending = pendingMessageText(db, botPrefix);
  const needed = (name: string): boolean =>
    pending.includes(name) ||
    (name.endsWith('.extracted.md') &&
      pending.includes(name.slice(0, -'.extracted.md'.length)));
  const uploadsRoot = path.join(paths.dataDir, 'telegram-uploads');
  for (const group of groupFolders(uploadsRoot)) {
    pruneFolder(
      uploadsRoot,
      group,
      cutoffMs,
      dryRun,
      (name) => (needed(name) ? 'needed' : 'delete'),
      result,
    );
  }
  for (const group of groupFolders(paths.groupsDir)) {
    pruneFolder(
      path.join(paths.groupsDir, group),
      'attachments',
      cutoffMs,
      dryRun,
      (name) =>
        !HOST_IMAGE_RE.test(name)
          ? 'ignore'
          : needed(name)
            ? 'needed'
            : 'delete',
      result,
    );
  }
  return result;
}

/**
 * `store/evals.db`, table `response_evals`: one row of scores and a short
 * note per reply. The dashboard and the weekly quality report read it; the
 * report reads seven days, so the window used here is never shorter than
 * that. The file is opened only when it exists; this never creates it.
 */
function pruneEvals(
  storeDir: string,
  cutoffMs: number,
  now: number,
  dryRun: boolean,
): StoreResult {
  cutoffMs = Math.min(cutoffMs, now - EXCEPTIONS_REPORT_LOOKBACK_MS);
  const dbPath = path.join(storeDir, 'evals.db');
  if (!fs.existsSync(dbPath)) return { deleted: 0 };
  assertSafeDbPath(dbPath); // store/ is writable for the main group
  const evals = new Database(dbPath, {
    fileMustExist: true,
    readonly: dryRun,
  });
  try {
    evals.pragma('busy_timeout = 5000');
    const hasTable = evals
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'response_evals'`,
      )
      .get();
    if (!hasTable) return { deleted: 0 };
    return atomic(evals, dryRun, () => {
      const rowids = (
        evals
          .prepare(
            `SELECT rowid AS rowid FROM response_evals
             WHERE timestamp < ? AND timestamp GLOB '${ISO_GLOB}'`,
          )
          .all(new Date(cutoffMs).toISOString()) as { rowid: number }[]
      ).map((r) => r.rowid);
      if (!dryRun) deleteRowids(evals, 'response_evals', rowids);
      return { deleted: rowids.length };
    });
  } finally {
    evals.close();
  }
}

/**
 * `data/ipc/errors/`: requests from a container that the host could not
 * process and set aside (src/ipc.ts). Nothing reads them back.
 */
function pruneIpcErrors(
  dataDir: string,
  cutoffMs: number,
  dryRun: boolean,
): StoreResult {
  const result: StoreResult = { deleted: 0 };
  pruneFolder(
    path.join(dataDir, 'ipc'),
    'errors',
    cutoffMs,
    dryRun,
    (name) => (name.endsWith('.json') ? 'delete' : 'ignore'),
    result,
  );
  return result;
}

/**
 * Run every store whose setting is above 0. A store that throws is reported
 * as skipped and does not stop the others. With `dryRun` nothing is changed.
 */
export async function runRetention(
  config: RetentionConfig,
  deps: RetentionDeps,
  opts: { dryRun?: boolean } = {},
): Promise<RetentionReport> {
  const dryRun = opts.dryRun === true;
  const now = (deps.now ?? Date.now)();
  const paths: RetentionPaths = {
    storeDir: STORE_DIR,
    dataDir: DATA_DIR,
    groupsDir: GROUPS_DIR,
    ...deps.paths,
  };
  const botPrefix = deps.botPrefix ?? ASSISTANT_NAME;
  const report: RetentionReport = {};
  const run = async (
    store: RetentionStore,
    prune: (cutoffMs: number) => StoreResult | Promise<StoreResult>,
  ): Promise<void> => {
    if (config[store] === 0) return;
    try {
      report[store] = await prune(cutoffFor(now, config[store]));
    } catch (err) {
      logger.error({ err, store }, 'Retention: store failed, left as it was');
      report[store] = { deleted: 0, skipped: 'failed; see the error above' };
    }
  };

  // Uploads first: it reads the pending messages before any row is removed.
  await run('uploads', (c) =>
    pruneUploads(deps.db, paths, c, dryRun, botPrefix),
  );
  await run('messages', (c) => pruneMessages(deps.db, c, dryRun, botPrefix));
  await run('routedApprovals', (c) => pruneRoutedApprovals(deps.db, c, dryRun));
  const protectedTaskIds = deps.protectedTaskIds ?? [
    approvedEmailOutreachTaskId(),
  ];
  await run('tasks', (c) =>
    pruneTasks(deps.db, c, now, dryRun, protectedTaskIds),
  );
  await run('transcriptArchives', (c) =>
    pruneTranscriptArchives(paths.groupsDir, c, dryRun),
  );
  await run('workingContextArchive', (c) => {
    const { deleted } = pruneWorkingContextArchives(c, dryRun, paths.dataDir);
    return { deleted };
  });
  await run('evals', (c) => pruneEvals(paths.storeDir, c, now, dryRun));
  await run('ipcErrors', (c) => pruneIpcErrors(paths.dataDir, c, dryRun));

  // Counts and store names only: never a sender, a subject or a file name.
  logger.info(
    { dryRun, days: activeDays(config), stores: report },
    dryRun ? 'Retention dry run: nothing deleted' : 'Retention prune',
  );
  return report;
}

function activeDays(config: RetentionConfig): Partial<RetentionConfig> {
  return Object.fromEntries(
    STORES.filter((s) => config[s] > 0).map((s) => [s, config[s]]),
  );
}

const PRUNE_INTERVAL_MS = DAY_MS;
const STARTUP_DELAY_MS = 60_000;

/**
 * Called from main() beside the session cleanup, on the same pattern: once
 * shortly after start, then daily. With every setting at 0 it starts
 * nothing. Returns a function that stops the timers.
 */
export function startRetention(
  config: RetentionConfig,
  deps: RetentionDeps,
): () => void {
  if (!retentionEnabled(config)) return () => {};
  const tick = (): void => {
    runRetention(config, deps).catch((err) =>
      logger.error({ err }, 'Retention prune failed'),
    );
  };
  const first = setTimeout(tick, STARTUP_DELAY_MS);
  const daily = setInterval(tick, PRUNE_INTERVAL_MS);
  first.unref?.();
  daily.unref?.();
  logger.info(
    { days: activeDays(config) },
    'Retention is on: old data in these stores will be deleted daily',
  );
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}
