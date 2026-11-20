/**
 * Durable outbox for the staggered outbound email queue.
 *
 * The outbox stores prepared envelopes, batch positions, and per-lane state
 * in the repo's existing SQLite database layer. It provides atomic
 * claim/lease, compare-and-set state transitions, and a single-process OS
 * file lock so restarts replay pending work without loss or duplicates.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { getDatabase } from './db.js';
import { assertSafeDbPath } from './host-fs-safety.js';

/**
 * `alert` carries operator alert mail (admin-alert.ts) with the transactional
 * limits. Its own lane keeps a burst of alerts from delaying replies or
 * filling their queue.
 */
export type OutboxLane = 'transactional' | 'bulk' | 'alert';

export interface OutboundEmailOutboxResult {
  status: 'sent';
  resendId: string;
}

export interface OutboundEmailOutboxFailure {
  status: 'failed';
  reason: string;
  retryable: boolean;
}

export type OutboundEmailOutboxOutcome =
  | OutboundEmailOutboxResult
  | OutboundEmailOutboxFailure;

export interface OutboxEmailPayload {
  to: string;
  cc?: string;
  subject: string;
  body: string;
  reply_to?: string;
}

export interface OutboxSendOptionsPayload {
  sourceGroup: string;
  forceBotReplyTo: boolean;
  inReplyTo?: string;
  extraHeaders?: Record<string, string>;
  toAllowlistExemption?: { reason: string };
  allowlistState?: {
    available: boolean;
    senders: string[];
    source: string;
  };
  allowlistFallbackMode?: 'closed' | 'permissive';
  trustedBodyAddresses?: string[];
  hostAddedBodySuffix?: string;
  ccDroppedNote?: string;
  deferAudit?: boolean;
  lane?: OutboxLane;
  batchId?: string;
  position?: number;
}

export interface OutboxRow {
  deliveryId: string;
  lane: OutboxLane;
  batchId?: string;
  position?: number;
  status: 'pending' | 'claimed' | 'sent' | 'failed' | 'dead-letter';
  email: OutboxEmailPayload;
  sendOptions: OutboxSendOptionsPayload;
  result?: OutboundEmailOutboxOutcome;
  intended: string[];
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  claimPid?: number;
  claimExpiresAt?: string;
  /** Send attempts finalized so far (drives the retry budget). */
  attempts?: number;
  /** Earliest time a retryable row may be claimed again (backoff). */
  nextAttemptAt?: string;
}

export interface OutboxStore {
  get(deliveryId: string): OutboxRow | undefined;
  set(row: OutboxRow): void;
  insert(row: OutboxRow): void;
  delete(deliveryId: string): void;
  listPending(lane?: OutboxLane, maxAgeMs?: number): OutboxRow[];
  getPendingCount(lane: OutboxLane, maxAgeMs: number): number;
  listAll(): OutboxRow[];
  clear(): void;

  /**
   * Atomically claim the next pending/retriable row in a lane.
   * Returns the claimed row (status 'claimed') or undefined if no work.
   *
   * `excludeDeliveryId` is the row the caller has just finished with: claiming
   * a row the caller will then skip strands it as 'claimed' forever (round-3
   * review P1), so the exclusion belongs INSIDE the atomic statement, not in a
   * post-hoc check. Rows whose backoff has not elapsed are also not claimable.
   */
  claimNextPending(
    lane: OutboxLane,
    now: number,
    processId: number,
    leaseMs: number,
    maxAgeMs: number,
    excludeDeliveryId?: string,
  ): OutboxRow | undefined;

  /**
   * Compare-and-set a claimed row to a terminal or retriable result, counting
   * the attempt. `nextAttemptAt` (epoch ms) holds a retryable row out of the
   * claim queue until its backoff elapses.
   * Returns the updated row, or undefined if the row was no longer claimed.
   */
  finalize(
    deliveryId: string,
    result: OutboundEmailOutboxOutcome,
    now: number,
    nextAttemptAt?: number,
  ): OutboxRow | undefined;

  /**
   * Epoch ms at which the earliest pending or retryable row in a lane is
   * claimable, if the lane holds one. Lets the lane schedule its own wake-up
   * instead of stalling until a restart or the next unrelated send.
   *
   * There is no lower bound on purpose. The caller asks only after a claim
   * came back empty, and a row can be claimable by now all the same: the
   * clock moved between the two calls, or the claim excluded the row. So a
   * time at or before `now` is a valid answer, and a row with no hold-off
   * time counts as claimable at `now`. With a lower bound of `now` this and
   * the claim (`next_attempt_at <= now`) could both miss the same row, and
   * the lane was then left with a retryable row and no wake-up.
   */
  nextRetryAt(lane: OutboxLane, now: number): number | undefined;

