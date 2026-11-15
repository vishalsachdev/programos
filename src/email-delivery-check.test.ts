import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, getDatabase } from './db.js';
import {
  findUnconfirmedSends,
  recordDeliveryEvent,
  recordEmailSent,
  runDeliveryCheck,
} from './email-delivery-check.js';

const TZ = 'America/Chicago';
// 2026-09-11 20:01 CDT, the nightly digest's usual send time.
const DIGEST_SENT = '2026-09-12T01:01:00.000Z';
// 2026-09-12 08:30 CDT, 12.5 h after the digest; then the next 15-min ticks.
const NEXT_MORNING = '2026-09-12T13:30:00.000Z';
const LATER_TICK = '2026-09-12T13:45:00.000Z';
const LAST_TICK = '2026-09-12T14:00:00.000Z';
const DIGEST = {
  resendId: 'resend-digest-1',
  recipients: ['avery@example.edu'],
  subject: 'Coordinator Daily Digest — 2026-09-11',
};

function deps(nowIso: string) {
  return {
    now: new Date(nowIso),
    timezone: TZ,
    notify: vi.fn().mockResolvedValue(undefined),
    logProblem: vi.fn().mockReturnValue('written'),
  };
}

// Shape as seen in the VPS webhook log: Resend sends one event per
// recipient, with that recipient in data.to. No raw payload is stored.
function delivered(resendId: string, recipient: string) {
  recordDeliveryEvent({ resendId, type: 'delivered', recipients: [recipient] });
}

beforeEach(() => {
  _initTestDatabase();
});

