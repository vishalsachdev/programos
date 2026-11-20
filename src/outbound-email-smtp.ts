/**
 * Optional SMTP submission provider for outbound mail.
 *
 * OUTBOUND_MAIL_PROVIDER picks the provider: `resend` (the default, and what
 * an unset value means) or `smtp`. Everything upstream of the provider call
 * in outbound-email.ts (outbox, retry budget, stagger, delivery gate,
 * recipient rules, audit entry, alert mail) is shared; this module is only
 * the wire: it builds one RFC 5322 message and submits it over an encrypted,
 * authenticated SMTP session.
 *
 * Encryption is not optional. SMTP_SECURITY is `starttls` (the session must
 * upgrade before AUTH) or `tls` (TLS from the first byte). There is no
 * plaintext or opportunistic mode, certificate checks are never turned off,
 * and the host refuses to start on a configuration that would allow either
 * (assertOutboundMailConfigured).
 *
 * How SMTP outcomes map onto OutboundEmailResult (see classifySmtpError):
 *
 *   - 2yz after the message content, every recipient accepted: sent.
 *   - 2yz after the content, some recipients refused at RCPT TO: sent to the
 *     accepted ones. The refused ones are a delivery shortfall and a
 *     [DELIVERY PROBLEM] audit entry. Not retried, whatever their code: a
 *     second submission would duplicate the mail for those who have it.
 *   - 4yz at any step (greeting, EHLO, AUTH, MAIL FROM, every RCPT TO, DATA,
 *     or after the content): retryable. The server said it took nothing.
 *   - 5yz at any step: permanent.
 *   - No reply (DNS failure, refused or dropped connection, TLS failure,
 *     timeout) before any message content was written: retryable.
 *   - No reply after message content was written: the outcome is unknown.
 *     Permanent, reported as a shortfall for every recipient. SMTP has no
 *     idempotency key, so a retry could deliver twice; the operator decides.
 *
 * What SMTP does not give: delivery events. A bounce comes back later as
 * mail to the sending mailbox and is not processed; email-loop-detection.ts
 * drops it so it cannot start work. Sends are therefore not registered with
 * the delivery check (email-delivery-check.ts), which would report every
 * one of them as unconfirmed.
 */
import { createHash } from 'crypto';
import { PassThrough } from 'stream';

import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';

import { logDeliveryProblem } from './audit-log.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type OutboundMailProvider = 'resend' | 'smtp';
export type SmtpSecurity = 'starttls' | 'tls';

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  /** SMTP MAIL FROM. Unset: the From address is used. */
  envelopeFrom?: string;
}

const SETTING_KEYS = [
  'OUTBOUND_MAIL_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURITY',
  'SMTP_USERNAME',
  'SMTP_ENVELOPE_FROM',
] as const;

const DEFAULT_PORT: Record<SmtpSecurity, number> = { starttls: 587, tls: 465 };

const WHERE =
  'Set it in the `.env` file in the repo root. See config/instance.env.example.';

/** Process environment first, then `.env`, as the other settings do. */
function readSettings(): Record<string, string | undefined> {
  const file = readEnvFile([...SETTING_KEYS]);
  const out: Record<string, string | undefined> = {};
  for (const key of SETTING_KEYS) {
    out[key] = (process.env[key] || file[key] || '').trim() || undefined;
  }
  return out;
}

/**
 * The configured provider. `invalid` is any value other than the two known
 * ones: the send path then refuses instead of guessing which service the
 * operator meant mail to go through.
 */
