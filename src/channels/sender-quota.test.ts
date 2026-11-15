import { describe, expect, it, vi } from 'vitest';

import {
  buildSenderCapAlert,
  buildSenderCapNotice,
  chooseNoticeCc,
  createSenderQuota,
  formatCentralTime,
  parseSenderCap,
  retryTransient,
  type TelegramPingResult,
} from './sender-quota.js';

function quotaAt(clock: { now: number }) {
  return createSenderQuota({
    defaultCap: 10,
    personCap: 30,
    windowMs: 1000,
    now: () => clock.now,
  });
}

function sendN(
  quota: ReturnType<typeof createSenderQuota>,
  sender: string,
  person: boolean,
  n: number,
) {
  return Array.from({ length: n }, () => quota.check(sender, person));
}

describe('G19 tiered sender quota', () => {
  it('lets a person on the allowlist past the old cap of 10, up to 30', () => {
    const quota = quotaAt({ now: 0 });
    const results = sendN(quota, 'Person@example.edu', true, 31);

    expect(results.slice(0, 30).every((r) => r.allowed)).toBe(true);
    expect(results.slice(0, 30).some((r) => r.alert || r.notice)).toBe(false);
    expect(results[30]).toMatchObject({
      allowed: false,
      count: 31,
      cap: 30,
      alert: true,
      notice: true,
      noticeAlreadySent: false,
    });
  });

  it('keeps the default cap of 10, and no notice, for an agent principal or unverified sender', () => {
    const quota = quotaAt({ now: 0 });
    const results = sendN(quota, 'agent@example.com', false, 11);

    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(results[10]).toMatchObject({
      allowed: false,
      cap: 10,
      alert: true,
      notice: false,
    });
  });

  it('claims the alert and the notice once per window', () => {
    const quota = quotaAt({ now: 0 });
    const results = sendN(quota, 'person@example.edu', true, 34);

    expect(results.filter((r) => r.alert)).toHaveLength(1);
    expect(results.filter((r) => r.notice)).toHaveLength(1);
    expect(results[32]).toMatchObject({
      alert: false,
      noticeAlreadySent: true,
    });
  });

  it('re-arms only the alert after every send attempt failed', () => {
    const quota = quotaAt({ now: 0 });
    const over = sendN(quota, 'person@example.edu', true, 31)[30];

    quota.releaseAlert('person@example.edu', over.windowStart!);

    expect(quota.check('person@example.edu', true)).toMatchObject({
      alert: true,
      notice: false,
      noticeAlreadySent: true,
    });
    expect(quota.check('person@example.edu', true).alert).toBe(false);
  });

  it('ignores a release from an earlier window', () => {
    const clock = { now: 0 };
    const quota = quotaAt(clock);
    const old = sendN(quota, 'agent@example.com', false, 11)[10];
    clock.now = 1001;
    const fresh = sendN(quota, 'agent@example.com', false, 11)[10];
    expect(fresh.alert).toBe(true);

    quota.releaseAlert('agent@example.com', old.windowStart!);

    expect(quota.check('agent@example.com', false).alert).toBe(false);
  });

  it('does not re-arm the alert when an allowed turn is rolled back', () => {
    const quota = quotaAt({ now: 0 });
    const allowed = sendN(quota, 'agent@example.com', false, 10);
    expect(quota.check('agent@example.com', false).alert).toBe(true);

    quota.rollback('agent@example.com', allowed[9].windowStart!);
    quota.rollback('agent@example.com', allowed[9].windowStart!);

    expect(quota.check('agent@example.com', false).allowed).toBe(true);
    expect(quota.check('agent@example.com', false)).toMatchObject({
      allowed: false,
      alert: false,
    });
  });

  it('starts a new window, with a new alert, after the window ends', () => {
    const clock = { now: 0 };
    const quota = quotaAt(clock);
    sendN(quota, 'agent@example.com', false, 11);

    clock.now = 1001;
    const fresh = quota.check('agent@example.com', false);
    expect(fresh).toMatchObject({ allowed: true, count: 1, windowStart: 1001 });
    const later = sendN(quota, 'agent@example.com', false, 10);
    expect(later[9]).toMatchObject({ allowed: false, alert: true });
  });

  it('falls back to the default for a missing, zero or non-numeric cap', () => {
    expect(parseSenderCap(undefined, 10)).toBe(10);
    expect(parseSenderCap('', 10)).toBe(10);
    expect(parseSenderCap('0', 10)).toBe(10);
    expect(parseSenderCap('-5', 10)).toBe(10);
    expect(parseSenderCap('abc', 10)).toBe(10);
    expect(parseSenderCap('25', 10)).toBe(25);
  });
});

