import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_MAX_OUTPUT_SIZE,
  DATA_DIR,
  STORE_DIR,
} from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';
import type { DeliveryShortfall } from './delivery-gate.js';
import { assertSafeDbPath } from './host-fs-safety.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Channel-owned delivery metadata must survive a restart that occurs after
  // inbound storage but before the first agent result.
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN delivery_context TEXT`);
  } catch {
    /* column already exists */
  }

  // Repair any scheduled-task prompts/scripts stored as BLOB (legacy
  // manual-restore / serialization corruption can leave Buffer values).
  try {
    database.exec(
      `UPDATE scheduled_tasks SET prompt = CAST(prompt AS TEXT) WHERE typeof(prompt) = 'blob'`,
    );
    database.exec(
      `UPDATE scheduled_tasks SET script = CAST(script AS TEXT) WHERE typeof(script) = 'blob'`,
    );
  } catch {
    /* scheduled_tasks may not exist on a fresh init until the table is created */
  }

  // Durable outbox for staggered outbound email.
  database.exec(`
    CREATE TABLE IF NOT EXISTS outbound_email_outbox (
      delivery_id TEXT PRIMARY KEY,
      lane TEXT NOT NULL,
      batch_id TEXT,
      position INTEGER,
      status TEXT NOT NULL,
      retryable INTEGER,
      email_json TEXT NOT NULL,
      send_options_json TEXT NOT NULL,
      result_json TEXT,
      intended_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      claim_pid INTEGER,
      claim_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT
    )
  `);
  // Retry budget columns (round 4) for outboxes created before them.
  try {
    database.exec(
      `ALTER TABLE outbound_email_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE outbound_email_outbox ADD COLUMN next_attempt_at TEXT`,
    );
  } catch {
    /* column already exists */
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_outbox_lane_status_created
    ON outbound_email_outbox(lane, status, created_at)
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_outbox_terminal_at
    ON outbound_email_outbox(terminal_at)
  `);

  // Pending delivery shortfalls, flushed once the owner alerter is available.
  // A row leaves this table only when a channel confirms the alert (round 4);
  // claim_pid/claim_expires_at make an in-flight alert visible to the next
  // process instead of losing it with the one that was delivering it.
  // RC-018: host record of what an agent-requested send actually
  // did, keyed by delivery id, injected into that group's NEXT run and then
  // consumed. Not a chat message: a stored message would start a main-group
  // run on its own.
  database.exec(`
    CREATE TABLE IF NOT EXISTS delivery_notes (
      delivery_id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed_at TEXT
    )
  `);
  // Routed approvals (G42 Tier 2 email-group relay, v9.10). Evidence is the
  // host's own copy of each inbound email (sender, subject, text), written at
  // intake and never by a container, so a Routed Approvals entry can be
  // checked against what the sender really wrote. Times are epoch ms.
  database.exec(`
    CREATE TABLE IF NOT EXISTS routed_approval_evidence (
      raw_path TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      subject TEXT NOT NULL,
      message_id TEXT,
      received_at INTEGER NOT NULL,
      texts_json TEXT NOT NULL
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS routed_approvals (
      key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      sender TEXT NOT NULL,
      sender_name TEXT,
      approver_email TEXT,
      approver_name TEXT,
      subject TEXT,
      quotes_json TEXT NOT NULL DEFAULT '[]',
      trusted_addresses_json TEXT NOT NULL DEFAULT '[]',
      received_at INTEGER,
      status TEXT NOT NULL,
      hold_reason TEXT,
      created_at INTEGER NOT NULL,
      relay_count INTEGER NOT NULL DEFAULT 0,
      relay_submitted INTEGER NOT NULL DEFAULT 0,
      last_relay_at INTEGER,
      owner_notified_at INTEGER,
      last_owner_ping_at INTEGER,
      pending_notice TEXT,
      closed_at INTEGER
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS pending_delivery_shortfalls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shortfall_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      claim_pid INTEGER,
      claim_expires_at TEXT
    )
  `);
  try {
    database.exec(
      `ALTER TABLE pending_delivery_shortfalls ADD COLUMN claim_pid INTEGER`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE pending_delivery_shortfalls ADD COLUMN claim_expires_at TEXT`,
    );
  } catch {
    /* column already exists */
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  assertSafeDbPath(dbPath); // store/ is writable for the main group

  db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/**
 * @internal - for tests only. Creates a fresh in-memory database by default,
 * or opens the supplied path so restart persistence can be exercised.
 */
export function _initTestDatabase(dbPath = ':memory:'): void {
  if (db?.open) db.close();
  db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

/** Return the active database connection. Throws if initDatabase/_initTestDatabase has not run. */
export function getDatabase(): Database.Database {
  if (!db?.open) {
    throw new Error(
      'Database not initialized. Call initDatabase() or _initTestDatabase() first.',
    );
  }
  return db;
}

// --- Pending delivery shortfalls (G46 alert replay on startup) ---

export function storePendingDeliveryShortfall(
  shortfall: DeliveryShortfall,
): void {
  db.prepare(
    `INSERT INTO pending_delivery_shortfalls (shortfall_json, created_at) VALUES (?, ?)`,
  ).run(JSON.stringify(shortfall), new Date().toISOString());
}

export function getPendingDeliveryShortfalls(): DeliveryShortfall[] {
  const rows = db
    .prepare(
      `SELECT shortfall_json FROM pending_delivery_shortfalls ORDER BY id`,
    )
    .all() as Array<{ shortfall_json: string }>;
  return rows.map((r) => JSON.parse(r.shortfall_json) as DeliveryShortfall);
}

export function clearPendingDeliveryShortfalls(): void {
  db.prepare(`DELETE FROM pending_delivery_shortfalls`).run();
}

export interface ClaimedDeliveryShortfall {
  id: number;
  shortfall: DeliveryShortfall;
}

/** Default lease for an alert claim: long enough for a channel send, short
 * enough that a crashed process's alerts replay on the next startup. */
export const DELIVERY_SHORTFALL_CLAIM_LEASE_MS = 60_000;

/**
 * Take ownership of every alert that is not already being delivered. The rows
 * stay in the table: only a confirmed send may delete one
 * (deletePendingDeliveryShortfall), and a failed send releases the claim
 * (releasePendingDeliveryShortfallClaim) so the next alerter retries it.
 */
export function claimPendingDeliveryShortfalls(
  processId: number,
  leaseMs: number = DELIVERY_SHORTFALL_CLAIM_LEASE_MS,
  now: number = Date.now(),
): ClaimedDeliveryShortfall[] {
  const rows = db
    .prepare(
      `UPDATE pending_delivery_shortfalls
         SET claim_pid = @process_id, claim_expires_at = @expires
       WHERE claim_expires_at IS NULL OR claim_expires_at <= @now
       RETURNING id, shortfall_json`,
    )
    .all({
      process_id: processId,
      expires: new Date(now + leaseMs).toISOString(),
      now: new Date(now).toISOString(),
    }) as Array<{ id: number; shortfall_json: string }>;
  return rows.map((r) => ({
    id: r.id,
    shortfall: JSON.parse(r.shortfall_json) as DeliveryShortfall,
  }));
}

/** Call ONLY after a channel confirmed the alert was transmitted. */
export function deletePendingDeliveryShortfall(id: number): void {
  db.prepare(`DELETE FROM pending_delivery_shortfalls WHERE id = ?`).run(id);
}

/** Return a claimed alert to the queue after a failed delivery attempt. */
export function releasePendingDeliveryShortfallClaim(id: number): void {
  db.prepare(
    `UPDATE pending_delivery_shortfalls
       SET claim_pid = NULL, claim_expires_at = NULL
     WHERE id = ?`,
  ).run(id);
}

/** Recover alerts whose delivering process died holding the claim. */
export function resetExpiredDeliveryShortfallClaims(
  now: number = Date.now(),
): number {
  return db
    .prepare(
      `UPDATE pending_delivery_shortfalls
         SET claim_pid = NULL, claim_expires_at = NULL
       WHERE claim_expires_at IS NOT NULL AND claim_expires_at <= @now`,
    )
    .run({ now: new Date(now).toISOString() }).changes;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  const deliveryContext = serializeDeliveryContext(msg.delivery_context);
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name, delivery_context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
    deliveryContext,
  );
}

function serializeDeliveryContext(value: unknown): string | null {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return null;
  if (Buffer.byteLength(serialized, 'utf8') > CONTAINER_MAX_OUTPUT_SIZE) {
    throw new Error('Inbound delivery context exceeds the maximum size');
  }
  return serialized;
}

type StoredMessageRow = Omit<NewMessage, 'delivery_context'> & {
  delivery_context: string | null;
};

function hydrateDeliveryContext(rows: StoredMessageRow[]): NewMessage[] {
  return rows.map((row) => {
    if (row.delivery_context === null) {
      const { delivery_context: _absent, ...message } = row;
      return message;
    }
    try {
      return { ...row, delivery_context: JSON.parse(row.delivery_context) };
    } catch {
      // Preserve a malformed value so the channel's strict restore validator
      // rejects it instead of silently falling back to mutable in-memory data.
      return { ...row, delivery_context: row.delivery_context };
    }
  });
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name,
             delivery_context
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as StoredMessageRow[];
  const messages = hydrateDeliveryContext(rows);

  let newTimestamp = lastTimestamp;
  for (const row of messages) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name,
             delivery_context
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const rows = db
    .prepare(sql)
    .all(
      chatJid,
      sinceTimestamp,
      `${botPrefix}:%`,
      limit,
    ) as StoredMessageRow[];
  return hydrateDeliveryContext(rows);
}

export function getRecentMessages(
  chatJid: string,
  limit: number = 10,
  opts?: { beforeTimestamp?: string },
): NewMessage[] {
  const beforeTimestamp = opts?.beforeTimestamp;
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             is_bot_message, reply_to_message_id, reply_to_message_content,
             reply_to_sender_name, delivery_context
      FROM messages
      WHERE chat_jid = ?
        ${beforeTimestamp ? 'AND timestamp < ?' : ''}
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  const params = beforeTimestamp
    ? [chatJid, beforeTimestamp, limit]
    : [chatJid, limit];
  const rows = db.prepare(sql).all(...params) as StoredMessageRow[];
  return hydrateDeliveryContext(rows);
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

function normalizeTaskText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  // Support Buffer's toJSON form, e.g. from a snapshot or manual restore.
  if (
    typeof value === 'object' &&
    (value as { type?: string }).type === 'Buffer' &&
    Array.isArray((value as { data?: number[] }).data)
  ) {
    try {
      return Buffer.from((value as { data: number[] }).data).toString('utf-8');
    } catch (_err) {
      // fall through to generic string coercion
    }
  }
  return String(value);
}

function normalizePrompt(value: unknown): string {
  return normalizeTaskText(value) ?? '';
}

function normalizeScheduledTaskRow(row: unknown): ScheduledTask {
  const task = row as ScheduledTask;
  return {
    ...task,
    prompt: normalizePrompt(task.prompt),
    script: normalizeTaskText(task.script),
  };
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    normalizePrompt(task.prompt),
    normalizeTaskText(task.script) ?? null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined;
  if (!row) return undefined;
  return normalizeScheduledTaskRow(row);
}

export function getAllTasks(): ScheduledTask[] {
  const rows = db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as unknown[];
  return rows.map(normalizeScheduledTaskRow);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(normalizePrompt(updates.prompt));
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(normalizeTaskText(updates.script) ?? null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as unknown[];
  return rows.map(normalizeScheduledTaskRow);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function getTaskRunsSince(since: string): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE run_at >= ?
    ORDER BY run_at DESC
  `,
    )
    .all(since) as TaskRunLog[];
}