export function getOutboundMailProvider(): OutboundMailProvider | 'invalid' {
  const raw = readSettings().OUTBOUND_MAIL_PROVIDER;
  if (!raw) return 'resend';
  const value = raw.toLowerCase();
  return value === 'resend' || value === 'smtp' ? value : 'invalid';
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;
const ADDRESS_PATTERN = /^[^\s<>@,;:"]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/**
 * Read and check the SMTP settings. Returns every problem found; an empty
 * list comes with the usable config. The password is read from `.env` only,
 * never from the process environment, like the other secrets.
 */
export function loadSmtpConfig():
  | { ok: true; config: SmtpConfig }
  | { ok: false; problems: string[] } {
  const settings = readSettings();
  const password = readEnvFile(['SMTP_PASSWORD']).SMTP_PASSWORD;
  const problems: string[] = [];

  const host = settings.SMTP_HOST ?? '';
  if (!host) {
    problems.push('SMTP_HOST is not set.');
  } else if (!HOST_PATTERN.test(host)) {
    problems.push(
      'SMTP_HOST must be a bare host name (no scheme, port, path or spaces).',
    );
  }

  let security: SmtpSecurity = 'starttls';
  const rawSecurity = settings.SMTP_SECURITY?.toLowerCase();
  if (rawSecurity === 'tls' || rawSecurity === 'starttls') {
    security = rawSecurity;
  } else if (rawSecurity !== undefined) {
    problems.push(
      'SMTP_SECURITY must be `starttls` or `tls`. There is no unencrypted or ' +
        'optional-encryption mode: the password and the mail are never sent ' +
        'in the clear.',
    );
  }

  let port = DEFAULT_PORT[security];
  if (settings.SMTP_PORT !== undefined) {
    const parsed = /^\d{1,5}$/.test(settings.SMTP_PORT)
      ? Number(settings.SMTP_PORT)
      : NaN;
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      problems.push('SMTP_PORT must be a port number from 1 to 65535.');
    } else {
      port = parsed;
    }
  }

  const username = settings.SMTP_USERNAME ?? '';
  if (!username) problems.push('SMTP_USERNAME is not set.');
  if (!password) {
    problems.push('SMTP_PASSWORD is not set in the `.env` file.');
  }

  const envelopeFrom = settings.SMTP_ENVELOPE_FROM;
  if (envelopeFrom !== undefined && !ADDRESS_PATTERN.test(envelopeFrom)) {
    problems.push('SMTP_ENVELOPE_FROM must be one plain mail address.');
  }

  // Node turns certificate checks off for every TLS connection in the
  // process when this is 0. With it set, "encrypted" would not mean "to the
  // right server".
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    problems.push(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 is set in the process environment. It ' +
        'turns off TLS certificate checks; remove it.',
    );
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      host,
      port,
      security,
      username,
      password,
      ...(envelopeFrom ? { envelopeFrom } : {}),
    },
  };
}

/** Every reason the outbound mail settings cannot be used. Empty: fine. */
export function outboundMailConfigProblems(): string[] {
  const provider = getOutboundMailProvider();
  if (provider === 'resend') return [];
  if (provider === 'invalid') {
    return ['OUTBOUND_MAIL_PROVIDER must be `resend` or `smtp`.'];
  }
  const loaded = loadSmtpConfig();
  return loaded.ok ? [] : loaded.problems;
}

/**
 * Startup check, called in main(). With the default provider it does
 * nothing. With OUTBOUND_MAIL_PROVIDER=smtp (or an unknown value) the host
 * does not start until the settings describe an encrypted, authenticated
 * submission.
 */
export function assertOutboundMailConfigured(): void {
  const problems = outboundMailConfigProblems();
  if (!problems.length) return;
  throw new Error(
    `Outbound mail is not configured safely. ${problems.join(' ')} ${WHERE}`,
  );
}

// --- Outcome mapping ---

export type SmtpStage = 'connect' | 'auth' | 'envelope' | 'content';

export interface SmtpRefusedRecipient {
  address: string;
  /** Reply code and text, one line. */
  detail: string;
}

export type SmtpOutcome =
  | {
      kind: 'accepted';
      providerId: string;
      accepted: string[];
      refused: SmtpRefusedRecipient[];
    }
  | { kind: 'failed'; reason: string; retryable: boolean };

interface SmtpErrorLike {
  message?: string;
  code?: string;
  command?: string;
  response?: string;
  responseCode?: number;
  rejectedErrors?: Array<{
    recipient?: string;
    response?: string;
    responseCode?: number;
  }>;
}

