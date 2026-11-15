/**
 * Delivery confirmation for outbound email.
 *
 * Resend reports each recipient's outcome separately on /resend/webhook
 * (`data.to` lists the impacted recipients). Bounces already alert the
 * owner; this closes the other gap, a recipient that never gets ANY outcome
 * event (webhook outage, provider stall). Every accepted To/CC recipient is
 * recorded here, the webhook records per-recipient outcomes, and a host
 * timer reports recipients still unresolved after 12 h during the 08:00
 * local hour. The audit entry and the owner alert are retried
 * independently until both succeed, even if delivery is confirmed later.
 *
 * What it cannot see: mail the recipient's server accepts (Resend
 * "delivered") and then quarantines.
 *
 * Tracking never throws into the send or webhook paths: a tracking failure
 * is logged, and at worst produces one false "unconfirmed" report.
 */
import type { AuditWriteResult } from './audit-log.js';
import { getDatabase } from './db.js';
import { logger } from './logger.js';
import { localTimeHms } from './timezone.js';

export const UNCONFIRMED_AFTER_MS = 12 * 60 * 60 * 1000;
const REPORT_HOUR = 8;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

export interface UnconfirmedSend {
  resendId: string;
  recipients: string[];
  subject: string;
  sentAt: string;
}

interface PendingReport extends UnconfirmedSend {
  needsAudit: boolean;
  needsNotify: boolean;
}

type Db = ReturnType<typeof getDatabase>;
const ready = new WeakSet<Db>();

