/**
 * The SMTP provider (OUTBOUND_MAIL_PROVIDER=smtp), through the REAL outbound
 * path: outbox, delivery gate, recipient rules, audit log. The mail server is
 * a local one inside this process (test-support/smtp-test-server.ts); no test
 * contacts a real mail server. The HTTP provider's `fetch` is a spy that must
 * stay uncalled whenever SMTP is selected.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { simpleParser } from 'mailparser';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string>,
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

vi.mock('./delivery-gate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./delivery-gate.js')>();
  return { ...original, reportDeliveryShortfall: vi.fn() };
});

import {
  ADMIN_ALERT_MAIL_HEADERS,
  _setAdminAlertRetryWaitForTests,
  sendAdminAlertEmail,
} from './admin-alert.js';
import { flushAuditLog } from './audit-log.js';
import { selectEmailThreadId } from './channels/webhook-threading.js';
import { _closeDatabase, _initTestDatabase, peekDeliveryNotes } from './db.js';
import { reportDeliveryShortfall } from './delivery-gate.js';
import { findUnconfirmedSends } from './email-delivery-check.js';
import { checkParsedForLoop } from './email-loop-detection.js';
import {
  _resetOutboundEmailQueueForTests,
  _setProviderTimeoutMsForTests,
  _setStaggerMsForTests,
  sendOutboundEmailResult,
} from './outbound-email.js';
import { MemoryOutboxStore } from './outbound-email-outbox.js';
import {
  _setSmtpTlsCaForTests,
  assertOutboundMailConfigured,
  classifySmtpError,
  getOutboundMailProvider,
  loadSmtpConfig,
  outboundMailConfigProblems,
  smtpProviderId,
} from './outbound-email-smtp.js';
import {
  rawHeader,
  startTestSmtpServer,
  type TestSmtpServer,
} from './test-support/smtp-test-server.js';

const PERSON = 'person@example.edu';
const COLLEAGUE = 'colleague@example.edu';
const OPERATOR = 'avery@example.edu';
const BOT = 'program@example.org';

const ALLOWLIST = {
  available: true,
  senders: new Set([PERSON, COLLEAGUE]),
  source: 'test',
};

const EMAIL = { to: PERSON, subject: 'Test subject', body: 'Test body' };

let nextId = 0;
function options(extra: Record<string, unknown> = {}) {
  nextId += 1;
  return {
    sourceGroup: 'webhook-email:test',
    forceBotReplyTo: true,
    deliveryId: `smtp-delivery-${nextId}`,
    allowlistState: ALLOWLIST,
    ...extra,
  };
}

function smtpEnv(
  server: TestSmtpServer,
  security: 'tls' | 'starttls',
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    OUTBOUND_MAIL_PROVIDER: 'smtp',
    SMTP_HOST: server.host,
    SMTP_PORT: String(server.port),
    SMTP_SECURITY: security,
    SMTP_USERNAME: server.username,
    SMTP_PASSWORD: server.password,
    SEND_FROM_NAME: 'Coordinator',
    SEND_FROM_EMAIL: BOT,
    OPERATOR_CC_EMAIL: OPERATOR,
    ...extra,
  };
}

const shortfalls = () =>
  vi.mocked(reportDeliveryShortfall).mock.calls.map((call) => call[0]);

describe('SMTP provider settings', () => {
  beforeEach(() => {
    mocks.env = {};
    for (const key of [
      'OUTBOUND_MAIL_PROVIDER',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURITY',
      'SMTP_USERNAME',
      'SMTP_PASSWORD',
      'SMTP_ENVELOPE_FROM',
      'NODE_TLS_REJECT_UNAUTHORIZED',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const GOOD = {
    OUTBOUND_MAIL_PROVIDER: 'smtp',
    SMTP_HOST: 'smtp.example.edu',
    SMTP_USERNAME: 'program-mailbox',
    SMTP_PASSWORD: 'test-only-not-a-real-password',
  };

  it('with nothing set the provider is the default and the host starts', () => {
    expect(getOutboundMailProvider()).toBe('resend');
    expect(outboundMailConfigProblems()).toEqual([]);
    expect(() => assertOutboundMailConfigured()).not.toThrow();
  });

  it('the default provider needs no SMTP setting, and stray ones are ignored', () => {
    mocks.env = { SMTP_SECURITY: 'none', SMTP_HOST: 'smtp.example.edu' };
    expect(getOutboundMailProvider()).toBe('resend');
    expect(() => assertOutboundMailConfigured()).not.toThrow();
  });

  it('STARTTLS on port 587 is the default; implicit TLS defaults to 465', () => {
    mocks.env = { ...GOOD };
    expect(loadSmtpConfig()).toEqual({
      ok: true,
      config: {
        host: 'smtp.example.edu',
        port: 587,
        security: 'starttls',
        username: 'program-mailbox',
        password: 'test-only-not-a-real-password',
      },
    });
    mocks.env = { ...GOOD, SMTP_SECURITY: 'tls' };
    expect(loadSmtpConfig()).toMatchObject({
      ok: true,
      config: { port: 465, security: 'tls' },
    });
    mocks.env = {
      ...GOOD,
      SMTP_PORT: '2525',
      SMTP_ENVELOPE_FROM: 'bounces@example.edu',
    };
    expect(loadSmtpConfig()).toMatchObject({
      ok: true,
      config: { port: 2525, envelopeFrom: 'bounces@example.edu' },
    });
  });

  it.each(['none', 'plain', 'off', 'opportunistic', 'false', 'ssl-optional'])(
    'refuses to start with SMTP_SECURITY=%s: no unencrypted mode exists',
    (value) => {
      mocks.env = { ...GOOD, SMTP_SECURITY: value };
      expect(() => assertOutboundMailConfigured()).toThrow(
        /SMTP_SECURITY must be `starttls` or `tls`/,
      );
    },
  );

  it('refuses to start when TLS certificate checks are turned off for the process', () => {
    mocks.env = { ...GOOD };
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    expect(() => assertOutboundMailConfigured()).toThrow(
      /NODE_TLS_REJECT_UNAUTHORIZED=0/,
    );
  });

  it('refuses to start without a host, a username or a password, and names each', () => {
    mocks.env = { OUTBOUND_MAIL_PROVIDER: 'smtp' };
    expect(outboundMailConfigProblems()).toEqual([
      'SMTP_HOST is not set.',
      'SMTP_USERNAME is not set.',
      'SMTP_PASSWORD is not set in the `.env` file.',
    ]);
    expect(() => assertOutboundMailConfigured()).toThrow(
      /Outbound mail is not configured safely/,
    );
  });

  it('reads the password from the .env file only, never the process environment', () => {
    mocks.env = { ...GOOD, SMTP_PASSWORD: '' };
    vi.stubEnv('SMTP_PASSWORD', 'from-process-env');
    expect(outboundMailConfigProblems()).toEqual([
      'SMTP_PASSWORD is not set in the `.env` file.',
    ]);
  });

  it('refuses a host with a scheme or port, a bad port and a bad envelope sender', () => {
    mocks.env = {
      ...GOOD,
      SMTP_HOST: 'smtp://smtp.example.edu:587',
      SMTP_PORT: '70000',
      SMTP_ENVELOPE_FROM: 'Bounces <bounces@example.edu>',
    };
    expect(outboundMailConfigProblems()).toEqual([
      'SMTP_HOST must be a bare host name (no scheme, port, path or spaces).',
      'SMTP_PORT must be a port number from 1 to 65535.',
      'SMTP_ENVELOPE_FROM must be one plain mail address.',
    ]);
  });

  it('refuses to start on a provider name it does not know', () => {
    mocks.env = { OUTBOUND_MAIL_PROVIDER: 'sendmail' };
    expect(getOutboundMailProvider()).toBe('invalid');
    expect(() => assertOutboundMailConfigured()).toThrow(
      /OUTBOUND_MAIL_PROVIDER must be `resend` or `smtp`/,
    );
  });

  it('reads the provider from the process environment too', () => {
    vi.stubEnv('OUTBOUND_MAIL_PROVIDER', 'SMTP');
    expect(getOutboundMailProvider()).toBe('smtp');
  });
});

describe('SMTP outcome mapping', () => {
  it('4yz replies are retryable and 5yz replies are permanent, at every step', () => {
    for (const stage of ['connect', 'auth', 'envelope', 'content'] as const) {
      expect(
        classifySmtpError(
          { responseCode: 451, response: '451 4.3.0 later' },
          stage,
        ),
      ).toEqual({
        reason: `smtp-error: ${stage} 451 4.3.0 later`,
        retryable: true,
      });
      expect(
        classifySmtpError({ responseCode: 421, response: '421 busy' }, stage)
          .retryable,
      ).toBe(true);
      expect(
        classifySmtpError(
          { responseCode: 554, response: '554 5.7.1 no' },
          stage,
        ),
      ).toEqual({
        reason: `smtp-error: ${stage} 554 5.7.1 no`,
        retryable: false,
      });
    }
  });

  it('no reply before any content was written is retryable', () => {
    for (const code of [
      'ETIMEDOUT',
      'ECONNECTION',
      'ETLS',
      'EDNS',
      'ESOCKET',
    ]) {
      for (const stage of ['connect', 'auth', 'envelope'] as const) {
        expect(classifySmtpError({ code, message: 'x' }, stage).retryable).toBe(
          true,
        );
      }
    }
  });

  it('no reply after content was written is an unknown outcome and is not retried', () => {
    const result = classifySmtpError({ code: 'ETIMEDOUT' }, 'content');
    expect(result.retryable).toBe(false);
    expect(result.reason).toMatch(/^smtp-outcome-unknown: /);
  });

  it('a refusal the client makes itself is permanent', () => {
    expect(
      classifySmtpError({ code: 'EAUTH', command: 'API', message: 'm' }, 'auth')
        .retryable,
    ).toBe(false);
    expect(
      classifySmtpError({ code: 'ENOTENCRYPTED', message: 'm' }, 'connect'),
    ).toMatchObject({ retryable: false });
  });

  it('every recipient refused: retryable only when one refusal was temporary', () => {
    expect(
      classifySmtpError(
        {
          responseCode: 550,
          rejectedErrors: [
            {
              recipient: PERSON,
              response: '550 5.1.1 unknown',
              responseCode: 550,
            },
          ],
        },
        'envelope',
      ),
    ).toEqual({
      reason: `smtp-all-recipients-refused: ${PERSON} (550 5.1.1 unknown)`,
      retryable: false,
    });
    expect(
      classifySmtpError(
        {
          responseCode: 450,
          rejectedErrors: [
            { recipient: PERSON, response: '550 no', responseCode: 550 },
            { recipient: COLLEAGUE, response: '450 later', responseCode: 450 },
          ],
        },
        'envelope',
      ).retryable,
    ).toBe(true);
  });
});

describe('outbound email over SMTP', () => {
  let tls: TestSmtpServer;
  let starttls: TestSmtpServer;
  let plain: TestSmtpServer;
  let repo: string;

  beforeAll(async () => {
    tls = await startTestSmtpServer({ mode: 'tls' });
    starttls = await startTestSmtpServer({ mode: 'starttls' });
    plain = await startTestSmtpServer({ mode: 'plain' });
  });

  afterAll(async () => {
    await Promise.all([tls.close(), starttls.close(), plain.close()]);
  });

  beforeEach(() => {
    for (const server of [tls, starttls, plain]) {
      server.received.length = 0;
      server.logins.length = 0;
      server.dataAttempts = 0;
      server.connections = 0;
      server.behaviour = {};
    }
    _initTestDatabase();
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(5_000);
    _setSmtpTlsCaForTests(tls.ca);
    _setAdminAlertRetryWaitForTests(async () => {});
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-audit-'));
    fs.mkdirSync(path.join(repo, '.git'));
    vi.stubEnv('PROGRAM_HOST_REPO', repo);
    vi.stubEnv('OUTBOUND_MAIL_PROVIDER', '');
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '');
    vi.stubEnv('ADMIN_ALERT_ROUTE', '');
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    vi.mocked(reportDeliveryShortfall).mockClear();
    mocks.env = smtpEnv(tls, 'tls');
  });

  afterEach(() => {
    _setSmtpTlsCaForTests(undefined);
    _setAdminAlertRetryWaitForTests(undefined);
    flushAuditLog();
    _closeDatabase();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function auditLog(): string {
    flushAuditLog();
    const dir = path.join(repo, 'discussions', 'audit-log');
    if (!fs.existsSync(dir)) return '';
    return fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
  }

  describe('delivery', () => {
    it('delivers over implicit TLS, authenticated, with the expected message', async () => {
      const opts = options();
      const result = await sendOutboundEmailResult(
        { ...EMAIL, cc: COLLEAGUE },
        opts,
      );

      expect(result).toEqual({
        status: 'sent',
        resendId: smtpProviderId(opts.deliveryId),
      });
      expect(tls.received).toHaveLength(1);
      const mail = tls.received[0];
      expect(mail.secure).toBe(true);
      expect(mail.user).toBe(tls.username);
      expect(mail.envelopeFrom).toBe(BOT);
      expect(mail.rcptTo).toEqual([PERSON, COLLEAGUE]);
      expect(rawHeader(mail.raw, 'From')).toBe(`Coordinator <${BOT}>`);
      expect(rawHeader(mail.raw, 'To')).toBe(PERSON);
      expect(rawHeader(mail.raw, 'Cc')).toBe(COLLEAGUE);
      expect(rawHeader(mail.raw, 'Subject')).toBe('Test subject');
      expect(rawHeader(mail.raw, 'Reply-To')).toBe(BOT);
      expect(rawHeader(mail.raw, 'Bcc')).toBeUndefined();
      const parsed = await simpleParser(mail.raw);
      expect(parsed.text?.trim()).toBe('Test body');
      expect(parsed.attachments).toEqual([]);
      // The password travelled only inside the encrypted session.
      expect(tls.logins).toEqual([
        { user: tls.username, pass: tls.password, secure: true },
      ]);
      // Nothing went to the HTTP provider.
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(shortfalls()).toEqual([]);
    });

    it('delivers over STARTTLS: the session is encrypted before the login', async () => {
      mocks.env = smtpEnv(starttls, 'starttls');
      _setSmtpTlsCaForTests(starttls.ca);
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result.status).toBe('sent');
      expect(starttls.received).toHaveLength(1);
      expect(starttls.received[0].secure).toBe(true);
      expect(starttls.logins).toEqual([
        { user: starttls.username, pass: starttls.password, secure: true },
      ]);
    });

    it('never logs in or sends when the server offers no STARTTLS', async () => {
      // This server would accept a login and mail in the clear.
      mocks.env = smtpEnv(plain, 'starttls');
      _setSmtpTlsCaForTests(plain.ca);
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result).toMatchObject({ status: 'failed' });
      expect(result.status === 'failed' && result.reason).toMatch(
        /^smtp-tls-failed: STARTTLS refused: connect 5\d\d /,
      );
      expect(result).toMatchObject({ retryable: false });
      expect(plain.connections).toBeGreaterThan(0);
      expect(plain.logins).toEqual([]);
      expect(plain.received).toEqual([]);
      expect(plain.dataAttempts).toBe(0);
    });

    it('never sends to a server whose certificate it cannot verify', async () => {
      _setSmtpTlsCaForTests(undefined);
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result).toMatchObject({ status: 'failed', retryable: true });
      expect(tls.logins).toEqual([]);
      expect(tls.received).toEqual([]);
    });

    it('uses SMTP_ENVELOPE_FROM for MAIL FROM and leaves the From header alone', async () => {
      mocks.env = smtpEnv(tls, 'tls', {
        SMTP_ENVELOPE_FROM: 'bounces@example.org',
      });
      await sendOutboundEmailResult(EMAIL, options());

      expect(tls.received[0].envelopeFrom).toBe('bounces@example.org');
      expect(rawHeader(tls.received[0].raw, 'From')).toBe(
        `Coordinator <${BOT}>`,
      );
    });

    it('a second call with the same delivery id does not send again', async () => {
      const opts = options();
      const first = await sendOutboundEmailResult(EMAIL, opts);
      const second = await sendOutboundEmailResult(EMAIL, opts);

      expect(second).toEqual(first);
      expect(tls.received).toHaveLength(1);
    });

    it('fails without contacting anything when the settings are unusable at send time', async () => {
      mocks.env = { ...smtpEnv(tls, 'tls'), SMTP_SECURITY: 'none' };
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result).toEqual({
        status: 'failed',
        reason: 'outbound-mail-config-invalid',
        retryable: false,
      });
      expect(tls.connections).toBe(0);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(shortfalls()).toEqual([
        expect.objectContaining({ missed: [PERSON], sent: [] }),
      ]);
    });

    it('an unknown provider name sends nowhere, not to the default provider', async () => {
      mocks.env = {
        ...smtpEnv(tls, 'tls'),
        OUTBOUND_MAIL_PROVIDER: 'sendmail',
        RESEND_API_KEY: 're_test',
      };
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result).toMatchObject({
        status: 'failed',
        reason: 'outbound-mail-config-invalid',
      });
      expect(tls.connections).toBe(0);
      expect(mocks.fetch).not.toHaveBeenCalled();
    });
  });

  describe('reply threading', () => {
    const PARENT = '<parent-message-1@example.edu>';

    it('carries the same Message-ID, In-Reply-To and References the HTTP provider is given', async () => {
      const deliveryId = 'threading-parity-1';
      await sendOutboundEmailResult(
        EMAIL,
        options({ deliveryId, inReplyTo: PARENT }),
      );
      const raw = tls.received[0].raw;

      // The same send through the default provider.
      _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
      _setStaggerMsForTests(0);
      mocks.env = {
        RESEND_API_KEY: 're_test',
        SEND_FROM_NAME: 'Coordinator',
        SEND_FROM_EMAIL: BOT,
      };
      mocks.fetch.mockResolvedValue(
        new Response(JSON.stringify({ id: 're_1' }), { status: 200 }),
      );
      await sendOutboundEmailResult(
        EMAIL,
        options({ deliveryId, inReplyTo: PARENT }),
      );
      const http = JSON.parse(mocks.fetch.mock.calls[0][1].body as string);

      expect(rawHeader(raw, 'Message-ID')).toBe(http.headers['Message-ID']);
      expect(rawHeader(raw, 'In-Reply-To')).toBe(http.headers['In-Reply-To']);
      expect(rawHeader(raw, 'References')).toBe(http.headers.References);
      expect(rawHeader(raw, 'In-Reply-To')).toBe(PARENT);
      expect(rawHeader(raw, 'Message-ID')).toMatch(
        /^<outreach-[0-9a-f]{32}@[a-z0-9.-]+>$/,
      );
      expect(rawHeader(raw, 'From')).toBe(http.from);
      expect(rawHeader(raw, 'Reply-To')).toBe(http.reply_to);
      expect(rawHeader(raw, 'Subject')).toBe(http.subject);
      const parsed = await simpleParser(raw);
      expect(parsed.text?.trim()).toBe(http.text);
    });

    it("the bot's own thread rule files the SMTP message under the parent", async () => {
      await sendOutboundEmailResult(EMAIL, options({ inReplyTo: PARENT }));
      expect(selectEmailThreadId(tls.received[0].raw)).toBe(
        'parent-message-1@example.edu',
      );
    });

    it('a message that starts a thread has a Message-ID and no threading headers', async () => {
      await sendOutboundEmailResult(EMAIL, options());
      const raw = tls.received[0].raw;
      expect(rawHeader(raw, 'Message-ID')).toMatch(/^<outreach-/);
      expect(rawHeader(raw, 'In-Reply-To')).toBeUndefined();
      expect(rawHeader(raw, 'References')).toBeUndefined();
    });

    it('a retried delivery arrives once, and two deliveries carry different Message-IDs', async () => {
      tls.behaviour = {
        data: { code: 451, message: '4.3.0 try again' },
        dataFailures: 1,
      };
      const opts = options();
      const first = await sendOutboundEmailResult(EMAIL, opts);
      expect(first).toMatchObject({ status: 'failed', retryable: true });
      const second = await sendOutboundEmailResult(EMAIL, opts);
      expect(second.status).toBe('sent');
      await sendOutboundEmailResult(EMAIL, options());

      expect(tls.received).toHaveLength(2);
      expect(rawHeader(tls.received[0].raw, 'Message-ID')).not.toBe(
        rawHeader(tls.received[1].raw, 'Message-ID'),
      );
    });

    it('a line break in a threading id or a subject cannot add a header or a recipient', async () => {
      await sendOutboundEmailResult(
        { ...EMAIL, subject: 'Hello\r\nBcc: hidden@example.org' },
        options({
          inReplyTo: '<parent@example.edu>\r\nBcc: hidden@example.org',
        }),
      );
      const mail = tls.received[0];
      expect(mail.rcptTo).toEqual([PERSON]);
      expect(rawHeader(mail.raw, 'Bcc')).toBeUndefined();
      expect(mail.raw.split(/\r?\n\r?\n/)[0]).not.toMatch(/^Bcc:/im);
    });

    it('passes extra headers through, and none of them can replace a header the host sets', async () => {
      await sendOutboundEmailResult(
        EMAIL,
        options({
          inReplyTo: PARENT,
          extraHeaders: {
            'Auto-Submitted': 'auto-replied',
            'X-Auto-Response-Suppress': 'All',
            'message-id': '<forged@example.org>',
            References: '<forged@example.org>',
            Bcc: 'hidden@example.org',
            From: 'someone-else@example.org',
          },
        }),
      );
      const mail = tls.received[0];
      expect(rawHeader(mail.raw, 'Auto-Submitted')).toBe('auto-replied');
      expect(rawHeader(mail.raw, 'X-Auto-Response-Suppress')).toBe('All');
      expect(mail.raw).not.toContain('forged@example.org');
      expect(mail.raw).not.toContain('hidden@example.org');
      expect(mail.raw).not.toContain('someone-else@example.org');
      expect(mail.rcptTo).toEqual([PERSON]);
    });
  });

  describe('recipients refused by the server', () => {
    it('some refused: the rest get the mail, the shortfall is reported and recorded, and nothing is retried', async () => {
      tls.behaviour = {
        rcpt: (address) =>
          address === COLLEAGUE
            ? { code: 550, message: '5.1.1 no such mailbox' }
            : undefined,
      };
      const opts = options();
      const result = await sendOutboundEmailResult(
        { ...EMAIL, cc: COLLEAGUE },
        opts,
      );

      expect(result).toEqual({
        status: 'sent',
        resendId: smtpProviderId(opts.deliveryId),
      });
      expect(tls.received).toHaveLength(1);
      expect(tls.received[0].rcptTo).toEqual([PERSON]);
      expect(tls.dataAttempts).toBe(1);

      // Delivery completeness: intended = sent + missed, by name.
      expect(shortfalls()).toEqual([
        expect.objectContaining({
          channel: 'email',
          intended: [PERSON, COLLEAGUE],
          sent: [PERSON],
          missed: [COLLEAGUE],
          reason: `smtp-recipient-refused: ${COLLEAGUE} (550 5.1.1 no such mailbox)`,
        }),
      ]);
      const log = auditLog();
      expect(log).toContain('**[OUTBOUND EMAIL]**');
      expect(log).toContain(
        `**[DELIVERY PROBLEM]** smtp.recipient_refused | To: ${COLLEAGUE} | Subject: Test subject`,
      );
      expect(log).toContain(
        `**Delivery-Problem-ID:** smtp.recipient_refused:${smtpProviderId(opts.deliveryId)}`,
      );
      const notes = peekDeliveryNotes(['webhook-email:test']);
      expect(notes).toHaveLength(1);
      expect(notes[0].note).toContain(COLLEAGUE);
      expect(notes[0].note).toContain('smtp-recipient-refused');
    });

    it('a temporarily refused recipient among accepted ones is reported, not retried', async () => {
      tls.behaviour = {
        rcpt: (address) =>
          address === COLLEAGUE
            ? { code: 452, message: '4.2.2 mailbox full' }
            : undefined,
      };
      const opts = options();
      const result = await sendOutboundEmailResult(
        { ...EMAIL, cc: COLLEAGUE },
        opts,
      );
      await sendOutboundEmailResult({ ...EMAIL, cc: COLLEAGUE }, opts);

      expect(result.status).toBe('sent');
      expect(tls.received).toHaveLength(1);
      expect(shortfalls()).toHaveLength(1);
      expect(shortfalls()[0]).toMatchObject({ missed: [COLLEAGUE] });
    });

    it('every recipient refused permanently: nothing sent, permanent failure naming each', async () => {
      tls.behaviour = {
        rcpt: () => ({ code: 550, message: '5.1.1 no such mailbox' }),
      };
      const result = await sendOutboundEmailResult(
        { ...EMAIL, cc: COLLEAGUE },
        options(),
      );

      expect(result).toEqual({
        status: 'failed',
        reason:
          `smtp-all-recipients-refused: ${PERSON} (550 5.1.1 no such mailbox); ` +
          `${COLLEAGUE} (550 5.1.1 no such mailbox)`,
        retryable: false,
      });
      expect(tls.received).toEqual([]);
      expect(shortfalls()).toEqual([
        expect.objectContaining({
          sent: [],
          missed: [PERSON, COLLEAGUE],
        }),
      ]);
      expect(auditLog()).not.toContain('[OUTBOUND EMAIL]');
    });

    it('every recipient refused, one of them temporarily: retryable', async () => {
      tls.behaviour = {
        rcpt: (address) =>
          address === PERSON
            ? { code: 450, message: '4.2.1 try later' }
            : { code: 550, message: '5.1.1 no such mailbox' },
      };
      const result = await sendOutboundEmailResult(
        { ...EMAIL, cc: COLLEAGUE },
        options(),
      );

      expect(result).toMatchObject({ status: 'failed', retryable: true });
      expect(tls.received).toEqual([]);
    });
  });

  describe('retryable and permanent failures', () => {
    it('a 4yz reply after the content is retryable, and the retry delivers once', async () => {
      tls.behaviour = {
        data: { code: 451, message: '4.3.0 try again later' },
        dataFailures: 1,
      };
      const opts = options();
      const first = await sendOutboundEmailResult(EMAIL, opts);

      expect(first).toEqual({
        status: 'failed',
        reason: 'smtp-error: content 451 4.3.0 try again later',
        retryable: true,
      });
      expect(tls.received).toEqual([]);
      expect(peekDeliveryNotes(['webhook-email:test'])).toEqual([]);

      const second = await sendOutboundEmailResult(EMAIL, opts);
      expect(second).toEqual({
        status: 'sent',
        resendId: smtpProviderId(opts.deliveryId),
      });
      expect(tls.received).toHaveLength(1);
      expect(tls.dataAttempts).toBe(2);
    });

    it('a 5yz reply after the content is permanent and is not retried', async () => {
      tls.behaviour = { data: { code: 554, message: '5.7.1 rejected' } };
      const opts = options();
      const result = await sendOutboundEmailResult(EMAIL, opts);
      const again = await sendOutboundEmailResult(EMAIL, opts);

      expect(result).toEqual({
        status: 'failed',
        reason: 'smtp-error: content 554 5.7.1 rejected',
        retryable: false,
      });
      expect(again).toEqual(result);
      expect(tls.dataAttempts).toBe(1);
      expect(shortfalls()).toEqual([
        expect.objectContaining({ sent: [], missed: [PERSON] }),
      ]);
      expect(peekDeliveryNotes(['webhook-email:test'])).toHaveLength(1);
      expect(auditLog()).not.toContain('[OUTBOUND EMAIL]');
    });

    it('a wrong password is permanent: 535', async () => {
      mocks.env = { ...smtpEnv(tls, 'tls'), SMTP_PASSWORD: 'wrong-password' };
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result).toMatchObject({ status: 'failed', retryable: false });
      expect(result.status === 'failed' && result.reason).toMatch(
        /^smtp-error: auth 535 /,
      );
      expect(tls.received).toEqual([]);
    });

    it('a temporary authentication failure is retryable: 454', async () => {
      tls.behaviour = { auth: { code: 454, message: '4.7.0 temporary' } };
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result).toMatchObject({ status: 'failed', retryable: true });
    });

    it('a refused sender is permanent on 5yz and retryable on 4yz', async () => {
      tls.behaviour = {
        mailFrom: { code: 550, message: '5.7.60 not allowed' },
      };
      expect(await sendOutboundEmailResult(EMAIL, options())).toMatchObject({
        status: 'failed',
        retryable: false,
      });
      tls.behaviour = { mailFrom: { code: 451, message: '4.7.1 later' } };
      expect(await sendOutboundEmailResult(EMAIL, options())).toMatchObject({
        status: 'failed',
        retryable: true,
      });
      expect(tls.received).toEqual([]);
    });

    it('a refused connection is retryable', async () => {
      // A port nothing listens on: bind one, read it, release it.
      const probe = net.createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, '127.0.0.1', resolve),
      );
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise((resolve) => probe.close(resolve));
      mocks.env = { ...smtpEnv(tls, 'tls'), SMTP_PORT: String(port) };

      const result = await sendOutboundEmailResult(EMAIL, options());
      expect(result).toMatchObject({ status: 'failed', retryable: true });
      expect(result.status === 'failed' && result.reason).toMatch(
        /^smtp-connection-failed: connect /,
      );
    });
  });

  describe('timeouts', () => {
    it('a server that never greets: bounded by the provider deadline, retryable', async () => {
      const silent = net.createServer(() => {
        /* accept and say nothing */
      });
      await new Promise<void>((resolve) =>
        silent.listen(0, '127.0.0.1', resolve),
      );
      const port = (silent.address() as net.AddressInfo).port;
      mocks.env = { ...smtpEnv(starttls, 'starttls'), SMTP_PORT: String(port) };
      _setProviderTimeoutMsForTests(300);

      const started = Date.now();
      const result = await sendOutboundEmailResult(EMAIL, options());
      const elapsed = Date.now() - started;
      silent.close();

      expect(result).toMatchObject({ status: 'failed', retryable: true });
      expect(elapsed).toBeLessThan(3_000);
    });

    it('no reply after the content was written: unknown outcome, reported, not retried', async () => {
      tls.behaviour = { data: 'hang' };
      _setProviderTimeoutMsForTests(400);
      const opts = options();
      const result = await sendOutboundEmailResult(EMAIL, opts);
      const again = await sendOutboundEmailResult(EMAIL, opts);

      expect(result.status).toBe('failed');
      expect(result).toMatchObject({ retryable: false });
      expect(result.status === 'failed' && result.reason).toMatch(
        /^smtp-outcome-unknown: /,
      );
      expect(again).toEqual(result);
      // One submission only: a retry could deliver the mail twice.
      expect(tls.dataAttempts).toBe(1);
      expect(shortfalls()).toEqual([
        expect.objectContaining({ sent: [], missed: [PERSON] }),
      ]);
    });

    it('a connection cut after the content was written is also an unknown outcome', async () => {
      tls.behaviour = { data: 'drop' };
      const result = await sendOutboundEmailResult(EMAIL, options());

      expect(result).toMatchObject({ status: 'failed', retryable: false });
      expect(result.status === 'failed' && result.reason).toMatch(
        /^smtp-outcome-unknown: /,
      );
      expect(tls.dataAttempts).toBe(1);
    });

    it('a hung send does not block the next one in the queue', async () => {
      tls.behaviour = { data: 'hang', dataFailures: 1 };
      _setProviderTimeoutMsForTests(400);
      const first = sendOutboundEmailResult(EMAIL, options());
      const second = sendOutboundEmailResult(EMAIL, options());

      expect((await first).status).toBe('failed');
      expect((await second).status).toBe('sent');
      expect(tls.received).toHaveLength(1);
    });
  });

  describe('stagger', () => {
    it('sends one at a time with the configured delay between them', async () => {
      _setStaggerMsForTests(400);
      const results = await Promise.all([
        sendOutboundEmailResult(EMAIL, options()),
        sendOutboundEmailResult(EMAIL, options()),
        sendOutboundEmailResult(EMAIL, options()),
      ]);

      expect(results.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
      expect(tls.received).toHaveLength(3);
      const gaps = tls.received
        .slice(1)
        .map((mail, i) => mail.at - tls.received[i].at);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(390);
    });
  });

  describe('audit entry', () => {
    it('writes one [OUTBOUND EMAIL] entry with the recipients, subject, source, id and body', async () => {
      const opts = options({ sourceGroup: 'main' });
      await sendOutboundEmailResult(
        { ...EMAIL, cc: COLLEAGUE, body: 'The agenda is attached below.' },
        opts,
      );
      const log = auditLog();

      expect(log.match(/\*\*\[OUTBOUND EMAIL\]\*\*/g)).toHaveLength(1);
      expect(log).toContain(
        `**[OUTBOUND EMAIL]** To: ${PERSON} | CC: ${COLLEAGUE} | Subject: Test subject`,
      );
      expect(log).toContain(
        `**Source:** main | **Resend ID:** ${smtpProviderId(opts.deliveryId)}`,
      );
      expect(log).toContain(`**Delivery-ID:** ${opts.deliveryId}`);
      expect(log).toContain('The agenda is attached below.');
    });

    it('writes no entry when the caller defers the audit, as the reply path does', async () => {
      const result = await sendOutboundEmailResult(
        EMAIL,
        options({ deferAudit: true }),
      );
      expect(result.status).toBe('sent');
      expect(auditLog()).not.toContain('[OUTBOUND EMAIL]');
    });

    it('does not register the send with the delivery check: SMTP reports no delivery events', async () => {
      await sendOutboundEmailResult(EMAIL, options());
      const thirteenHoursLater = Date.now() + 13 * 60 * 60 * 1000;
      expect(findUnconfirmedSends(thirteenHoursLater)).toEqual([]);
    });
  });

  describe('delivery gate and recipient rules', () => {
    it('a body the delivery gate refuses never reaches the server', async () => {
      const result = await sendOutboundEmailResult(
        { ...EMAIL, body: 'Write to invented@example.org for details.' },
        options(),
      );

      expect(result).toEqual({
        status: 'failed',
        reason:
          'body-refused-by-delivery-gate: unverified-email-address: invented@example.org',
        retryable: false,
      });
      expect(tls.connections).toBe(0);
    });

    it('a To recipient off the allowlist is refused before any connection', async () => {
      const result = await sendOutboundEmailResult(
        { ...EMAIL, to: 'stranger@example.com' },
        options(),
      );

      expect(result).toEqual({
        status: 'failed',
        reason: 'to-recipient-not-allowlisted: stranger@example.com',
        retryable: false,
      });
      expect(tls.connections).toBe(0);
    });

    it('a CC recipient off the allowlist is dropped and reported; the rest is sent', async () => {
      const result = await sendOutboundEmailResult(
        { ...EMAIL, cc: `${COLLEAGUE}, stranger@example.com` },
        options(),
      );

      expect(result.status).toBe('sent');
      expect(tls.received[0].rcptTo).toEqual([PERSON, COLLEAGUE]);
      expect(tls.received[0].raw).not.toContain('stranger@example.com');
      expect(shortfalls()).toEqual([
        expect.objectContaining({
          missed: ['stranger@example.com'],
          sent: [PERSON, COLLEAGUE],
        }),
      ]);
    });

    it('the allowlist exemption still takes exactly one To recipient', async () => {
      const result = await sendOutboundEmailResult(
        { ...EMAIL, to: `${PERSON}, stranger@example.com` },
        options({ toAllowlistExemption: { reason: 'test' } }),
      );

      expect(result).toMatchObject({
        status: 'failed',
        reason: 'exemption-requires-single-recipient',
      });
      expect(tls.connections).toBe(0);
    });

    it('a host-composed send replies to the bot; an agent send may set Reply-To', async () => {
      await sendOutboundEmailResult(
        { ...EMAIL, reply_to: COLLEAGUE },
        options({ forceBotReplyTo: true }),
      );
      await sendOutboundEmailResult(
        { ...EMAIL, reply_to: COLLEAGUE },
        options({ forceBotReplyTo: false }),
      );

      expect(rawHeader(tls.received[0].raw, 'Reply-To')).toBe(BOT);
      expect(rawHeader(tls.received[1].raw, 'Reply-To')).toBe(COLLEAGUE);
    });
  });

  describe('operator alert mail', () => {
    it('ADMIN_ALERT_ROUTE=email sends the alert through SMTP, to the operator only, with its loop headers', async () => {
      mocks.env = { ...smtpEnv(tls, 'tls'), ADMIN_ALERT_ROUTE: 'email' };

      expect(await sendAdminAlertEmail('Disk is nearly full')).toBe('sent');

      expect(tls.received).toHaveLength(1);
      const mail = tls.received[0];
      expect(mail.rcptTo).toEqual([OPERATOR]);
      expect(rawHeader(mail.raw, 'Subject')).toContain('Disk is nearly full');
      for (const [name, value] of Object.entries(ADMIN_ALERT_MAIL_HEADERS)) {
        expect(rawHeader(mail.raw, name)).toBe(value);
      }
      const parsed = await simpleParser(mail.raw);
      expect(checkParsedForLoop(parsed).isAutoReply).toBe(true);
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(auditLog()).toContain('**Source:** admin-alert');
    });

    it('reports a permanent SMTP failure of the alert mail as not delivered', async () => {
      mocks.env = { ...smtpEnv(tls, 'tls'), ADMIN_ALERT_ROUTE: 'email' };
      tls.behaviour = { data: { code: 554, message: '5.7.1 rejected' } };

      expect(await sendAdminAlertEmail('Disk is nearly full')).toBe(
        'failed-permanent',
      );
    });
  });

  describe('restart', () => {
    it('a row left pending is sent by the queue of a new start, once', async () => {
      const store = new MemoryOutboxStore();
      _resetOutboundEmailQueueForTests(store);
      _setStaggerMsForTests(0);
      const at = new Date().toISOString();
      store.insert({
        deliveryId: 'left-pending-1',
        lane: 'transactional',
        status: 'pending',
        email: EMAIL,
        sendOptions: {
          sourceGroup: 'webhook-email:test',
          forceBotReplyTo: true,
          lane: 'transactional',
          allowlistState: {
            available: true,
            senders: [PERSON],
            source: 'test',
          },
        },
        intended: [PERSON],
        createdAt: at,
        updatedAt: at,
      });

      const { startOutboundEmailQueue } = await import('./outbound-email.js');
      startOutboundEmailQueue();

      await vi.waitFor(() => expect(tls.received).toHaveLength(1), {
        timeout: 5_000,
      });
      await vi.waitFor(() =>
        expect(store.listAll()[0]).toMatchObject({ status: 'sent' }),
      );
      expect(tls.received[0].rcptTo).toEqual([PERSON]);
      expect(store.listAll()[0].result).toEqual({
        status: 'sent',
        resendId: smtpProviderId('left-pending-1'),
      });
    });
  });
});

