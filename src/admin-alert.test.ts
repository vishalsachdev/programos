import fs from 'fs';
import os from 'os';
import path from 'path';

import { simpleParser } from 'mailparser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Operator alerts follow ADMIN_ALERT_ROUTE (admin-alert.ts). The email route
// runs here through the REAL outbound path (outbox, delivery gate, audit
// log); only the mail provider's HTTP call is stubbed.

const mocks = vi.hoisted(() => ({
  env: { ASSISTANT_NAME: 'Coordinator' } as Record<string, string>,
  fetch: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) =>
    Object.fromEntries(
      keys.filter((k) => mocks.env[k]).map((k) => [k, mocks.env[k]]),
    ),
}));

vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: vi.fn(),
    readFile: vi.fn(() => null),
    readFileAsync: vi.fn(async () => null),
  }),
}));

import {
  ADMIN_ALERT_MAIL_HEADERS,
  ADMIN_ALERT_SOURCE_GROUP,
  _setAdminAlertRetryWaitForTests,
  adminAlertSubjectPrefix,
  adminShortfallAlerter,
  checkAdminAlertConfig,
  createThrowingAdminAlerter,
  dispatchAdminAlert,
  isAboutAdminAlertMail,
  parseAdminAlertRoute,
  sendAdminAlert,
  sendAdminAlertEmail,
  sendTestAdminAlerts,
  type AdminAlertResult,
} from './admin-alert.js';
import { flushAuditLog } from './audit-log.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getPendingDeliveryShortfalls,
  peekDeliveryNotes,
} from './db.js';
import {
  reportDeliveryShortfall,
  setDeliveryShortfallAlerter,
} from './delivery-gate.js';
import { checkParsedForLoop } from './email-loop-detection.js';
import { logger } from './logger.js';
import {
  _resetOutboundEmailQueueForTests,
  _setProviderTimeoutMsForTests,
  _setStaggerMsForTests,
  sendOutboundEmailResult,
  startOutboundEmailQueue,
} from './outbound-email.js';
import { MemoryOutboxStore } from './outbound-email-outbox.js';

const OPERATOR = 'avery@example.edu';
const BASE_ENV = {
  RESEND_API_KEY: 're_test',
  SEND_FROM_NAME: 'Coordinator',
  SEND_FROM_EMAIL: 'program@example.org',
  OPERATOR_CC_EMAIL: OPERATOR,
};

interface ProviderRequest {
  url: string;
  idempotencyKey: string;
  payload: {
    from: string;
    to: string[];
    cc?: string[];
    subject: string;
    text: string;
    reply_to: string;
    headers: Record<string, string>;
  };
}

function providerRequests(): ProviderRequest[] {
  return mocks.fetch.mock.calls.map((call) => {
    const init = call[1] as RequestInit;
    return {
      url: String(call[0]),
      idempotencyKey: (init.headers as Record<string, string>)[
        'Idempotency-Key'
      ],
      payload: JSON.parse(init.body as string),
    };
  });
}

function providerAccepts(): void {
  let n = 0;
  mocks.fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ id: `re_alert_${(n += 1)}` }), {
        status: 200,
      }),
  );
}

function providerRejects(status: number): void {
  mocks.fetch.mockImplementation(
    async () => new Response('{"name":"validation_error"}', { status }),
  );
}

function telegramReturning(result: AdminAlertResult) {
  return vi.fn(async () => result);
}

function setRoute(route: string | undefined, env = BASE_ENV): void {
  mocks.env = { ...env, ...(route ? { ADMIN_ALERT_ROUTE: route } : {}) };
}

