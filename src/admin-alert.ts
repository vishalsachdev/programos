/**
 * Operator (admin) alerts: one function that follows ADMIN_ALERT_ROUTE.
 *
 * Routes:
 *   - `telegram` (default): what each call site did before this module. The
 *     caller passes its own Telegram transport, so the default route is
 *     unchanged (direct Bot API ping from the webhook, the alert-JID channel
 *     send from the orchestrator).
 *   - `email`: one mail to the operator address (OPERATOR_CC_EMAIL) through
 *     the durable outbox and the delivery gate. The outbound path writes the
 *     `[OUTBOUND EMAIL]` audit entry (Source: admin-alert).
 *   - both: `telegram,email`. The alert counts as delivered when at least one
 *     route delivered it; a route that failed is logged.
 *
 * Rules the email route keeps:
 *   - Operator only. The send carries a one-address allowlist (the operator),
 *     so the outbound path itself refuses any other recipient. The operator
 *     address must not be the bot's own mailbox or a peer-agent inbox.
 *   - No loop. Alert mail carries RFC 3834 auto-generated headers, which the
 *     intake loop guard (email-loop-detection.ts) drops if the mail ever
 *     lands in the bot's own inbox.
 *   - No recursion. A failed alert mail raises a delivery shortfall, and a
 *     bounced one raises a bounce alert. An alert ABOUT an alert mail is
 *     never sent by mail again; it goes to Telegram if that route is on,
 *     otherwise it is logged and dropped.
 */
import { randomUUID } from 'crypto';

import { AGENT_INBOX_ADDRESSES, ASSISTANT_NAME, BOT_EMAIL } from './config.js';
import { extractAddresses } from './cc-context.js';
import {
  formatShortfallAlert,
  type DeliveryShortfallAlerter,
} from './delivery-gate.js';
import { emailAddressesInText } from './email-addresses.js';
import { stripMarkdown } from './email-format.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  MAX_OUTBOX_ATTEMPTS,
  retryBackoffMs,
  sendOutboundEmailResult,
  type OutboundEmailResult,
} from './outbound-email.js';

export type AdminAlertRoute = 'telegram' | 'email';

/** Same four states the webhook's Telegram ping has always returned. */
export type AdminAlertResult =
  | 'sent'
  | 'unconfigured'
  | 'failed-permanent'
  | 'failed-transient';

/**
 * `suppressed`: the alert concerns an alert mail and no other route is on.
 * It was logged, not sent, and must not be retried.
 */
export type AdminAlertOutcome = AdminAlertResult | 'suppressed';

/** `sourceGroup` on every alert mail: audit attribution and recursion key. */
export const ADMIN_ALERT_SOURCE_GROUP = 'admin-alert';

/**
 * RFC 3834 / de-facto markers. `Auto-Submitted: auto-generated` and
 * `Precedence: bulk` are both reject rules in email-loop-detection.ts, and
 * they also tell the operator's own autoresponder not to answer.
 */
export const ADMIN_ALERT_MAIL_HEADERS: Readonly<Record<string, string>> = {
  'Auto-Submitted': 'auto-generated',
  Precedence: 'bulk',
  'X-Auto-Response-Suppress': 'All',
};

const SUBJECT_MAX = 120;