/**
 * Restart replay with REAL processes and a REAL SQLite outbox, as
 * outbound-email-restart.test.ts does for the default provider, through the
 * same harness (test/outbox-harness.ts). The harness replaces `fetch` and
 * logs every call to it; with SMTP selected that log must stay empty.
 */
describe('fresh-process outbox replay over SMTP', () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const HARNESS = path.join(REPO_ROOT, 'test', 'outbox-harness.ts');
  const TSX_LOADER = path.join(
    REPO_ROOT,
    'node_modules',
    'tsx',
    'dist',
    'loader.mjs',
  );

  let server: TestSmtpServer;
  let workDir: string;

  beforeAll(async () => {
    server = await startTestSmtpServer({ mode: 'tls' });
  });

  afterAll(async () => {
    await server.close();
  });

  beforeEach(() => {
    server.received.length = 0;
    server.behaviour = {};
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-restart-'));
    fs.mkdirSync(path.join(workDir, 'store'), { recursive: true });
    fs.writeFileSync(
      path.join(workDir, '.env'),
      [
        'OUTBOUND_MAIL_PROVIDER=smtp',
        `SMTP_HOST=${server.host}`,
        `SMTP_PORT=${server.port}`,
        'SMTP_SECURITY=tls',
        `SMTP_USERNAME=${server.username}`,
        `SMTP_PASSWORD=${server.password}`,
        'SEND_FROM_NAME=Coordinator',
        `SEND_FROM_EMAIL=${BOT}`,
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  interface Run {
    kill(signal: NodeJS.Signals): void;
    stdout: string;
    stderr: string;
    exited: Promise<number>;
  }

  function startHarness(mode: string, env: Record<string, string>): Run {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...env,
      HARNESS_LOG: path.join(workDir, 'provider-calls.jsonl'),
      // Trust the test server's certificate in the child, the standard way.
      NODE_EXTRA_CA_CERTS: server.caPath,
    };
    delete childEnv.VITEST;
    delete childEnv.VITEST_WORKER_ID;
    delete childEnv.NODE_ENV;
    delete childEnv.OUTBOUND_MAIL_PROVIDER;
    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, HARNESS, mode],
      { cwd: workDir, env: childEnv },
    );
    const run: Run = {
      kill: (signal) => void child.kill(signal),
      stdout: '',
      stderr: '',
      exited: new Promise<number>((resolve) => {
        child.on('exit', (code) => resolve(code ?? -1));
      }),
    };
    child.stdout.on('data', (chunk: Buffer) => {
      run.stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      run.stderr += chunk.toString();
    });
    return run;
  }

  function rows(run: Run): Array<Record<string, unknown>> {
    const line = run.stdout
      .split('\n')
      .filter((l) => l.startsWith('HARNESS:'))
      .map((l) => JSON.parse(l.slice('HARNESS:'.length)))
      .reverse()
      .find((e) => e.event === 'rows');
    if (!line) throw new Error(`no rows dump:\n${run.stdout}\n${run.stderr}`);
    return line.rows;
  }

  it('SIGTERM in the stagger gap leaves the row pending and a new process delivers it exactly once', async () => {
    const seed = startHarness('seed-hold', {
      HARNESS_COUNT: '2',
      HARNESS_STAGGER_MS: '20000',
      HARNESS_PROVIDER_TIMEOUT_MS: '5000',
      HARNESS_BATCH: 'smtp-restart',
    });
    await vi.waitFor(
      () =>
        expect(
          server.received.length,
          `stdout:\n${seed.stdout}\nstderr:\n${seed.stderr}`,
        ).toBe(1),
      { timeout: 30_000, interval: 50 },
    );

    seed.kill('SIGTERM');
    expect(
      await seed.exited,
      `stdout:\n${seed.stdout}\nstderr:\n${seed.stderr}`,
    ).toBe(0);
    expect(rows(seed)).toEqual([
      expect.objectContaining({ deliveryId: 'smtp-restart:0', status: 'sent' }),
      expect.objectContaining({
        deliveryId: 'smtp-restart:1',
        status: 'pending',
      }),
    ]);
    expect(server.received).toHaveLength(1);

    const replay = startHarness('replay', {
      HARNESS_STAGGER_MS: '10',
      HARNESS_PROVIDER_TIMEOUT_MS: '5000',
      HARNESS_BATCH: 'smtp-restart',
    });
    expect(
      await replay.exited,
      `stdout:\n${replay.stdout}\nstderr:\n${replay.stderr}`,
    ).toBe(0);

    expect(rows(replay)).toEqual([
      expect.objectContaining({ deliveryId: 'smtp-restart:0', status: 'sent' }),
      expect.objectContaining({ deliveryId: 'smtp-restart:1', status: 'sent' }),
    ]);
    // Exactly one message per delivery, each with its own Message-ID.
    expect(server.received).toHaveLength(2);
    const ids = server.received.map((m) => rawHeader(m.raw, 'Message-ID'));
    expect(new Set(ids).size).toBe(2);
    expect(server.received.every((m) => m.secure)).toBe(true);
    // The HTTP provider was never called by either process.
    expect(fs.existsSync(path.join(workDir, 'provider-calls.jsonl'))).toBe(
      false,
    );
  }, 90_000);
});