describe('admin alert route', () => {
  let repo: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(200);
    _setAdminAlertRetryWaitForTests(async () => {});
    setDeliveryShortfallAlerter(null);
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-alert-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    // The audit log is written in the host-owned repository (host-repo.ts).
    vi.stubEnv('PROGRAM_HOST_REPO', repo);
    vi.stubEnv('ADMIN_ALERT_ROUTE', '');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_ADMIN_CHAT_ID', '');
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    providerAccepts();
    setRoute(undefined);
  });

  afterEach(() => {
    setDeliveryShortfallAlerter(null);
    _setAdminAlertRetryWaitForTests(undefined);
    flushAuditLog();
    _closeDatabase();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function auditLog(): string {
    const dir = path.join(repo, 'discussions', 'audit-log');
    if (!fs.existsSync(dir)) return '';
    return fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
  }

  describe('route selection', () => {
    it('parses the setting; unset means telegram', () => {
      expect(parseAdminAlertRoute(undefined)).toEqual({ routes: ['telegram'] });
      expect(parseAdminAlertRoute('  ')).toEqual({ routes: ['telegram'] });
      expect(parseAdminAlertRoute('telegram')).toEqual({
        routes: ['telegram'],
      });
      expect(parseAdminAlertRoute('Email')).toEqual({ routes: ['email'] });
      expect(parseAdminAlertRoute('telegram,email')).toEqual({
        routes: ['telegram', 'email'],
      });
      expect(parseAdminAlertRoute('email, telegram').routes.sort()).toEqual([
        'email',
        'telegram',
      ]);
      expect(parseAdminAlertRoute('both')).toEqual({
        routes: ['telegram', 'email'],
      });
    });

    it('falls back to telegram on a value it does not know, and says so', () => {
      expect(parseAdminAlertRoute('teams')).toEqual({
        routes: ['telegram'],
        invalid: 'teams',
      });
      expect(parseAdminAlertRoute('email,teams')).toEqual({
        routes: ['telegram'],
        invalid: 'email,teams',
      });
    });

    it('with no setting, sends on Telegram only and returns its result unchanged', async () => {
      for (const state of [
        'sent',
        'unconfigured',
        'failed-permanent',
        'failed-transient',
      ] as const) {
        const telegram = telegramReturning(state);
        expect(await sendAdminAlert('Disk is full', { telegram })).toBe(state);
        expect(telegram).toHaveBeenCalledOnce();
      }
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(auditLog()).toBe('');
    });

    it('route email sends one mail to the operator and does not call Telegram', async () => {
      setRoute('email');
      const telegram = telegramReturning('sent');

      expect(
        await sendAdminAlert('Disk is full\nCheck /var', { telegram }),
      ).toBe('sent');

      expect(telegram).not.toHaveBeenCalled();
      const [request] = providerRequests();
      expect(providerRequests()).toHaveLength(1);
      expect(request.url).toBe('https://api.resend.com/emails');
      expect(request.payload.to).toEqual([OPERATOR]);
      expect(request.payload.cc).toBeUndefined();
      expect(request.payload.subject).toBe('[Coordinator alert] Disk is full');
      expect(request.payload.text).toBe('Disk is full\nCheck /var');
      expect(request.payload.from).toContain('program@example.org');
    });

    it('reads the route from the process environment too', async () => {
      vi.stubEnv('ADMIN_ALERT_ROUTE', 'email');
      const telegram = telegramReturning('sent');
      expect(await sendAdminAlert('From the environment', { telegram })).toBe(
        'sent',
      );
      expect(telegram).not.toHaveBeenCalled();
      expect(providerRequests()).toHaveLength(1);
    });
  });

  describe('both routes at once', () => {
    it('sends on Telegram and by mail', async () => {
      setRoute('telegram,email');
      const telegram = telegramReturning('sent');
      expect(await sendAdminAlert('Both routes', { telegram })).toBe('sent');
      expect(telegram).toHaveBeenCalledOnce();
      expect(providerRequests()).toHaveLength(1);
    });

    it('counts the alert as delivered when one route delivered it', async () => {
      setRoute('telegram,email');
      expect(
        await sendAdminAlert('Telegram is down', {
          telegram: telegramReturning('failed-transient'),
        }),
      ).toBe('sent');

      providerRejects(422);
      expect(
        await sendAdminAlert('Mail is down', {
          telegram: telegramReturning('sent'),
        }),
      ).toBe('sent');
    });

    it('reports the failure when no route delivered it', async () => {
      setRoute('telegram,email');
      providerRejects(422);
      expect(
        await sendAdminAlert('Nothing works', {
          telegram: telegramReturning('failed-transient'),
        }),
      ).toBe('failed-transient');
      expect(
        await sendAdminAlert('Nothing works', {
          telegram: telegramReturning('unconfigured'),
        }),
      ).toBe('failed-permanent');
    });

    it('treats a Telegram transport that throws as a failed route', async () => {
      setRoute('telegram,email');
      expect(
        await sendAdminAlert('Transport threw', {
          telegram: async () => {
            throw new Error('socket closed');
          },
        }),
      ).toBe('sent');
      expect(providerRequests()).toHaveLength(1);
    });
  });

  describe('throw-on-failure contract (dead-letter and shortfall alerts)', () => {
    it('default route: rejects with the alert channel error, as before', async () => {
      const alerter = createThrowingAdminAlerter(async () => {
        throw new Error('No channel owns the alert JID tg-avery@program');
      });
      await expect(alerter('Dead letter')).rejects.toThrow(
        'No channel owns the alert JID tg-avery@program',
      );
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('default route: resolves when the alert channel accepted it', async () => {
      const channel = vi.fn(async () => {});
      await expect(
        createThrowingAdminAlerter(channel)('Dead letter'),
      ).resolves.toBeUndefined();
      expect(channel).toHaveBeenCalledWith('Dead letter');
    });

    it('route email: rejects when the mail was not sent', async () => {
      setRoute('email');
      providerRejects(422);
      const channel = vi.fn(async () => {});
      await expect(
        createThrowingAdminAlerter(channel)('Dead letter'),
      ).rejects.toThrow('Admin alert not delivered: failed-permanent');
      expect(channel).not.toHaveBeenCalled();
    });

    it('route email: rejects when the operator address is missing', async () => {
      setRoute('email', { ...BASE_ENV, OPERATOR_CC_EMAIL: '' });
      await expect(
        createThrowingAdminAlerter(async () => {})('Dead letter'),
      ).rejects.toThrow('Admin alert not delivered: unconfigured');
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('route email: resolves once the mail is accepted, with no Telegram send', async () => {
      setRoute('email');
      const channel = vi.fn(async () => {});
      await expect(
        createThrowingAdminAlerter(channel)('Dead letter'),
      ).resolves.toBeUndefined();
      expect(channel).not.toHaveBeenCalled();
      expect(providerRequests()).toHaveLength(1);
    });

    it('both routes: rejects only when neither delivered', async () => {
      setRoute('telegram,email');
      const failing = async () => {
        throw new Error('Alert delivery failed: telegram 502');
      };
      await expect(
        createThrowingAdminAlerter(failing)('Dead letter'),
      ).resolves.toBeUndefined();

      providerRejects(422);
      await expect(
        createThrowingAdminAlerter(failing)('Dead letter'),
      ).rejects.toThrow('Alert delivery failed: telegram 502');
    });

    it('a retryable mail failure is retried on the same delivery, not sent twice', async () => {
      setRoute('email');
      let call = 0;
      mocks.fetch.mockImplementation(async () => {
        call += 1;
        return call === 1
          ? new Response('upstream', { status: 503 })
          : new Response(JSON.stringify({ id: 're_second_try' }), {
              status: 200,
            });
      });

      expect(await sendAdminAlertEmail('Flaky provider')).toBe('sent');

      const requests = providerRequests();
      expect(requests).toHaveLength(2);
      expect(requests[0].idempotencyKey).toBe(requests[1].idempotencyKey);
      expect(requests[0].idempotencyKey).toMatch(/^admin-alert-/);
    });

    it('gives up with a permanent failure when the retry budget is spent', async () => {
      setRoute('email');
      mocks.fetch.mockImplementation(
        async () => new Response('upstream', { status: 503 }),
      );
      expect(await sendAdminAlertEmail('Provider is down')).toBe(
        'failed-permanent',
      );
      expect(
        new Set(providerRequests().map((r) => r.idempotencyKey)).size,
      ).toBe(1);
    });
  });

  describe('outbound mail path', () => {
    it('queues alert mail on its own outbox lane, as a durable row', async () => {
      setRoute('email');
      const store = new MemoryOutboxStore();
      _resetOutboundEmailQueueForTests(store);
      _setStaggerMsForTests(0);

      expect(await sendAdminAlertEmail('Durable alert')).toBe('sent');

      const rows = store.listAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        lane: 'alert',
        status: 'sent',
        intended: [OPERATOR],
        email: { to: OPERATOR },
        sendOptions: {
          sourceGroup: ADMIN_ALERT_SOURCE_GROUP,
          allowlistState: { available: true, senders: [OPERATOR] },
        },
      });
    });

    it('an alert row left pending by a stopped process is sent at the next start', async () => {
      setRoute('email');
      const store = new MemoryOutboxStore();
      _resetOutboundEmailQueueForTests(store);
      _setStaggerMsForTests(0);
      const at = new Date().toISOString();
      store.insert({
        deliveryId: 'admin-alert-left-pending',
        lane: 'alert',
        status: 'pending',
        email: {
          to: OPERATOR,
          subject: '[Coordinator alert] Left pending',
          body: 'Left pending',
        },
        sendOptions: {
          sourceGroup: ADMIN_ALERT_SOURCE_GROUP,
          forceBotReplyTo: true,
          lane: 'alert',
          allowlistState: {
            available: true,
            senders: [OPERATOR],
            source: 'admin-alert: operator address only',
          },
          trustedBodyAddresses: [],
          extraHeaders: { ...ADMIN_ALERT_MAIL_HEADERS },
        },
        intended: [OPERATOR],
        createdAt: at,
        updatedAt: at,
      });

      startOutboundEmailQueue();

      await vi.waitFor(() => expect(providerRequests()).toHaveLength(1));
      expect(providerRequests()[0].idempotencyKey).toBe(
        'admin-alert-left-pending',
      );
      expect(providerRequests()[0].payload.to).toEqual([OPERATOR]);
    });

    it('the delivery gate still applies: an empty alert is refused, not sent', async () => {
      setRoute('email');
      expect(await sendAdminAlertEmail('<internal>notes</internal>')).toBe(
        'failed-permanent',
      );
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('the outbound path refuses a recipient other than the operator', async () => {
      // The one-address allowlist travels with the row. A row that names
      // anyone else is refused at the send boundary.
      setRoute('email');
      const result = await sendOutboundEmailResult(
        {
          to: 'someone-else@example.edu',
          subject: '[Coordinator alert] Wrong recipient',
          body: 'Wrong recipient',
        },
        {
          sourceGroup: ADMIN_ALERT_SOURCE_GROUP,
          forceBotReplyTo: true,
          lane: 'alert',
          deliveryId: 'admin-alert-wrong-recipient',
          allowlistState: {
            available: true,
            senders: new Set([OPERATOR]),
            source: 'admin-alert: operator address only',
          },
        },
      );
      expect(result).toMatchObject({
        status: 'failed',
        reason: 'to-recipient-not-allowlisted: someone-else@example.edu',
      });
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  });

  describe('audit entry', () => {
    it('writes one outbound-email audit entry for each alert mail sent', async () => {
      setRoute('email');
      await sendAdminAlert('First alert', {
        telegram: telegramReturning('sent'),
      });
      await sendAdminAlert('Second alert', {
        telegram: telegramReturning('sent'),
      });
      flushAuditLog();

      const log = auditLog();
      expect(log.match(/\*\*\[OUTBOUND EMAIL\]\*\*/g)).toHaveLength(2);
      expect(log).toContain(
        `**[OUTBOUND EMAIL]** To: ${OPERATOR} | Subject: [Coordinator alert] First alert`,
      );
      expect(log).toContain(`**Source:** ${ADMIN_ALERT_SOURCE_GROUP}`);
      expect(log).toContain('Second alert');
      expect(log.match(/\*\*Delivery-ID:\*\* admin-alert-/g)).toHaveLength(2);
    });

    it('writes no entry for a mail the provider refused', async () => {
      setRoute('email');
      providerRejects(422);
      await sendAdminAlert('Refused', { telegram: telegramReturning('sent') });
      flushAuditLog();
      expect(auditLog()).not.toContain('[OUTBOUND EMAIL]');
    });

    it('leaves no delivery note for an agent: no agent asked for this mail', async () => {
      setRoute('email');
      providerRejects(422);
      await sendAdminAlert('Refused', { telegram: telegramReturning('sent') });
      expect(peekDeliveryNotes([ADMIN_ALERT_SOURCE_GROUP])).toEqual([]);
    });
  });

  describe('loop guard', () => {
    it("alert mail carries headers that the bot's own intake loop check drops", async () => {
      setRoute('email');
      await sendAdminAlertEmail('Loop check');
      const { payload } = providerRequests()[0];
      expect(payload.headers).toMatchObject(ADMIN_ALERT_MAIL_HEADERS);

      // The mail as the bot's inbox would receive it, through the same
      // check the webhook runs before any agent work (isAutoReplyEml).
      const raw = [
        `From: ${payload.from}`,
        `To: program@example.org`,
        `Subject: ${payload.subject}`,
        ...Object.entries(payload.headers).map(([k, v]) => `${k}: ${v}`),
        '',
        payload.text,
      ].join('\r\n');
      const verdict = checkParsedForLoop(await simpleParser(raw));
      expect(verdict.isAutoReply).toBe(true);
    });

    it('each loop header is enough on its own', async () => {
      for (const header of ['Auto-Submitted', 'Precedence'] as const) {
        const raw = [
          'From: Coordinator <program@example.org>',
          'To: program@example.org',
          'Subject: [Coordinator alert] x',
          `${header}: ${ADMIN_ALERT_MAIL_HEADERS[header]}`,
          '',
          'x',
        ].join('\r\n');
        expect(checkParsedForLoop(await simpleParser(raw)).isAutoReply).toBe(
          true,
        );
      }
    });

    it("refuses to mail the bot's own address", async () => {
      setRoute('email', {
        ...BASE_ENV,
        OPERATOR_CC_EMAIL: 'Program@Example.org',
      });
      expect(await sendAdminAlertEmail('Would loop')).toBe('unconfigured');
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('refuses to mail a peer-agent inbox', async () => {
      setRoute('email', {
        ...BASE_ENV,
        OPERATOR_CC_EMAIL: 'averybot@gmail.com',
      });
      expect(await sendAdminAlertEmail('Agent to agent')).toBe('unconfigured');
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('refuses an operator setting that holds more than one address', async () => {
      setRoute('email', {
        ...BASE_ENV,
        OPERATOR_CC_EMAIL: 'avery@example.edu, other@example.edu',
      });
      expect(await sendAdminAlertEmail('Two addresses')).toBe('unconfigured');
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('goes to the operator only, whatever addresses the alert text names', async () => {
      setRoute('email');
      const text =
        '⚠️ Email bounced\nTo: stranger@elsewhere.example\nSubject: Weekly digest\nReason: mailbox full; cc someone@else.example';
      expect(await sendAdminAlertEmail(text)).toBe('sent');
      const requests = providerRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].payload.to).toEqual([OPERATOR]);
      expect(requests[0].payload.cc).toBeUndefined();
      expect(requests[0].payload.text).toContain('stranger@elsewhere.example');
    });

    it('takes a display-name form of the operator address', async () => {
      setRoute('email', {
        ...BASE_ENV,
        OPERATOR_CC_EMAIL: 'Avery Morgan <Avery@Example.edu>',
      });
      expect(await sendAdminAlertEmail('Display name')).toBe('sent');
      expect(providerRequests()[0].payload.to).toEqual([OPERATOR]);
    });
  });

  describe('no recursion', () => {
    function wireShortfallAlerter(
      channel = vi.fn(async (_text: string) => {}),
    ) {
      const alerter = vi.fn(createThrowingAdminAlerter(channel));
      setDeliveryShortfallAlerter(adminShortfallAlerter(alerter));
      return { alerter, channel };
    }

    it('a failed alert mail does not raise another alert mail', async () => {
      setRoute('email');
      providerRejects(422);
      const { alerter } = wireShortfallAlerter();

      expect(await sendAdminAlertEmail('Original alert')).toBe(
        'failed-permanent',
      );
      await vi.waitFor(() => expect(alerter).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 50));

      // One provider attempt for the original alert, none for a follow-up.
      expect(providerRequests()).toHaveLength(1);
      expect(alerter).toHaveBeenCalledTimes(1);
      expect(alerter.mock.calls[0][1]).toEqual({ aboutAlertMail: true });
      // Resolved (logged and dropped), so nothing is queued for replay.
      await expect(alerter.mock.results[0].value).resolves.toBeUndefined();
      expect(getPendingDeliveryShortfalls()).toEqual([]);
    });

    it('with both routes, the failed alert mail is reported on Telegram only', async () => {
      setRoute('telegram,email');
      providerRejects(422);
      const { channel } = wireShortfallAlerter();

      await sendAdminAlertEmail('Original alert');
      await vi.waitFor(() => expect(channel).toHaveBeenCalledOnce());
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(String(channel.mock.calls[0][0])).toContain('delivery shortfall');
      expect(providerRequests()).toHaveLength(1);
    });

    it('a shortfall of ordinary mail is still alerted by mail', async () => {
      setRoute('email');
      wireShortfallAlerter();
      reportDeliveryShortfall({
        channel: 'email',
        context: 'webhook-email: Re: Budget',
        intended: ['person@example.edu'],
        sent: [],
        missed: ['person@example.edu'],
        reason: 'resend-api-error: HTTP 422',
        sourceGroup: 'webhook-email',
      });
      await vi.waitFor(() => expect(providerRequests()).toHaveLength(1));
      expect(providerRequests()[0].payload.text).toContain(
        'missed recipient(s): person@example.edu',
      );
    });

    it('a bounce or unconfirmed report about an alert mail is not mailed', async () => {
      setRoute('email');
      const bounce = `⚠️ Email bounced\nTo: ${OPERATOR}\nSubject: ${adminAlertSubjectPrefix()} Disk is full\nReason: mailbox full`;
      const unconfirmed = `⚠️ Email unconfirmed: no delivery event from Resend within 12 h\nTo: ${OPERATOR}\nSubject: ${adminAlertSubjectPrefix()} Disk is full\nSent: 2026-11-19T00:00:00Z\nResend ID: re_1`;
      const telegram = telegramReturning('sent');

      expect(await dispatchAdminAlert(bounce, { telegram })).toBe('suppressed');
      expect(await dispatchAdminAlert(unconfirmed, { telegram })).toBe(
        'suppressed',
      );
      // Callers on the four-state contract see "not delivered, do not retry".
      expect(await sendAdminAlert(bounce, { telegram })).toBe(
        'failed-permanent',
      );
      // The throwing alerter resolves: a replay could only be suppressed again.
      await expect(
        createThrowingAdminAlerter(async () => {})(unconfirmed),
      ).resolves.toBeUndefined();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(telegram).not.toHaveBeenCalled();

      setRoute('telegram,email');
      expect(await dispatchAdminAlert(bounce, { telegram })).toBe('sent');
      expect(telegram).toHaveBeenCalledOnce();
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('a report about other mail is mailed, also when a subject quotes the marker', async () => {
      setRoute('email');
      expect(
        isAboutAdminAlertMail(
          `⚠️ Email bounced\nTo: person@example.edu\nSubject: Re: ${adminAlertSubjectPrefix()} Disk is full`,
          OPERATOR,
        ),
      ).toBe(false);
      expect(
        isAboutAdminAlertMail(
          `⚠️ Email bounced\nTo: person@example.edu\nSubject: ${adminAlertSubjectPrefix()} forged`,
          OPERATOR,
        ),
      ).toBe(false);
      expect(
        isAboutAdminAlertMail(
          `Coordinator sender cap reached (G19)\nFrom: person@example.edu\nSubject: please see ${adminAlertSubjectPrefix()}`,
          OPERATOR,
        ),
      ).toBe(false);

      const text = `⚠️ Email bounced\nTo: person@example.edu\nSubject: Weekly digest\nReason: mailbox full`;
      expect(
        await dispatchAdminAlert(text, { telegram: telegramReturning('sent') }),
      ).toBe('sent');
      expect(providerRequests()).toHaveLength(1);
    });
  });

  describe('startup check', () => {
    it('is silent when every enabled route has its settings', () => {
      const error = vi.spyOn(logger, 'error');
      setRoute('email');
      expect(checkAdminAlertConfig()).toEqual([]);

      setRoute('telegram,email', {
        ...BASE_ENV,
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ADMIN_CHAT_ID: '1',
      } as typeof BASE_ENV);
      expect(checkAdminAlertConfig()).toEqual([]);
      expect(error).not.toHaveBeenCalled();
    });

    it('names OPERATOR_CC_EMAIL when the route includes email and it is unset', () => {
      const error = vi.spyOn(logger, 'error');
      setRoute('email', { ...BASE_ENV, OPERATOR_CC_EMAIL: '' });
      const problems = checkAdminAlertConfig();
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('OPERATOR_CC_EMAIL is not set');
      expect(error).toHaveBeenCalledOnce();
      expect(String(error.mock.calls[0][1])).toContain('OPERATOR_CC_EMAIL');
    });

    it('names TELEGRAM_BOT_TOKEN when the route includes telegram and it is unset', () => {
      const error = vi.spyOn(logger, 'error');
      setRoute(undefined);
      const problems = checkAdminAlertConfig();
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('TELEGRAM_BOT_TOKEN is not set');
      expect(error).toHaveBeenCalledOnce();
    });

    it('names TELEGRAM_ADMIN_CHAT_ID when only the chat id is missing', () => {
      setRoute('telegram', {
        ...BASE_ENV,
        TELEGRAM_BOT_TOKEN: 'token',
      } as typeof BASE_ENV);
      expect(checkAdminAlertConfig()).toEqual([
        expect.stringContaining('TELEGRAM_ADMIN_CHAT_ID is not set'),
      ]);
    });

    it('reports each missing setting when both routes are on', () => {
      setRoute('telegram,email', { ...BASE_ENV, OPERATOR_CC_EMAIL: '' });
      const problems = checkAdminAlertConfig();
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toContain('OPERATOR_CC_EMAIL');
      expect(problems.join('\n')).toContain('TELEGRAM_BOT_TOKEN');
    });

    it('names a route value it does not know', () => {
      setRoute('teams', {
        ...BASE_ENV,
        TELEGRAM_BOT_TOKEN: 'token',
        TELEGRAM_ADMIN_CHAT_ID: '1',
      } as typeof BASE_ENV);
      expect(checkAdminAlertConfig()).toEqual([
        expect.stringContaining('ADMIN_ALERT_ROUTE="teams" is not valid'),
      ]);
    });
  });

  describe('first-start test alert', () => {
    it('sends one test alert on each enabled route and reports each', async () => {
      setRoute('telegram,email');
      const telegram = vi.fn(async (_text: string) => 'sent' as const);
      const report = await sendTestAdminAlerts({
        telegram,
        now: new Date('2026-11-19T12:00:00Z'),
      });
      expect(report).toEqual({ telegram: 'sent', email: 'sent' });
      expect(telegram).toHaveBeenCalledOnce();
      expect(telegram.mock.calls[0][0]).toContain(
        'Test alert from Coordinator',
      );
      expect(providerRequests()).toHaveLength(1);
      expect(providerRequests()[0].payload.to).toEqual([OPERATOR]);
    });

    it('a working route does not hide a broken one', async () => {
      setRoute('telegram,email');
      providerRejects(422);
      const report = await sendTestAdminAlerts({
        telegram: async () => 'sent',
      });
      expect(report).toEqual({ telegram: 'sent', email: 'failed-permanent' });
    });

    it('skips a route that is off', async () => {
      setRoute('email');
      const telegram = vi.fn(async () => 'sent' as const);
      expect(await sendTestAdminAlerts({ telegram })).toEqual({
        telegram: 'off',
        email: 'sent',
      });
      expect(telegram).not.toHaveBeenCalled();
    });
  });
});