describe('retryTransient', () => {
  it('retries a transient failure after each delay until it succeeds', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const attempt = vi
      .fn<() => Promise<TelegramPingResult>>()
      .mockResolvedValueOnce('failed-transient')
      .mockResolvedValueOnce('sent');

    const result = await retryTransient(
      'failed-transient',
      attempt,
      [5, 30, 120],
      sleep,
    );

    expect(result).toBe('sent');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5, 30]);
  });

  it('gives up after the last delay', async () => {
    const attempt = vi.fn(
      async (): Promise<TelegramPingResult> => 'failed-transient',
    );

    const result = await retryTransient(
      'failed-transient',
      attempt,
      [1, 1],
      async () => {},
    );

    expect(result).toBe('failed-transient');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry a sent, permanent or unconfigured result', async () => {
    for (const first of [
      'sent',
      'failed-permanent',
      'unconfigured',
    ] as TelegramPingResult[]) {
      const attempt = vi.fn(async (): Promise<TelegramPingResult> => 'sent');
      expect(await retryTransient(first, attempt, [1], async () => {})).toBe(
        first,
      );
      expect(attempt).not.toHaveBeenCalled();
    }
  });
});

describe('chooseNoticeCc', () => {
  const allowlist = {
    available: true,
    senders: new Set(['avery@example.edu']),
  };

  it('copies Avery, as a bare address, only when the alert failed and the allowlist lets the CC through', () => {
    expect(
      chooseNoticeCc({
        alertSent: false,
        fallbackCc: 'Avery <Avery@example.edu>',
        fallbackCcAddresses: ['avery@example.edu'],
        allowlist,
      }),
    ).toBe('avery@example.edu');
  });

  it('adds no CC when the alert was sent', () => {
    expect(
      chooseNoticeCc({
        alertSent: true,
        fallbackCc: 'avery@example.edu',
        fallbackCcAddresses: ['avery@example.edu'],
        allowlist,
      }),
    ).toBeUndefined();
  });

  it('adds no CC the send would drop: not allowlisted, list unavailable, or unparsable', () => {
    const base = { alertSent: false, fallbackCc: 'cc@example.edu' };
    expect(
      chooseNoticeCc({
        ...base,
        fallbackCcAddresses: ['cc@example.edu'],
        allowlist,
      }),
    ).toBeUndefined();
    expect(
      chooseNoticeCc({
        ...base,
        fallbackCc: 'avery@example.edu',
        fallbackCcAddresses: ['avery@example.edu'],
        allowlist: { ...allowlist, available: false },
      }),
    ).toBeUndefined();
    expect(
      chooseNoticeCc({ ...base, fallbackCcAddresses: [], allowlist }),
    ).toBeUndefined();
  });
});

describe('G19 sender cap messages', () => {
  it('formats the reset time in US Central', () => {
    // 2026-10-24 14:33 UTC is 9:33 AM CDT.
    expect(formatCentralTime(Date.UTC(2026, 9, 24, 14, 33))).toBe(
      'October 24, 2026 at 9:33 AM CDT',
    );
  });

  it('says Avery was told only when that is true', () => {
    const told = buildSenderCapNotice({
      cap: 30,
      resetAt: 'October 24, 2026 at 9:33 AM CDT',
      operatorTold: true,
    });
    const notTold = buildSenderCapNotice({
      cap: 30,
      resetAt: 'October 24, 2026 at 9:33 AM CDT',
      operatorTold: false,
    });

    expect(told).toContain('Avery Morgan has been told');
    expect(notTold).not.toContain('Avery');
    expect(notTold).toContain('30 messages in the last 24 hours');
    expect(notTold).toContain('resets on October 24, 2026 at 9:33 AM CDT');
  });

  it('names the sender kind and the notice status in the alert', () => {
    const base = {
      from: 'person@example.edu',
      subject: 'Re: Coordinator Weekly Digest',
      messageId: '<m1@example.com>',
      count: 31,
      cap: 30,
      resetAt: 'October 24, 2026 at 9:33 AM CDT',
    };

    const person = buildSenderCapAlert({
      ...base,
      allowlistedPerson: true,
      notice: 'sending',
    });
    const retry = buildSenderCapAlert({
      ...base,
      allowlistedPerson: true,
      notice: 'sent-earlier',
    });
    const agent = buildSenderCapAlert({
      ...base,
      allowlistedPerson: false,
      notice: 'none',
    });

    expect(person).toContain('person on the allowlist');
    expect(person).toContain('Coordinator is sending the sender one notice.');
    expect(person).toContain('Message-ID: <m1@example.com>');
    expect(retry).toContain('went with an earlier message');
    expect(agent).toContain('agent principal or unverified sender');
    expect(agent).toContain('No notice goes to the sender.');
  });
});