export function getLastTaskRunAt(): string | null {
  const row = db
    .prepare('SELECT MAX(run_at) AS run_at FROM task_run_logs')
    .get() as { run_at: string | null };
  return row.run_at;
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

export function deleteRouterState(key: string): void {
  db.prepare('DELETE FROM router_state WHERE key = ?').run(key);
}

// --- Session accessors ---

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}

// --- Delivery notes (RC-018) ---

export function upsertDeliveryNote(
  deliveryId: string,
  groupFolder: string,
  note: string,
): void {
  db.prepare(
    `INSERT INTO delivery_notes (delivery_id, group_folder, note, created_at, consumed_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(delivery_id) DO UPDATE SET
       group_folder = excluded.group_folder,
       note = excluded.note,
       created_at = excluded.created_at,
       consumed_at = NULL`,
  ).run(deliveryId, groupFolder, note, new Date().toISOString());
}

/** Unconsumed notes for any of `keys` (group folder or chat jid), oldest first. */
export function peekDeliveryNotes(
  keys: string[],
): { id: string; note: string }[] {
  if (keys.length === 0) return [];
  const placeholders = keys.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT delivery_id, note FROM delivery_notes
       WHERE group_folder IN (${placeholders}) AND consumed_at IS NULL
       ORDER BY created_at ASC`,
    )
    .all(...keys) as { delivery_id: string; note: string }[];
  return rows.map((r) => ({ id: r.delivery_id, note: r.note }));
}

/** Mark notes consumed once the run that read them completed successfully. */
export function ackDeliveryNotes(ids: string[]): void {
  if (ids.length === 0) return;
  const mark = db.prepare(
    `UPDATE delivery_notes SET consumed_at = ? WHERE delivery_id = ?`,
  );
  const now = new Date().toISOString();
  for (const id of ids) mark.run(now, id);
}

/**
 * Delete consumed notes older than `consumedMaxAgeMs` and never-read notes
 * older than `orphanMaxAgeMs` (sends whose source key no run ever queries).
 */
export function purgeDeliveryNotesOlderThan(
  consumedMaxAgeMs: number,
  orphanMaxAgeMs: number,
): number {
  const now = Date.now();
  const consumedCutoff = new Date(now - consumedMaxAgeMs).toISOString();
  const orphanCutoff = new Date(now - orphanMaxAgeMs).toISOString();
  const info = db
    .prepare(
      `DELETE FROM delivery_notes
       WHERE (consumed_at IS NOT NULL AND consumed_at <= ?)
          OR (consumed_at IS NULL AND created_at <= ?)`,
    )
    .run(consumedCutoff, orphanCutoff);
  return info.changes;
}

// --- Routed approvals (G42 Tier 2 email-group relay, v9.10) ---

export interface RoutedApprovalEvidence {
  rawPath: string;
  sender: string;
  subject: string;
  messageId?: string;
  receivedAt: number;
  /** Inbound text as the host received it (Worker text, parsed .eml text). */
  texts: string[];
}

export type RoutedApprovalStatus =
  | 'relayed'
  | 'relay-failed'
  | 'held'
  | 'notice-only'
  | 'closed'
  | 'removed';

/** A Telegram notice to Avery that is owed and not yet confirmed delivered. */
export type RoutedApprovalNotice =
  | 'created'
  | 'reminder'
  | 'removed'
  | 'relay-failed'
  | 'held';

export interface RoutedApprovalRow {
  key: string;
  title: string;
  sender: string;
  senderName?: string;
  approverEmail?: string;
  approverName?: string;
  subject?: string;
  quotes: string[];
  trustedAddresses: string[];
  receivedAt?: number;
  status: RoutedApprovalStatus;
  holdReason?: string;
  createdAt: number;
  relayCount: number;
  /** Highest relay number handed to the outbox (>= relayCount). */
  relaySubmitted: number;
  lastRelayAt?: number;
  ownerNotifiedAt?: number;
  lastOwnerPingAt?: number;
  pendingNotice?: RoutedApprovalNotice;
  closedAt?: number;
}

export function putRoutedApprovalEvidence(e: RoutedApprovalEvidence): void {
  db.prepare(
    `INSERT INTO routed_approval_evidence
       (raw_path, sender, subject, message_id, received_at, texts_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(raw_path) DO UPDATE SET
       sender = excluded.sender,
       subject = excluded.subject,
       message_id = excluded.message_id,
       received_at = excluded.received_at,
       texts_json = excluded.texts_json`,
  ).run(
    e.rawPath,
    e.sender,
    e.subject,
    e.messageId ?? null,
    e.receivedAt,
    JSON.stringify(e.texts),
  );
}

export function getRoutedApprovalEvidence(
  rawPath: string,
): RoutedApprovalEvidence | undefined {
  const row = db
    .prepare(`SELECT * FROM routed_approval_evidence WHERE raw_path = ?`)
    .get(rawPath) as
    | {
        raw_path: string;
        sender: string;
        subject: string;
        message_id: string | null;
        received_at: number;
        texts_json: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    rawPath: row.raw_path,
    sender: row.sender,
    subject: row.subject,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    receivedAt: row.received_at,
    texts: JSON.parse(row.texts_json) as string[],
  };
}

export function pruneRoutedApprovalEvidence(beforeMs: number): number {
  return db
    .prepare(`DELETE FROM routed_approval_evidence WHERE received_at < ?`)
    .run(beforeMs).changes;
}

interface RoutedApprovalDbRow {
  key: string;
  title: string;
  sender: string;
  sender_name: string | null;
  approver_email: string | null;
  approver_name: string | null;
  subject: string | null;
  quotes_json: string;
  trusted_addresses_json: string;
  received_at: number | null;
  status: RoutedApprovalStatus;
  hold_reason: string | null;
  created_at: number;
  relay_count: number;
  relay_submitted: number;
  last_relay_at: number | null;
  owner_notified_at: number | null;
  last_owner_ping_at: number | null;
  pending_notice: RoutedApprovalNotice | null;
  closed_at: number | null;
}

function routedApprovalFromDb(r: RoutedApprovalDbRow): RoutedApprovalRow {
  const opt = <T>(v: T | null): T | undefined => (v === null ? undefined : v);
  return {
    key: r.key,
    title: r.title,
    sender: r.sender,
    senderName: opt(r.sender_name),
    approverEmail: opt(r.approver_email),
    approverName: opt(r.approver_name),
    subject: opt(r.subject),
    quotes: JSON.parse(r.quotes_json) as string[],
    trustedAddresses: JSON.parse(r.trusted_addresses_json) as string[],
    receivedAt: opt(r.received_at),
    status: r.status,
    holdReason: opt(r.hold_reason),
    createdAt: r.created_at,
    relayCount: r.relay_count,
    relaySubmitted: r.relay_submitted,
    lastRelayAt: opt(r.last_relay_at),
    ownerNotifiedAt: opt(r.owner_notified_at),
    lastOwnerPingAt: opt(r.last_owner_ping_at),
    pendingNotice: opt(r.pending_notice),
    closedAt: opt(r.closed_at),
  };
}

const ROUTED_APPROVAL_COLUMNS: Record<keyof RoutedApprovalRow, string> = {
  key: 'key',
  title: 'title',
  sender: 'sender',
  senderName: 'sender_name',
  approverEmail: 'approver_email',
  approverName: 'approver_name',
  subject: 'subject',
  quotes: 'quotes_json',
  trustedAddresses: 'trusted_addresses_json',
  receivedAt: 'received_at',
  status: 'status',
  holdReason: 'hold_reason',
  createdAt: 'created_at',
  relayCount: 'relay_count',
  relaySubmitted: 'relay_submitted',
  lastRelayAt: 'last_relay_at',
  ownerNotifiedAt: 'owner_notified_at',
  lastOwnerPingAt: 'last_owner_ping_at',
  pendingNotice: 'pending_notice',
  closedAt: 'closed_at',
};

function routedApprovalDbValue(
  field: keyof RoutedApprovalRow,
  value: unknown,
): unknown {
  if (field === 'quotes' || field === 'trustedAddresses') {
    return JSON.stringify(value ?? []);
  }
  return value === undefined ? null : value;
}

export function getRoutedApproval(key: string): RoutedApprovalRow | undefined {
  const row = db
    .prepare(`SELECT * FROM routed_approvals WHERE key = ?`)
    .get(key) as RoutedApprovalDbRow | undefined;
  return row ? routedApprovalFromDb(row) : undefined;
}

/** Insert once. False when the key already exists (another scan got there first). */
export function insertRoutedApproval(row: RoutedApprovalRow): boolean {
  const fields = Object.keys(ROUTED_APPROVAL_COLUMNS) as Array<
    keyof RoutedApprovalRow
  >;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO routed_approvals (${fields
        .map((f) => ROUTED_APPROVAL_COLUMNS[f])
        .join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    )
    .run(...fields.map((f) => routedApprovalDbValue(f, row[f])));
  return info.changes === 1;
}

export function updateRoutedApproval(
  key: string,
  patch: Partial<Omit<RoutedApprovalRow, 'key'>>,
): void {
  const fields = Object.keys(patch) as Array<
    keyof Omit<RoutedApprovalRow, 'key'>
  >;
  if (fields.length === 0) return;
  db.prepare(
    `UPDATE routed_approvals SET ${fields
      .map((f) => `${ROUTED_APPROVAL_COLUMNS[f]} = ?`)
      .join(', ')} WHERE key = ?`,
  ).run(...fields.map((f) => routedApprovalDbValue(f, patch[f])), key);
}

/** Rows still waiting on someone: everything not closed or removed. */
export function listOpenRoutedApprovals(): RoutedApprovalRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM routed_approvals
         WHERE status NOT IN ('closed', 'removed')
         ORDER BY created_at ASC`,
      )
      .all() as RoutedApprovalDbRow[]
  ).map(routedApprovalFromDb);
}

/** Rows, in any status, with a relay handed to the outbox but not recorded. */
export function listRoutedApprovalsWithUnrecordedRelay(): RoutedApprovalRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM routed_approvals
         WHERE relay_submitted > relay_count
         ORDER BY created_at ASC`,
      )
      .all() as RoutedApprovalDbRow[]
  ).map(routedApprovalFromDb);
}

/** Rows with a Telegram notice still owed, in any status, oldest first. */
export function listRoutedApprovalsWithPendingNotice(): RoutedApprovalRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM routed_approvals
         WHERE pending_notice IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all() as RoutedApprovalDbRow[]
  ).map(routedApprovalFromDb);
}