function trackingDb(): Db {
  const database = getDatabase();
  if (!ready.has(database)) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS email_delivery_recipients (
        resend_id TEXT NOT NULL CHECK (resend_id <> ''),
        recipient TEXT NOT NULL CHECK (recipient <> ''),
        subject TEXT NOT NULL DEFAULT '',
        sent_at TEXT NOT NULL,
        event_type TEXT,
        event_at TEXT,
        audited_at TEXT,
        notified_at TEXT,
        PRIMARY KEY (resend_id, recipient)
      )
    `);
    try {
      migrateLegacyTable(database);
    } catch (err) {
      // New tracking still works; the legacy rows stay put and the next
      // process start retries the migration.
      logger.error(
        { err },
        'Delivery tracking: legacy table migration failed; will retry on restart',
      );
    }
    ready.add(database);
  }
  return database;
}

/**
 * The first schema kept one row per email in
 * email_delivery_tracking, with the To list in to_addr. Move its valid rows
 * into the per-recipient table with their delivery and report state, then
 * rename the old table, in one transaction: the rows are kept, and cannot
 * migrate twice. Its reported_at was set once the owner alert succeeded
 * after the audit write, so it marks both halves done.
 */
function migrateLegacyTable(database: Db): void {
  const legacy = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'email_delivery_tracking'`,
    )
    .get();
  if (!legacy) return;

  const rows = database
    .prepare(
      `SELECT resend_id, to_addr, subject, sent_at, event_type, event_at, reported_at
       FROM email_delivery_tracking`,
    )
    .all() as {
    resend_id: unknown;
    to_addr: string | null;
    subject: string | null;
    sent_at: string;
    event_type: string | null;
    event_at: string | null;
    reported_at: string | null;
  }[];
  const insert = database.prepare(
    `INSERT OR IGNORE INTO email_delivery_recipients
       (resend_id, recipient, subject, sent_at, event_type, event_at, audited_at, notified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  database.transaction(() => {
    let migrated = 0;
    for (const row of rows) {
      if (!isResendId(row.resend_id)) continue;
      for (const recipient of normalizeRecipients(
        (row.to_addr ?? '').split(','),
      )) {
        insert.run(
          row.resend_id,
          recipient,
          row.subject ?? '',
          row.sent_at,
          row.event_type,
          row.event_at,
          row.reported_at,
          row.reported_at,
        );
        migrated++;
      }
    }
    database.exec(
      'ALTER TABLE email_delivery_tracking RENAME TO email_delivery_tracking_migrated',
    );
    logger.info(
      { legacyRows: rows.length, recipientRows: migrated },
      'Delivery tracking: migrated legacy single-recipient table',
    );
  })();
}

function isResendId(id: unknown): id is string {
  return typeof id === 'string' && id.trim() !== '';
}

function normalizeRecipients(list: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const addr of list ?? []) {
    if (typeof addr !== 'string') continue;
    const clean = addr.trim().toLowerCase();
    if (clean) out.add(clean);
  }
  return [...out];
}

export function recordEmailSent(args: {
  resendId: string;
  recipients: string[];
  subject: string;
  sentAt?: string;
}): void {
  if (!isResendId(args.resendId)) {
    logger.warn(
      { subject: args.subject },
      'Delivery tracking: send without a Resend ID not tracked',
    );
    return;
  }
  const recipients = normalizeRecipients(args.recipients);
  const sentAt = args.sentAt ?? new Date().toISOString();
  try {
    const database = trackingDb();
    // An outcome event can beat this write; keep it if so.
    const upsert = database.prepare(
      `INSERT INTO email_delivery_recipients (resend_id, recipient, subject, sent_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(resend_id, recipient) DO UPDATE SET
         subject = excluded.subject,
         sent_at = excluded.sent_at`,
    );
    database.transaction(() => {
      for (const recipient of recipients) {
        upsert.run(args.resendId, recipient, args.subject, sentAt);
      }
    })();
  } catch (err) {
    logger.warn(
      { err, resendId: args.resendId },
      'Delivery tracking: could not record send',
    );
  }
}

export function recordDeliveryEvent(args: {
  resendId: string;
  type: string;
  recipients: string[];
}): void {
  if (!isResendId(args.resendId)) return;
  const recipients = normalizeRecipients(args.recipients);
  const at = new Date().toISOString();
  try {
    const database = trackingDb();
    const upsert = database.prepare(
      `INSERT INTO email_delivery_recipients
         (resend_id, recipient, sent_at, event_type, event_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(resend_id, recipient) DO UPDATE SET
         event_type = excluded.event_type,
         event_at = excluded.event_at`,
    );
    database.transaction(() => {
      for (const recipient of recipients) {
        upsert.run(args.resendId, recipient, at, args.type, at);
      }
    })();
  } catch (err) {
    logger.warn(
      { err, resendId: args.resendId, type: args.type },
      'Delivery tracking: could not record event',
    );
  }
}

function pendingReports(nowMs: number): PendingReport[] {
  const cutoff = new Date(nowMs - UNCONFIRMED_AFTER_MS).toISOString();
  // A report is due for an overdue recipient with no outcome. Once either
  // half (audit entry or owner alert) is done, the other half is finished
  // regardless of any delivery event that arrives later.
  const rows = trackingDb()
    .prepare(
      `SELECT resend_id, recipient, subject, sent_at, audited_at, notified_at
       FROM email_delivery_recipients
       WHERE (audited_at IS NULL OR notified_at IS NULL)
         AND (
           audited_at IS NOT NULL
           OR notified_at IS NOT NULL
           OR (event_type IS NULL AND sent_at <= ?)
         )
       ORDER BY sent_at, resend_id, recipient`,
    )
    .all(cutoff) as {
    resend_id: string;
    recipient: string;
    subject: string;
    sent_at: string;
    audited_at: string | null;
    notified_at: string | null;
  }[];

  const byEmail = new Map<string, PendingReport>();
  for (const row of rows) {
    let report = byEmail.get(row.resend_id);
    if (!report) {
      report = {
        resendId: row.resend_id,
        recipients: [],
        subject: row.subject,
        sentAt: row.sent_at,
        needsAudit: false,
        needsNotify: false,
      };
      byEmail.set(row.resend_id, report);
    }
    report.recipients.push(row.recipient);
    if (row.audited_at === null) report.needsAudit = true;
    if (row.notified_at === null) report.needsNotify = true;
  }
  return [...byEmail.values()];
}

export function findUnconfirmedSends(nowMs: number): UnconfirmedSend[] {
  return pendingReports(nowMs).map(
    ({ resendId, recipients, subject, sentAt }) => ({
      resendId,
      recipients,
      subject,
      sentAt,
    }),
  );
}

function markDone(
  database: Db,
  column: 'audited_at' | 'notified_at',
  report: UnconfirmedSend,
  at: string,
): void {
  const mark = database.prepare(
    `UPDATE email_delivery_recipients SET ${column} = ?
     WHERE resend_id = ? AND recipient = ? AND ${column} IS NULL`,
  );
  database.transaction(() => {
    for (const recipient of report.recipients) {
      mark.run(at, report.resendId, recipient);
    }
  })();
}

interface DeliveryCheckDeps {
  now: Date;
  timezone: string;
  notify: (text: string) => Promise<void>;
  logProblem: (args: {
    type: string;
    to?: string;
    subject?: string;
    resendId?: string;
    reason?: string;
  }) => AuditWriteResult;
}

/**
 * Report overdue unconfirmed recipients, grouped per email. Returns how many
 * emails finished reporting (audit entry and owner alert both done) this tick.
 */
export async function runDeliveryCheck(
  deps: DeliveryCheckDeps,
): Promise<number> {
  const hour = Number(localTimeHms(deps.timezone, deps.now).slice(0, 2));
  if (hour !== REPORT_HOUR) return 0;

  const database = trackingDb();
  database
    .prepare('DELETE FROM email_delivery_recipients WHERE sent_at < ?')
    .run(new Date(deps.now.getTime() - RETENTION_MS).toISOString());

  const at = deps.now.toISOString();
  let completed = 0;
  for (const report of pendingReports(deps.now.getTime())) {
    const to = report.recipients.join(', ');
    if (report.needsAudit) {
      const outcome = deps.logProblem({
        type: 'unconfirmed',
        to,
        subject: report.subject,
        resendId: report.resendId,
        reason: 'no delivery event from Resend within 12 h',
      });
      if (outcome === 'write-failed') {
        logger.warn(
          { resendId: report.resendId },
          'Delivery check: audit write failed; will retry next tick',
        );
      } else {
        markDone(database, 'audited_at', report, at);
        report.needsAudit = false;
      }
    }
    if (report.needsNotify) {
      try {
        await deps.notify(
          `⚠️ Email unconfirmed: no delivery event from Resend within 12 h\n` +
            `To: ${to}\n` +
            `Subject: ${report.subject}\n` +
            `Sent: ${report.sentAt}\n` +
            `Resend ID: ${report.resendId}`,
        );
        markDone(database, 'notified_at', report, at);
        report.needsNotify = false;
      } catch (err) {
        logger.warn(
          { err, resendId: report.resendId },
          'Delivery check: owner alert failed; will retry next tick',
        );
      }
    }
    if (!report.needsAudit && !report.needsNotify) completed++;
  }
  return completed;
}

export function startDeliveryCheck(deps: Omit<DeliveryCheckDeps, 'now'>): void {
  const tick = () => {
    runDeliveryCheck({ ...deps, now: new Date() }).catch((err) =>
      logger.error({ err }, 'Delivery check failed'),
    );
  };
  setTimeout(tick, 30_000);
  setInterval(tick, CHECK_INTERVAL_MS);
}