describe('default provider, with nothing new set', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(1_000);
    vi.stubEnv('OUTBOUND_MAIL_PROVIDER', '');
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ id: 're_default_1' }), { status: 200 }),
    );
    mocks.env = {
      RESEND_API_KEY: 're_test',
      SEND_FROM_NAME: 'Coordinator',
      SEND_FROM_EMAIL: BOT,
    };
  });

  afterEach(() => {
    _closeDatabase();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('the request to the HTTP provider is byte for byte what it was', async () => {
    const result = await sendOutboundEmailResult(
      { ...EMAIL, cc: COLLEAGUE },
      options({
        deliveryId: 'default-bytes-1',
        inReplyTo: '<parent-message-1@example.edu>',
        deferAudit: true,
      }),
    );

    expect(result).toEqual({ status: 'sent', resendId: 're_default_1' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: 'Bearer re_test',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'default-bytes-1',
    });
    const messageId = JSON.parse(init.body).headers['Message-ID'];
    expect(messageId).toMatch(/^<outreach-[0-9a-f]{32}@[a-z0-9.-]+>$/);
    expect(init.body).toBe(
      '{"from":"Coordinator <program@example.org>",' +
        '"to":["person@example.edu"],"cc":["colleague@example.edu"],' +
        '"subject":"Test subject","text":"Test body",' +
        '"reply_to":"program@example.org",' +
        `"headers":{"Message-ID":"${messageId}",` +
        '"In-Reply-To":"<parent-message-1@example.edu>",' +
        '"References":"<parent-message-1@example.edu>"}}',
    );
  });

  it('SMTP settings left in the file change nothing while the provider is the default', async () => {
    mocks.env = {
      ...mocks.env,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMTP_SECURITY: 'tls',
      SMTP_USERNAME: 'u',
      SMTP_PASSWORD: 'p',
    };
    const result = await sendOutboundEmailResult(
      EMAIL,
      options({ deferAudit: true }),
    );
    expect(result).toEqual({ status: 'sent', resendId: 're_default_1' });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('a missing API key is still the same permanent failure', async () => {
    mocks.env = { SEND_FROM_EMAIL: BOT };
    const result = await sendOutboundEmailResult(EMAIL, options());
    expect(result).toEqual({
      status: 'failed',
      reason: 'resend-api-key-missing',
      retryable: false,
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