/** Parse ADMIN_ALERT_ROUTE. Unset means `telegram` (the behaviour before). */
export function parseAdminAlertRoute(raw: string | undefined): {
  routes: AdminAlertRoute[];
  invalid?: string;
} {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return { routes: ['telegram'] };
  if (value === 'both') return { routes: ['telegram', 'email'] };
  const parts = value
    .split(/[,+\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const routes: AdminAlertRoute[] = [];
  for (const part of parts) {
    if (part !== 'telegram' && part !== 'email') {
      return { routes: ['telegram'], invalid: raw };
    }
    if (!routes.includes(part)) routes.push(part);
  }
  return routes.length ? { routes } : { routes: ['telegram'], invalid: raw };
}

function readSetting(key: string): string | undefined {
  return process.env[key] || readEnvFile([key])[key] || undefined;
}

export function resolveAdminAlertRoutes(): AdminAlertRoute[] {
  return parseAdminAlertRoute(readSetting('ADMIN_ALERT_ROUTE')).routes;
}

/**
 * The one address alert mail may go to. OPERATOR_CC_EMAIL is read from
 * `.env` only, as the outbound path reads it.
 */
export function resolveOperatorAlertAddress(): {
  address?: string;
  problem?: string;
} {
  const raw = readEnvFile(['OPERATOR_CC_EMAIL']).OPERATOR_CC_EMAIL;
  const addresses = [...new Set(extractAddresses(raw))];
  if (addresses.length === 0) {
    return { problem: 'OPERATOR_CC_EMAIL is not set' };
  }
  if (addresses.length > 1) {
    return { problem: 'OPERATOR_CC_EMAIL must hold exactly one address' };
  }
  const address = addresses[0];
  const botAddresses = new Set([
    BOT_EMAIL,
    (readEnvFile(['SEND_FROM_EMAIL']).SEND_FROM_EMAIL || '')
      .trim()
      .toLowerCase(),
  ]);
  if (botAddresses.has(address)) {
    return {
      problem:
        "OPERATOR_CC_EMAIL is the bot's own address; alert mail would loop",
    };
  }
  if (AGENT_INBOX_ADDRESSES.includes(address)) {
    return {
      problem:
        'OPERATOR_CC_EMAIL is a peer-agent inbox; alert mail must go to a person',
    };
  }
  return { address };
}

/** Subject marker of every alert mail. Also the recursion key in alert text. */
export function adminAlertSubjectPrefix(): string {
  return `[${ASSISTANT_NAME} alert]`;
}

function alertSubject(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? 'operator alert';
  return `${adminAlertSubjectPrefix()} ${firstLine}`.slice(0, SUBJECT_MAX);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when a host-built delivery report (bounce, complaint, unconfirmed
 * delivery) is about an alert mail: a `Subject:` line that starts with the
 * alert marker and a `To:` line that names the operator. Both must start a
 * line, so a marker inside someone's subject text does not match.
 */
export function isAboutAdminAlertMail(
  text: string,
  operatorAddress: string | undefined,
): boolean {
  const subjectLine = new RegExp(
    `^Subject: ${escapeRegex(adminAlertSubjectPrefix())}`,
    'm',
  );
  if (!subjectLine.test(text)) return false;
  if (!operatorAddress) return true;
  return new RegExp(`^To: .*${escapeRegex(operatorAddress)}`, 'im').test(text);
}

let retryWait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** @internal - for tests only. */
export function _setAdminAlertRetryWaitForTests(
  fn: ((ms: number) => Promise<void>) | undefined,
): void {
  retryWait = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/**
 * Send one alert mail to the operator and wait for its terminal outcome.
 * The outbox owns the retries: after a retryable failure this waits on the
 * SAME delivery id, so a caller that retries on `failed-transient` cannot
 * queue a second copy while the first is still retrying.
 */
export async function sendAdminAlertEmail(
  text: string,
): Promise<AdminAlertResult> {
  const operator = resolveOperatorAlertAddress();
  if (!operator.address) {
    logger.error(
      { problem: operator.problem },
      'Cannot send admin alert mail: operator address unusable',
    );
    return 'unconfigured';
  }
  const email = {
    to: operator.address,
    subject: alertSubject(text),
    body: text,
  };
  const opts = {
    sourceGroup: ADMIN_ALERT_SOURCE_GROUP,
    forceBotReplyTo: true,
    lane: 'alert' as const,
    deliveryId: `${ADMIN_ALERT_SOURCE_GROUP}-${randomUUID()}`,
    // Operator only: the outbound path's recipient check runs against this
    // list, and it is saved with the outbox row for a replay after restart.
    allowlistState: {
      available: true,
      senders: new Set([operator.address]),
      source: 'admin-alert: operator address only',
    },
    allowlistFallbackMode: 'closed' as const,
    // The alert text is a host report to the operator. Addresses it names
    // (a bounced recipient, a capped sender) are facts, not model output.
    trustedBodyAddresses: [
      ...new Set([
        ...emailAddressesInText(text),
        ...emailAddressesInText(stripMarkdown(text)),
      ]),
    ],
    extraHeaders: { ...ADMIN_ALERT_MAIL_HEADERS },
  };

  let result: OutboundEmailResult;
  try {
    result = await sendOutboundEmailResult(email, opts);
    for (
      let attempt = 1;
      attempt <= MAX_OUTBOX_ATTEMPTS &&
      result.status === 'failed' &&
      result.retryable &&
      result.reason !== 'outbox-deferred-restart';
      attempt += 1
    ) {
      await retryWait(retryBackoffMs(attempt));
      result = await sendOutboundEmailResult(email, opts);
    }
  } catch (err) {
    logger.error({ err }, 'Admin alert mail could not be queued');
    return 'failed-transient';
  }
  if (result.status === 'sent') return 'sent';
  logger.error(
    { reason: result.reason, retryable: result.retryable },
    'Admin alert mail not delivered',
  );
  return result.retryable ? 'failed-transient' : 'failed-permanent';
}

export interface AdminAlertOptions {
  /** The caller's Telegram transport (the behaviour before this module). */
  telegram: () => Promise<AdminAlertResult>;
  /**
   * Set by a caller that knows the alert concerns an alert mail (the
   * delivery-shortfall alerter, from the shortfall's sourceGroup).
   */
  aboutAlertMail?: boolean;
}

async function runRoute(
  route: AdminAlertRoute,
  send: () => Promise<AdminAlertResult>,
): Promise<AdminAlertResult> {
  try {
    return await send();
  } catch (err) {
    logger.error({ err, route }, 'Admin alert route threw');
    return 'failed-transient';
  }
}

const RESULT_ORDER: AdminAlertResult[] = [
  'sent',
  'failed-transient',
  'failed-permanent',
  'unconfigured',
];

/** Send one operator alert on every enabled route. Never throws. */
export async function dispatchAdminAlert(
  text: string,
  opts: AdminAlertOptions,
): Promise<AdminAlertOutcome> {
  const routes = resolveAdminAlertRoutes();
  // Default route: exactly the caller's Telegram send, nothing added.
  if (routes.length === 1 && routes[0] === 'telegram') {
    return runRoute('telegram', opts.telegram);
  }

  const pending: Promise<[AdminAlertRoute, AdminAlertResult]>[] = [];
  if (routes.includes('telegram')) {
    pending.push(
      runRoute('telegram', opts.telegram).then((r) => ['telegram', r]),
    );
  }
  if (routes.includes('email')) {
    const aboutAlertMail =
      opts.aboutAlertMail === true ||
      isAboutAdminAlertMail(text, resolveOperatorAlertAddress().address);
    if (aboutAlertMail) {
      logger.error(
        { text: text.slice(0, 500), routes },
        'Admin alert concerns an alert mail; not sent by mail again (no recursion)',
      );
    } else {
      pending.push(
        runRoute('email', () => sendAdminAlertEmail(text)).then((r) => [
          'email',
          r,
        ]),
      );
    }
  }
  if (pending.length === 0) return 'suppressed';

  const results = await Promise.all(pending);
  const best = RESULT_ORDER.find((candidate) =>
    results.some(([, result]) => result === candidate),
  )!;
  for (const [route, result] of results) {
    if (result !== 'sent') {
      logger.error(
        { route, result, deliveredElsewhere: best === 'sent' },
        'Admin alert not delivered on this route',
      );
    }
  }
  return best;
}

/**
 * For callers written against the Telegram ping's four states. A suppressed
 * alert reads as a permanent failure: not delivered, not worth a retry.
 */
export async function sendAdminAlert(
  text: string,
  opts: AdminAlertOptions,
): Promise<AdminAlertResult> {
  const outcome = await dispatchAdminAlert(text, opts);
  return outcome === 'suppressed' ? 'failed-permanent' : outcome;
}

export type ThrowingAdminAlerter = (
  text: string,
  opts?: { aboutAlertMail?: boolean },
) => Promise<void>;

/**
 * The orchestrator's alert sender (dead letters, gate refusals, delivery
 * shortfalls, unconfirmed deliveries). It THROWS when no route delivered:
 * the shortfall replay layer deletes a queued alert only on a resolved
 * promise, so a swallowed failure would drop the alert for good.
 *
 * `sendViaAlertChannel` is the Telegram route: the send to the alert JID,
 * which throws on failure. Its own error is rethrown when no route
 * delivered, so the default route fails exactly as before.
 *
 * A suppressed alert (about an alert mail, no other route) resolves: it is
 * logged, and a replay could only be suppressed again.
 */
export function createThrowingAdminAlerter(
  sendViaAlertChannel: (text: string) => Promise<void>,
): ThrowingAdminAlerter {
  return async (text, opts) => {
    let channelError: unknown;
    const outcome = await dispatchAdminAlert(text, {
      aboutAlertMail: opts?.aboutAlertMail,
      telegram: async () => {
        try {
          await sendViaAlertChannel(text);
          return 'sent';
        } catch (err) {
          channelError = err;
          return 'failed-transient';
        }
      },
    });
    if (outcome === 'sent' || outcome === 'suppressed') return;
    throw channelError instanceof Error
      ? channelError
      : new Error(`Admin alert not delivered: ${outcome}`);
  };
}

/**
 * The delivery-shortfall alerter. A shortfall of an alert mail is flagged so
 * it is never reported by mail again: without this, one alert mail that
 * cannot be sent would raise a shortfall alert, sent by mail, and so on.
 */
export function adminShortfallAlerter(
  alerter: ThrowingAdminAlerter,
): DeliveryShortfallAlerter {
  return (shortfall) =>
    alerter(formatShortfallAlert(shortfall), {
      aboutAlertMail: shortfall.sourceGroup === ADMIN_ALERT_SOURCE_GROUP,
    });
}

/**
 * Startup check. Logs one error for each setting an enabled route needs and
 * does not have, and returns the same messages.
 */
export function checkAdminAlertConfig(): string[] {
  const raw = readSetting('ADMIN_ALERT_ROUTE');
  const parsed = parseAdminAlertRoute(raw);
  const problems: string[] = [];
  if (parsed.invalid !== undefined) {
    problems.push(
      `ADMIN_ALERT_ROUTE="${parsed.invalid}" is not valid (use telegram, email, or telegram,email); using telegram`,
    );
  }
  if (parsed.routes.includes('email')) {
    const operator = resolveOperatorAlertAddress();
    if (operator.problem) {
      problems.push(
        `ADMIN_ALERT_ROUTE includes email but ${operator.problem}; operator alerts will not be mailed`,
      );
    }
  }
  if (parsed.routes.includes('telegram')) {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_CHAT_ID']) {
      if (!readSetting(key)) {
        problems.push(
          `ADMIN_ALERT_ROUTE includes telegram but ${key} is not set; operator alerts will not reach Telegram`,
        );
        break;
      }
    }
  }
  for (const problem of problems) {
    logger.error({ routes: parsed.routes }, `Admin alert setup: ${problem}`);
  }
  return problems;
}

/**
 * First-start check: one test alert on each enabled route, each reported on
 * its own (a working route must not hide a broken one).
 */
export async function sendTestAdminAlerts(opts: {
  telegram: (text: string) => Promise<AdminAlertResult>;
  now?: Date;
}): Promise<Record<AdminAlertRoute, AdminAlertResult | 'off'>> {
  const routes = resolveAdminAlertRoutes();
  const stamp = (opts.now ?? new Date()).toISOString();
  const text = `Test alert from ${ASSISTANT_NAME} (${stamp}). Operator alerts on this route arrive like this one. No action is needed.`;
  const report: Record<AdminAlertRoute, AdminAlertResult | 'off'> = {
    telegram: 'off',
    email: 'off',
  };
  if (routes.includes('telegram')) {
    report.telegram = await runRoute('telegram', () => opts.telegram(text));
  }
  if (routes.includes('email')) {
    report.email = await runRoute('email', () => sendAdminAlertEmail(text));
  }
  for (const route of routes) {
    const result = report[route];
    if (result === 'sent') {
      logger.info({ route }, 'Admin alert test delivered');
    } else {
      logger.error({ route, result }, 'Admin alert test NOT delivered');
    }
  }
  return report;
}