describe('email delivery check', () => {
  it('reports a send with no delivery event the next morning, exactly once', async () => {
    recordEmailSent({ ...DIGEST, sentAt: DIGEST_SENT });

    const first = deps(NEXT_MORNING);
    expect(await runDeliveryCheck(first)).toBe(1);
    expect(first.notify).toHaveBeenCalledTimes(1);
    expect(first.notify.mock.calls[0][0]).toContain(DIGEST.subject);
    expect(first.notify.mock.calls[0][0]).toContain('avery@example.edu');
    expect(first.logProblem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'unconfirmed',
        resendId: DIGEST.resendId,
        to: 'avery@example.edu',
        subject: DIGEST.subject,
      }),
    );

    const second = deps(LATER_TICK);
    expect(await runDeliveryCheck(second)).toBe(0);
    expect(second.notify).not.toHaveBeenCalled();
    expect(second.logProblem).not.toHaveBeenCalled();
  });

  it.each(['delivered', 'bounced', 'complained', 'failed'])(
    'does not report a recipient Resend resolved as %s',
    async (type) => {
      recordEmailSent({ ...DIGEST, sentAt: DIGEST_SENT });
      recordDeliveryEvent({
        resendId: DIGEST.resendId,
        type,
        recipients: ['avery@example.edu'],
      });

      const d = deps(NEXT_MORNING);
      expect(await runDeliveryCheck(d)).toBe(0);
      expect(d.notify).not.toHaveBeenCalled();
    },
  );

  it('tracks each recipient: delivery to one does not confirm another', async () => {
    recordEmailSent({
      resendId: 'resend-cc-1',
      recipients: ['paige@example.edu', 'avery@example.edu'],
      subject: 'Re: Ingest 9/2/26',
      sentAt: DIGEST_SENT,
    });
    delivered('resend-cc-1', 'paige@example.edu');

    const d = deps(NEXT_MORNING);
    expect(await runDeliveryCheck(d)).toBe(1);
    const text = d.notify.mock.calls[0][0] as string;
    expect(text).toContain('avery@example.edu');
    expect(text).not.toContain('paige@example.edu');
    expect(d.logProblem).toHaveBeenCalledWith(
      expect.objectContaining({
        resendId: 'resend-cc-1',
        to: 'avery@example.edu',
      }),
    );
  });

  it('holds an overdue send until the 08:00 CT window', async () => {
    // 09:00 CDT send; 13 h later it is 22:00 CDT, outside the window.
    recordEmailSent({ ...DIGEST, sentAt: '2026-09-11T14:00:00.000Z' });

    const evening = deps('2026-09-12T03:00:00.000Z');
    expect(await runDeliveryCheck(evening)).toBe(0);
    expect(evening.notify).not.toHaveBeenCalled();

    expect(await runDeliveryCheck(deps(NEXT_MORNING))).toBe(1);
  });

  it('does not report a send younger than 12 hours', async () => {
    // 23:30 CDT send is only 9 h old at 08:30.
    recordEmailSent({ ...DIGEST, sentAt: '2026-09-12T04:30:00.000Z' });

    expect(findUnconfirmedSends(Date.parse(NEXT_MORNING))).toEqual([]);
    expect(await runDeliveryCheck(deps(NEXT_MORNING))).toBe(0);
  });

  it('never tracks a send without a Resend ID', async () => {
    recordEmailSent({ ...DIGEST, resendId: '', sentAt: DIGEST_SENT });
    recordEmailSent({
      ...DIGEST,
      resendId: null as unknown as string,
      sentAt: DIGEST_SENT,
    });

    expect(findUnconfirmedSends(Date.parse(NEXT_MORNING))).toEqual([]);
    expect(await runDeliveryCheck(deps(NEXT_MORNING))).toBe(0);
  });

  it('retries the owner alert without rewriting the audit entry', async () => {
    recordEmailSent({ ...DIGEST, sentAt: DIGEST_SENT });

    const failing = deps(NEXT_MORNING);
    failing.notify.mockRejectedValue(new Error('telegram down'));
    expect(await runDeliveryCheck(failing)).toBe(0);
    expect(failing.logProblem).toHaveBeenCalledTimes(1);

    const retry = deps(LATER_TICK);
    expect(await runDeliveryCheck(retry)).toBe(1);
    expect(retry.notify).toHaveBeenCalledTimes(1);
    expect(retry.logProblem).not.toHaveBeenCalled();
  });

  it('retries a failed audit write even after the owner alert succeeded', async () => {
    recordEmailSent({ ...DIGEST, sentAt: DIGEST_SENT });

    const first = deps(NEXT_MORNING);
    first.logProblem.mockReturnValue('write-failed');
    expect(await runDeliveryCheck(first)).toBe(0);
    expect(first.notify).toHaveBeenCalledTimes(1);

    const retry = deps(LATER_TICK);
    expect(await runDeliveryCheck(retry)).toBe(1);
    expect(retry.logProblem).toHaveBeenCalledTimes(1);
    expect(retry.notify).not.toHaveBeenCalled();

    const done = deps(LAST_TICK);
    expect(await runDeliveryCheck(done)).toBe(0);
    expect(done.logProblem).not.toHaveBeenCalled();
  });

  it('finishes a started report even if delivery is confirmed later', async () => {
    recordEmailSent({ ...DIGEST, sentAt: DIGEST_SENT });

    const first = deps(NEXT_MORNING);
    first.logProblem.mockReturnValue('write-failed');
    expect(await runDeliveryCheck(first)).toBe(0);
    expect(first.notify).toHaveBeenCalledTimes(1);

    // The owner was already alerted; the audit entry must still follow.
    delivered(DIGEST.resendId, 'avery@example.edu');

    const retry = deps(LATER_TICK);
    expect(await runDeliveryCheck(retry)).toBe(1);
    expect(retry.logProblem).toHaveBeenCalledTimes(1);
    expect(retry.notify).not.toHaveBeenCalled();
  });

  it('finishes the owner alert even if delivery is confirmed after the audit entry', async () => {
    recordEmailSent({ ...DIGEST, sentAt: DIGEST_SENT });

    const first = deps(NEXT_MORNING);
    first.notify.mockRejectedValue(new Error('telegram down'));
    expect(await runDeliveryCheck(first)).toBe(0);
    expect(first.logProblem).toHaveBeenCalledTimes(1);

    // The audit entry already says "unconfirmed"; the alert must match it.
    delivered(DIGEST.resendId, 'avery@example.edu');

    const retry = deps(LATER_TICK);
    expect(await runDeliveryCheck(retry)).toBe(1);
    expect(retry.notify).toHaveBeenCalledTimes(1);
    expect(retry.logProblem).not.toHaveBeenCalled();
  });

  it('migrates legacy single-recipient rows, keeping delivery and report state', async () => {
    // The first schema: one row per email, recipients in to_addr.
    const db = getDatabase();
    db.exec(`
      CREATE TABLE email_delivery_tracking (
        resend_id TEXT PRIMARY KEY,
        to_addr TEXT NOT NULL,
        subject TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        event_type TEXT,
        event_at TEXT,
        reported_at TEXT
      )
    `);
    const legacy = db.prepare(
      'INSERT INTO email_delivery_tracking VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    legacy.run(
      'legacy-overdue',
      'paige@example.edu, avery@example.edu',
      'Legacy overdue',
      DIGEST_SENT,
      null,
      null,
      null,
    );
    legacy.run(
      'legacy-reported',
      'avery@example.edu',
      'Legacy reported',
      DIGEST_SENT,
      null,
      null,
      '2026-09-11T13:40:00.000Z',
    );
    legacy.run(
      'legacy-delivered',
      'avery@example.edu',
      'Legacy delivered',
      DIGEST_SENT,
      'delivered',
      DIGEST_SENT,
      null,
    );
    legacy.run(
      null,
      'avery@example.edu',
      'Legacy null id',
      DIGEST_SENT,
      null,
      null,
      null,
    );

    const d = deps(NEXT_MORNING);
    expect(await runDeliveryCheck(d)).toBe(1);
    expect(d.notify).toHaveBeenCalledTimes(1);
    const text = d.notify.mock.calls[0][0] as string;
    expect(text).toContain('Legacy overdue');
    expect(text).toContain('paige@example.edu');
    expect(text).toContain('avery@example.edu');
    expect(d.logProblem).toHaveBeenCalledTimes(1);

    // Renamed, not dropped, so the rows survive and cannot migrate twice.
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name LIKE 'email_delivery_tracking%'`,
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(['email_delivery_tracking_migrated']);
  });
});