  /**
   * Reset rows left 'claimed' by a previous process back to 'pending'.
   * Called after acquiring the single-process lock on startup.
   */
  resetInFlightClaims(processId?: number): number;

  /**
   * Delete terminal rows older than the retention window.
   * Returns the number of rows removed.
   */
  compact(retentionMs: number, now: number): number;

  /** Acquire a single-process OS file lock. Throws if another process holds it. */
  acquireProcessLock(): void;

  /** Release the single-process OS file lock. */
  releaseProcessLock(): void;
}

function toIsoString(ts: number): string {
  return new Date(ts).toISOString();
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: string | null | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function ensureTableExists(database: Database.Database): void {
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
  // Migrations for outboxes created before the retry budget (round 4).
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
}

function rowFromDb(row: Record<string, unknown>): OutboxRow {
  return {
    deliveryId: row.delivery_id as string,
    lane: row.lane as OutboxLane,
    batchId: (row.batch_id as string | null) ?? undefined,
    position: (row.position as number | null) ?? undefined,
    status: row.status as OutboxRow['status'],
    email: fromJson<OutboxEmailPayload>(row.email_json as string) ?? {
      to: '',
      subject: '',
      body: '',
    },
    sendOptions: fromJson<OutboxSendOptionsPayload>(
      row.send_options_json as string,
    ) ?? {
      sourceGroup: '',
      forceBotReplyTo: true,
    },
    result: fromJson<OutboundEmailOutboxOutcome>(row.result_json as string),
    intended: fromJson<string[]>(row.intended_json as string) ?? [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    terminalAt: (row.terminal_at as string | null) ?? undefined,
    claimPid: (row.claim_pid as number | null) ?? undefined,
    claimExpiresAt: (row.claim_expires_at as string | null) ?? undefined,
    attempts: (row.attempts as number | null) ?? 0,
    nextAttemptAt: (row.next_attempt_at as string | null) ?? undefined,
  };
}

function rowToDb(row: OutboxRow): Record<string, unknown> {
  return {
    delivery_id: row.deliveryId,
    lane: row.lane,
    batch_id: row.batchId ?? null,
    position: row.position ?? null,
    status: row.status,
    retryable:
      row.result?.status === 'failed' ? (row.result.retryable ? 1 : 0) : null,
    email_json: toJson(row.email),
    send_options_json: toJson(row.sendOptions),
    result_json: row.result ? toJson(row.result) : null,
    intended_json: toJson(row.intended),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    terminal_at: row.terminalAt ?? null,
    claim_pid: row.claimPid ?? null,
    claim_expires_at: row.claimExpiresAt ?? null,
    attempts: row.attempts ?? 0,
    next_attempt_at: row.nextAttemptAt ?? null,
  };
}

export class MemoryOutboxStore implements OutboxStore {
  private rows = new Map<string, OutboxRow>();

  get(deliveryId: string): OutboxRow | undefined {
    return this.rows.get(deliveryId);
  }

  set(row: OutboxRow): void {
    const existing = this.rows.get(row.deliveryId);
    if (
      existing &&
      (existing.status === 'sent' || existing.status === 'dead-letter')
    ) {
      // Terminal rows are idempotent; never overwrite a genuine provider result.
      return;
    }
    this.rows.set(row.deliveryId, { ...row });
  }

  insert(row: OutboxRow): void {
    if (this.rows.has(row.deliveryId)) {
      throw new Error(`Outbox row already exists: ${row.deliveryId}`);
    }
    this.rows.set(row.deliveryId, { ...row });
  }

  delete(deliveryId: string): void {
    this.rows.delete(deliveryId);
  }

  listPending(lane?: OutboxLane, _maxAgeMs?: number): OutboxRow[] {
    const rows = [...this.rows.values()]
      .filter(
        (r) =>
          (r.status === 'pending' ||
            (r.status === 'failed' &&
              r.result?.status === 'failed' &&
              r.result.retryable)) &&
          (!lane || r.lane === lane),
      )
      .sort((a, b) => {
        const byTime = a.createdAt.localeCompare(b.createdAt);
        if (byTime !== 0) return byTime;
        const byPosition = (a.position ?? 0) - (b.position ?? 0);
        if (byPosition !== 0) return byPosition;
        return a.deliveryId.localeCompare(b.deliveryId);
      });
    return rows;
  }

  getPendingCount(lane: OutboxLane, _maxAgeMs: number): number {
    return this.listPending(lane).length;
  }

  listAll(): OutboxRow[] {
    return [...this.rows.values()];
  }

  clear(): void {
    this.rows.clear();
  }

  claimNextPending(
    lane: OutboxLane,
    now: number,
    processId: number,
    leaseMs: number,
    _maxAgeMs: number,
    excludeDeliveryId?: string,
  ): OutboxRow | undefined {
    const next = this.listPending(lane).find(
      (r) =>
        r.deliveryId !== excludeDeliveryId &&
        (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now),
    );
    if (!next) return undefined;
    next.status = 'claimed';
    next.claimPid = processId;
    next.claimExpiresAt = toIsoString(Date.now() + leaseMs);
    next.updatedAt = toIsoString(Date.now());
    return next;
  }

  finalize(
    deliveryId: string,
    result: OutboundEmailOutboxOutcome,
    now: number,
    nextAttemptAt?: number,
  ): OutboxRow | undefined {
    const row = this.rows.get(deliveryId);
    if (!row || row.status !== 'claimed') return undefined;
    row.result = result;
    row.attempts = (row.attempts ?? 0) + 1;
    row.nextAttemptAt = nextAttemptAt ? toIsoString(nextAttemptAt) : undefined;
    if (result.status === 'failed' && result.retryable) {
      row.status = 'failed';
      row.claimPid = undefined;
      row.claimExpiresAt = undefined;
      // No terminal_at — retriable rows stay in the queue.
    } else {
      row.status = result.status === 'failed' ? 'dead-letter' : 'sent';
      row.terminalAt = toIsoString(now);
      row.claimPid = undefined;
      row.claimExpiresAt = undefined;
    }
    row.updatedAt = toIsoString(now);
    return row;
  }

  nextRetryAt(lane: OutboxLane, now: number): number | undefined {
    const times = this.listPending(lane).map((r) =>
      r.nextAttemptAt ? Date.parse(r.nextAttemptAt) : now,
    );
    return times.length ? Math.min(...times) : undefined;
  }

  resetInFlightClaims(processId?: number): number {
    let count = 0;
    for (const row of this.rows.values()) {
      if (
        row.status === 'claimed' &&
        (processId === undefined || row.claimPid === processId)
      ) {
        row.status = 'pending';
        row.claimPid = undefined;
        row.claimExpiresAt = undefined;
        row.updatedAt = toIsoString(Date.now());
        count++;
      }
    }
    return count;
  }

  compact(retentionMs: number, now: number): number {
    const cutoff = toIsoString(now - retentionMs);
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (
        (row.status === 'sent' ||
          row.status === 'failed' ||
          row.status === 'dead-letter') &&
        row.terminalAt &&
        row.terminalAt < cutoff
      ) {
        this.rows.delete(id);
        removed++;
      }
    }
    return removed;
  }

  acquireProcessLock(): void {
    // Memory store is in-process; no cross-process lock needed.
  }

  releaseProcessLock(): void {
    // No-op for memory store.
  }
}

export interface SqliteOutboxStoreOptions {
  database?: Database.Database;
  lockDbPath?: string;
}

export class SqliteOutboxStore implements OutboxStore {
  private db: Database.Database;
  private lockDb?: Database.Database;
  private lockDbPath: string;

  constructor(options?: SqliteOutboxStoreOptions) {
    this.db = options?.database ?? getDatabase();
    this.lockDbPath =
      options?.lockDbPath ?? path.join(STORE_DIR, 'outbox.lock.db');
    ensureTableExists(this.db);
  }

  acquireProcessLock(): void {
    fs.mkdirSync(path.dirname(this.lockDbPath), { recursive: true });
    assertSafeDbPath(this.lockDbPath); // store/ is writable for the main group
    this.lockDb = new Database(this.lockDbPath, { timeout: 0 });
    this.lockDb.pragma('locking_mode = EXCLUSIVE');
    try {
      this.lockDb.exec(
        'CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY)',
      );
      this.lockDb.prepare('INSERT OR REPLACE INTO lock (id) VALUES (1)').run();
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'SQLITE_BUSY') {
        throw new Error(
          `Another process holds the outbound email outbox lock: ${this.lockDbPath}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  releaseProcessLock(): void {
    if (this.lockDb) {
      this.lockDb.close();
      this.lockDb = undefined;
    }
  }

  get(deliveryId: string): OutboxRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM outbound_email_outbox WHERE delivery_id = ?')
      .get(deliveryId) as Record<string, unknown> | undefined;
    return row ? rowFromDb(row) : undefined;
  }

  set(row: OutboxRow): void {
    const values = rowToDb(row);
    this.db
      .prepare(
        `
        INSERT INTO outbound_email_outbox (
          delivery_id, lane, batch_id, position, status, retryable,
          email_json, send_options_json, result_json, intended_json,
          created_at, updated_at, terminal_at, claim_pid, claim_expires_at
        ) VALUES (
          @delivery_id, @lane, @batch_id, @position, @status, @retryable,
          @email_json, @send_options_json, @result_json, @intended_json,
          @created_at, @updated_at, @terminal_at, @claim_pid, @claim_expires_at
        )
        ON CONFLICT(delivery_id) DO UPDATE SET
          lane = excluded.lane,
          batch_id = excluded.batch_id,
          position = excluded.position,
          status = excluded.status,
          retryable = excluded.retryable,
          email_json = excluded.email_json,
          send_options_json = excluded.send_options_json,
          result_json = excluded.result_json,
          intended_json = excluded.intended_json,
          created_at = outbound_email_outbox.created_at,
          updated_at = excluded.updated_at,
          terminal_at = excluded.terminal_at,
          claim_pid = excluded.claim_pid,
          claim_expires_at = excluded.claim_expires_at
        WHERE outbound_email_outbox.status NOT IN ('sent', 'dead-letter')
      `,
      )
      .run(values);
  }

  insert(row: OutboxRow): void {
    const values = rowToDb(row);
    this.db
      .prepare(
        `
        INSERT INTO outbound_email_outbox (
          delivery_id, lane, batch_id, position, status, retryable,
          email_json, send_options_json, result_json, intended_json,
          created_at, updated_at, terminal_at, claim_pid, claim_expires_at
        ) VALUES (
          @delivery_id, @lane, @batch_id, @position, @status, @retryable,
          @email_json, @send_options_json, @result_json, @intended_json,
          @created_at, @updated_at, @terminal_at, @claim_pid, @claim_expires_at
        )
      `,
      )
      .run(values);
  }

  delete(deliveryId: string): void {
    this.db
      .prepare('DELETE FROM outbound_email_outbox WHERE delivery_id = ?')
      .run(deliveryId);
  }

  listPending(lane?: OutboxLane, maxAgeMs?: number): OutboxRow[] {
    const ageCutoff = maxAgeMs
      ? toIsoString(Date.now() - maxAgeMs)
      : '1970-01-01T00:00:00.000Z';
    const params: Record<string, unknown> = { age_cutoff: ageCutoff };
    const laneFilter = lane ? 'AND lane = @lane' : '';
    if (lane) params.lane = lane;
    const rows = this.db
      .prepare(
        `
        SELECT * FROM outbound_email_outbox
        WHERE (status = 'pending' OR (status = 'failed' AND retryable = 1))
          AND created_at >= @age_cutoff
          ${laneFilter}
        ORDER BY created_at, position, delivery_id
      `,
      )
      .all(params) as Record<string, unknown>[];
    return rows.map(rowFromDb);
  }

  getPendingCount(lane: OutboxLane, maxAgeMs: number): number {
    const ageCutoff = toIsoString(Date.now() - maxAgeMs);
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) as count FROM outbound_email_outbox
        WHERE (status = 'pending' OR (status = 'failed' AND retryable = 1))
          AND lane = @lane
          AND created_at >= @age_cutoff
      `,
      )
      .get({ lane, age_cutoff: ageCutoff }) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  listAll(): OutboxRow[] {
    const rows = this.db
      .prepare('SELECT * FROM outbound_email_outbox ORDER BY created_at')
      .all() as Record<string, unknown>[];
    return rows.map(rowFromDb);
  }

  clear(): void {
    this.db.prepare('DELETE FROM outbound_email_outbox').run();
  }

  claimNextPending(
    lane: OutboxLane,
    now: number,
    processId: number,
    leaseMs: number,
    _maxAgeMs: number,
    excludeDeliveryId?: string,
  ): OutboxRow | undefined {
    const leaseExpires = toIsoString(Date.now() + leaseMs);
    const updatedAt = toIsoString(Date.now());
    const row = this.db
      .prepare(
        `
        UPDATE outbound_email_outbox
        SET status = 'claimed',
            claim_pid = @process_id,
            claim_expires_at = @lease_expires,
            updated_at = @updated_at
        WHERE delivery_id = (
          SELECT delivery_id FROM outbound_email_outbox
          WHERE lane = @lane
            AND (status = 'pending' OR (status = 'failed' AND retryable = 1))
            AND (@exclude IS NULL OR delivery_id != @exclude)
            AND (next_attempt_at IS NULL OR next_attempt_at <= @now_iso)
          ORDER BY created_at, position, delivery_id
          LIMIT 1
        )
          AND lane = @lane
          AND (status = 'pending' OR (status = 'failed' AND retryable = 1))
        RETURNING *
      `,
      )
      .get({
        lane,
        process_id: processId,
        lease_expires: leaseExpires,
        updated_at: updatedAt,
        exclude: excludeDeliveryId ?? null,
        now_iso: toIsoString(now),
      }) as Record<string, unknown> | undefined;
    return row ? rowFromDb(row) : undefined;
  }

  nextRetryAt(lane: OutboxLane, now: number): number | undefined {
    const row = this.db
      .prepare(
        `
        SELECT MIN(COALESCE(next_attempt_at, @now_iso)) AS next
        FROM outbound_email_outbox
        WHERE lane = @lane
          AND (status = 'pending' OR (status = 'failed' AND retryable = 1))
      `,
      )
      .get({ lane, now_iso: toIsoString(now) }) as
      | { next: string | null }
      | undefined;
    return row?.next ? Date.parse(row.next) : undefined;
  }

  finalize(
    deliveryId: string,
    result: OutboundEmailOutboxOutcome,
    now: number,
    nextAttemptAt?: number,
  ): OutboxRow | undefined {
    const terminalAt =
      result.status === 'sent' ||
      (result.status === 'failed' && !result.retryable)
        ? toIsoString(now)
        : null;
    const retryable =
      result.status === 'failed' ? (result.retryable ? 1 : 0) : null;
    const status: OutboxRow['status'] =
      result.status === 'sent'
        ? 'sent'
        : result.status === 'failed' && result.retryable
          ? 'failed'
          : 'dead-letter';

    const changes = this.db
      .prepare(
        `
        UPDATE outbound_email_outbox
        SET status = @status,
            retryable = @retryable,
            result_json = @result_json,
            terminal_at = @terminal_at,
            claim_pid = NULL,
            claim_expires_at = NULL,
            attempts = attempts + 1,
            next_attempt_at = @next_attempt_at,
            updated_at = @updated_at
        WHERE delivery_id = @delivery_id AND status = 'claimed'
      `,
      )
      .run({
        delivery_id: deliveryId,
        status,
        retryable,
        result_json: toJson(result),
        terminal_at: terminalAt,
        next_attempt_at: nextAttemptAt ? toIsoString(nextAttemptAt) : null,
        updated_at: toIsoString(now),
      });

    if (changes.changes === 0) return undefined;
    return this.get(deliveryId);
  }

  resetInFlightClaims(processId?: number): number {
    const changes = this.db
      .prepare(
        `
        UPDATE outbound_email_outbox
        SET status = 'pending',
            claim_pid = NULL,
            claim_expires_at = NULL,
            updated_at = @updated_at
        WHERE status = 'claimed'
          AND (@process_id IS NULL OR claim_pid = @process_id)
      `,
      )
      .run({
        updated_at: toIsoString(Date.now()),
        process_id: processId ?? null,
      });
    return changes.changes;
  }

  compact(retentionMs: number, now: number): number {
    const cutoff = toIsoString(now - retentionMs);
    const changes = this.db
      .prepare(
        `
        DELETE FROM outbound_email_outbox
        WHERE terminal_at IS NOT NULL AND terminal_at < @cutoff
      `,
      )
      .run({ cutoff });
    return changes.changes;
  }
}

let store: OutboxStore | undefined;

export function getOutboxStore(): OutboxStore {
  if (!store) {
    store = createDefaultOutboxStore();
  }
  return store;
}

export function setOutboxStore(next: OutboxStore): void {
  store = next;
}

export function createDefaultOutboxStore(): OutboxStore {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return new MemoryOutboxStore();
  }
  return new SqliteOutboxStore();
}

/** @internal - for tests only. */
export function _resetOutboxStoreForTests(next?: OutboxStore): OutboxStore {
  getOutboxStore().releaseProcessLock();
  store = next ?? new MemoryOutboxStore();
  store.clear();
  return store;
}