function oneLine(value: string | undefined, max = 200): string {
  return (value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

function refusedFrom(err: SmtpErrorLike | undefined): SmtpRefusedRecipient[] {
  return (err?.rejectedErrors ?? [])
    .filter((r) => typeof r.recipient === 'string' && r.recipient)
    .map((r) => ({
      address: r.recipient as string,
      detail: oneLine(r.response) || 'refused',
    }));
}

/**
 * Map one failed SMTP exchange onto retryable or permanent. `stage` is how
 * far the session got; `content` means message content was written to the
 * server, after which a missing reply leaves the outcome unknown.
 */
export function classifySmtpError(
  err: SmtpErrorLike,
  stage: SmtpStage,
): { reason: string; retryable: boolean } {
  const refused = refusedFrom(err);
  if (refused.length) {
    // Every recipient was refused; nothing was sent. Retry only when at
    // least one refusal was temporary.
    const anyTemporary = (err.rejectedErrors ?? []).some(
      (r) => r.responseCode !== undefined && r.responseCode < 500,
    );
    return {
      reason: `smtp-all-recipients-refused: ${refused
        .map((r) => `${r.address} (${r.detail})`)
        .join('; ')}`,
      retryable: anyTemporary,
    };
  }

  const code = err.responseCode;
  // The session could not be encrypted (STARTTLS refused or not offered, a
  // failed handshake, a certificate that does not verify). Nothing was sent.
  const tlsFailure = err.code === 'ETLS' || err.command === 'STARTTLS';
  if (typeof code === 'number' && code >= 400 && code <= 599) {
    return {
      reason: `${tlsFailure ? 'smtp-tls-failed: STARTTLS refused:' : 'smtp-error:'} ${stage} ${
        oneLine(err.response) || code
      }`,
      retryable: code < 500,
    };
  }

  if (stage === 'content') {
    return {
      reason:
        'smtp-outcome-unknown: no reply after the message content was ' +
        `written (${err.code ?? 'no code'}); it may or may not have been ` +
        'delivered, and it is not retried',
      retryable: false,
    };
  }

  // No server reply. A local refusal to proceed (no usable AUTH mechanism,
  // an address the client cannot put in an envelope, an unencrypted session)
  // will not change on a retry; a network failure may.
  const local =
    err.command === 'API' ||
    err.code === 'EAUTH' ||
    err.code === 'EENVELOPE' ||
    err.code === 'EMESSAGE' ||
    err.code === 'ENOTENCRYPTED';
  return {
    reason:
      `smtp-${local ? 'refused-locally' : 'connection-failed'}: ${stage} ${
        err.code ?? 'error'
      } ${oneLine(err.message)}`.trim(),
    retryable: !local,
  };
}

// --- The wire ---

export interface SmtpMessage {
  deliveryId: string;
  fromName: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  replyTo: string;
  /** With angle brackets, as the HTTP provider is given it. */
  messageId: string;
  inReplyTo?: string;
  extraHeaders?: Record<string, string>;
}

/** Headers this module sets itself; a caller's extra header never wins. */
const RESERVED_HEADERS = new Set([
  'message-id',
  'in-reply-to',
  'references',
  'from',
  'sender',
  'to',
  'cc',
  'bcc',
  'subject',
  'reply-to',
  'date',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);

function bareAddress(value: string): string {
  const angle = value.match(/<([^<>]+)>\s*$/);
  return (angle ? angle[1] : value).trim();
}

let testTlsCa: string | undefined;

/**
 * @internal - for tests only. Trust one extra CA certificate, so a test can
 * run a local server with a certificate made for the test. It adds trust; it
 * cannot turn verification off.
 */
export function _setSmtpTlsCaForTests(ca: string | undefined): void {
  testTlsCa = ca;
}

/** The provider id recorded for an SMTP send: stable for one delivery id. */
export function smtpProviderId(deliveryId: string): string {
  return `smtp-${createHash('sha256').update(deliveryId).digest('hex').slice(0, 32)}`;
}

/** Build the message bytes. Exported for tests of the header contract. */
export async function buildSmtpMessage(message: SmtpMessage): Promise<Buffer> {
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.extraHeaders ?? {})) {
    if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
    if (!/^[A-Za-z0-9-]+$/.test(name)) continue;
    extra[name] = oneLine(String(value), 998);
  }
  const composer = new MailComposer({
    from: { name: oneLine(message.fromName), address: message.fromEmail },
    to: message.to.map(bareAddress),
    ...(message.cc.length ? { cc: message.cc.map(bareAddress) } : {}),
    subject: oneLine(message.subject, 998),
    text: message.text,
    replyTo: bareAddress(message.replyTo),
    messageId: message.messageId,
    ...(message.inReplyTo
      ? {
          inReplyTo: oneLine(message.inReplyTo),
          references: oneLine(message.inReplyTo),
        }
      : {}),
    headers: extra,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return composer.compile().build();
}

/**
 * Submit one message. Opens a connection, requires TLS, authenticates,
 * sends, closes. Never throws: every outcome is an SmtpOutcome. The whole
 * exchange is bounded by `deadlineMs`.
 */
export async function submitViaSmtp(
  config: SmtpConfig,
  message: SmtpMessage,
  deadlineMs: number,
): Promise<SmtpOutcome> {
  let raw: Buffer;
  try {
    raw = await buildSmtpMessage(message);
  } catch (err) {
    return {
      kind: 'failed',
      reason: `smtp-refused-locally: message could not be built: ${oneLine(
        err instanceof Error ? err.message : String(err),
      )}`,
      retryable: false,
    };
  }

  const envelope = {
    from: config.envelopeFrom ?? bareAddress(message.fromEmail),
    to: [...message.to, ...message.cc].map(bareAddress),
  };

  return new Promise<SmtpOutcome>((resolve) => {
    let stage: SmtpStage = 'connect';
    let settled = false;

    const connection = new SMTPConnection({
      host: config.host,
      port: config.port,
      // `tls`: TLS from the first byte. `starttls`: plain greeting, then the
      // upgrade is mandatory; the client fails instead of going on in clear.
      secure: config.security === 'tls',
      requireTLS: config.security === 'starttls',
      connectionTimeout: deadlineMs,
      greetingTimeout: deadlineMs,
      socketTimeout: deadlineMs,
      dnsTimeout: deadlineMs,
      tls: {
        minVersion: 'TLSv1.2',
        ...(testTlsCa ? { ca: testTlsCa } : {}),
      },
    });

    const finish = (outcome: SmtpOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        connection.close();
      } catch (err) {
        logger.debug({ err }, 'SMTP connection close failed');
      }
      resolve(outcome);
    };
    const fail = (err: unknown): void => {
      const classified = classifySmtpError((err ?? {}) as SmtpErrorLike, stage);
      finish({ kind: 'failed', ...classified });
    };

    const timer = setTimeout(
      () =>
        fail(
          Object.assign(new Error('provider-deadline-exceeded'), {
            code: 'ETIMEDOUT',
          }),
        ),
      deadlineMs,
    );

    connection.on('error', fail);
    connection.once('end', () =>
      fail(
        Object.assign(new Error('connection closed by the server'), {
          code: 'ECONNECTION',
        }),
      ),
    );

    connection.connect((connectErr?: unknown) => {
      if (settled) return;
      if (connectErr) return fail(connectErr);
      // Belt and braces: the library already fails a session it could not
      // encrypt. No credentials leave this process over a plain socket.
      if (!connection.secure) {
        return fail(
          Object.assign(new Error('session is not encrypted'), {
            code: 'ENOTENCRYPTED',
          }),
        );
      }
      stage = 'auth';
      connection.login(
        { user: config.username, pass: config.password },
        (authErr) => {
          if (settled) return;
          if (authErr) return fail(authErr);
          stage = 'envelope';
          // The library pipes the body only once the server has answered
          // DATA; from then on a lost reply means an unknown outcome.
          const body = new PassThrough();
          const pipe = body.pipe.bind(body);
          body.pipe = ((destination, options) => {
            stage = 'content';
            return pipe(destination, options);
          }) as typeof body.pipe;
          body.end(raw);
          connection.send(envelope, body, (sendErr, info) => {
            if (settled) return;
            if (sendErr) return fail(sendErr);
            const refused = refusedFrom(info as unknown as SmtpErrorLike);
            finish({
              kind: 'accepted',
              providerId: smtpProviderId(message.deliveryId),
              accepted: (info.accepted ?? []).map(String),
              refused,
            });
          });
        },
      );
    });
  });
}

/**
 * Durable record of recipients the server refused while it accepted the
 * message for others. Same entry type the events webhook writes for a
 * bounce, so one search finds both.
 */
export function logSmtpRefusedRecipients(args: {
  providerId: string;
  subject: string;
  refused: SmtpRefusedRecipient[];
}): void {
  if (!args.refused.length) return;
  try {
    logDeliveryProblem({
      type: 'smtp.recipient_refused',
      to: args.refused.map((r) => r.address).join(', '),
      subject: args.subject,
      resendId: args.providerId,
      reason: args.refused.map((r) => `${r.address}: ${r.detail}`).join('; '),
    });
  } catch (err) {
    logger.error(
      { err, providerId: args.providerId },
      'Could not write the audit entry for recipients refused over SMTP',
    );
  }
}
