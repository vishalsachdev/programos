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
 *   - `teams`: one POST of an Adaptive Card to a Microsoft Teams Workflows
 *     webhook (ADMIN_ALERT_TEAMS_WORKFLOW_URL, `.env` only). The URL is the
 *     credential: it is never logged. A delivered post writes an
 *     `[ADMIN ALERT TEAMS]` audit entry. Not verified against a live tenant;
 *     see docs/teams-alerts.md.
 *   - several: `telegram,email`, `email,teams`, ... (`both` means
 *     `telegram,email`). The alert counts as delivered when at least one
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
 *     never sent by mail again; it goes to Telegram or Teams if one of
 *     those routes is on, otherwise it is logged and dropped.
 *
 * Rules the Teams route keeps:
 *   - No recursion. A failed Teams post is logged and returned as a result;
 *     it raises no alert of its own, and an alert raised from inside a Teams
 *     post's own call chain is not posted to Teams again. Unrelated alerts
 *     that merely overlap in time are posted as usual.
 *   - One request, with a timeout; any status outside 2xx is a failure.
 *   - Size. The request body is kept under TEAMS_ALERT_MAX_BODY_BYTES; a
 *     longer alert is cut with a visible marker, never split into parts.
 */
import { AsyncLocalStorage } from 'async_hooks';
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
import { logAdminAlertTeams } from './audit-log.js';
import { logger } from './logger.js';
import {
  MAX_OUTBOX_ATTEMPTS,
  retryBackoffMs,
  sendOutboundEmailResult,
  type OutboundEmailResult,
} from './outbound-email.js';

export type AdminAlertRoute = 'telegram' | 'email' | 'teams';

const ROUTE_NAMES: readonly AdminAlertRoute[] = ['telegram', 'email', 'teams'];

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
    const route = ROUTE_NAMES.find((name) => name === part);
    if (!route) return { routes: ['telegram'], invalid: raw };
    if (!routes.includes(route)) routes.push(route);
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

// ---------------------------------------------------------------------------
// Teams route (Workflows webhook). NOT verified against a live Teams tenant.
// ---------------------------------------------------------------------------

/** The `.env` key holding the workflow's HTTP POST URL (a credential). */
export const TEAMS_WORKFLOW_URL_KEY = 'ADMIN_ALERT_TEAMS_WORKFLOW_URL';

/**
 * Teams refuses a message above about 28 KB ("If the message size exceeds
 * 28 KB, the action fails with the error 'Request Entity too large'",
 * https://learn.microsoft.com/en-us/connectors/teams/, known issues, read
 * 2026-11-20). That limit counts the rendered message, not this JSON, so the
 * request body is held well below it.
 */
export const TEAMS_ALERT_MAX_BODY_BYTES = 24_000;

/** One request; no answer within this is a (retryable) failure. */
export const TEAMS_ALERT_TIMEOUT_MS = 10_000;

/** The marker that ends a cut alert; `omitted` counts the characters left out. */
export function teamsTruncationMarker(omitted: number): string {
  return `[Cut to fit the Teams message size limit: ${omitted} characters left out.]`;
}

let teamsTimeoutMs = TEAMS_ALERT_TIMEOUT_MS;

/** @internal - for tests only. */
export function _setTeamsAlertTimeoutMsForTests(ms: number | undefined): void {
  teamsTimeoutMs = ms ?? TEAMS_ALERT_TIMEOUT_MS;
}

/**
 * The request body the Teams route posts. This is the ONE place to change if
 * your tenant's workflow template expects another body.
 *
 * Shape: the "Adaptive cards" request body example of the Teams connector's
 * "When a Teams webhook request is received" trigger,
 * https://learn.microsoft.com/en-us/connectors/teams/ (read 2026-11-20):
 * `type` "should always be 'message'", `contentUrl` "should always be null",
 * card version 1.2. The one addition is `wrap: true` on the text block (a
 * standard Adaptive Card TextBlock property), so a long line is not cut off
 * on screen. Plain text only: the page says not to use HTML in cards.
 */
export function buildTeamsAlertPayload(text: string): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.2',
          body: [{ type: 'TextBlock', text, wrap: true }],
        },
      },
    ],
  };
}

function teamsBodyBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(buildTeamsAlertPayload(text)));
}

/**
 * Fit the alert into one Teams message. A text that fits is returned as is.
 * A longer one is cut (on a character boundary) and ends with the marker, so
 * a reader can see that something is missing. It is never split into parts.
 */
export function fitTeamsAlertText(
  text: string,
  maxBodyBytes = TEAMS_ALERT_MAX_BODY_BYTES,
): { text: string; truncated: boolean } {
  if (teamsBodyBytes(text) <= maxBodyBytes) return { text, truncated: false };
  const chars = Array.from(text);
  const withMarker = (n: number) =>
    `${chars.slice(0, n).join('').trimEnd()}\n\n${teamsTruncationMarker(chars.length - n)}`;
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (teamsBodyBytes(withMarker(mid)) <= maxBodyBytes) lo = mid;
    else hi = mid - 1;
  }
  return { text: withMarker(lo), truncated: true };
}

/** The workflow URL from `.env`, or the reason it cannot be used. */
export function resolveTeamsWorkflowUrl(): { url?: string; problem?: string } {
  const raw = (
    readEnvFile([TEAMS_WORKFLOW_URL_KEY])[TEAMS_WORKFLOW_URL_KEY] ?? ''
  ).trim();
  if (!raw) return { problem: `${TEAMS_WORKFLOW_URL_KEY} is not set` };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { problem: `${TEAMS_WORKFLOW_URL_KEY} is not a valid URL` };
  }
  if (parsed.protocol !== 'https:') {
    return { problem: `${TEAMS_WORKFLOW_URL_KEY} must be an https:// URL` };
  }
  return { url: raw };
}

/**
 * Remove the workflow URL, and anything that looks like its signature, from
 * text bound for a log line or an error.
 */
export function redactTeamsUrl(value: string, url: string | undefined): string {
  let out = value;
  if (url) {
    out = out.split(url).join('[teams-workflow-url]');
    try {
      const parsed = new URL(url);
      for (const v of parsed.searchParams.values()) {
        if (v.length >= 8) out = out.split(v).join('[redacted]');
      }
      if (parsed.pathname.length > 1) {
        out = out.split(parsed.pathname).join('/[redacted]');
      }
    } catch {
      // resolveTeamsWorkflowUrl only hands out parseable URLs.
    }
  }
  return out.replace(/([?&]sig=)[^&\s"']+/gi, '$1[redacted]');
}

function describeError(err: unknown, url: string | undefined): string {
  if (err instanceof Error) {
    const cause =
      err.cause instanceof Error ? `; cause: ${err.cause.message}` : '';
    return redactTeamsUrl(`${err.name}: ${err.message}${cause}`, url);
  }
  return redactTeamsUrl(String(err), url);
}

/**
 * Set only inside the call chain of one Teams request (async context, not a
 * process-wide flag). An alert raised from inside that chain is the post
 * reporting on itself and is not posted to Teams; an unrelated alert that
 * happens to overlap in time is not in this context and is posted.
 */
const teamsPostContext = new AsyncLocalStorage<true>();

/** True when called from inside a Teams request's own call chain. */
export function isInsideTeamsPost(): boolean {
  return teamsPostContext.getStore() === true;
}

/**
 * Post one alert to the Teams workflow. Never throws; returns one of the
 * four results the other routes use. 2xx is success (the request trigger
 * answers 202 Accepted when the flow has no Response action,
 * https://learn.microsoft.com/en-us/azure/connectors/connectors-native-reqres,
 * read 2026-11-20). Success means the flow accepted the request; whether the
 * card then appeared in the channel is in the flow's run history.
 */
export async function sendAdminAlertTeams(
  text: string,
): Promise<AdminAlertResult> {
  const target = resolveTeamsWorkflowUrl();
  if (!target.url) {
    logger.error(
      { problem: target.problem },
      'Cannot post admin alert to Teams: workflow URL unusable',
    );
    return 'unconfigured';
  }
  const url = target.url;
  const fitted = fitTeamsAlertText(text);
  if (fitted.truncated) {
    logger.warn(
      { originalLength: text.length, postedLength: fitted.text.length },
      'Admin alert cut to fit the Teams message size limit',
    );
  }
  let response: Response;
  try {
    // Only the request runs in the context; the audit write below does not,
    // so a later alert from the audit commit is not mistaken for recursion.
    response = await teamsPostContext.run(true, () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildTeamsAlertPayload(fitted.text)),
        // A redirect would send the alert somewhere the operator did not set.
        redirect: 'manual',
        signal: AbortSignal.timeout(teamsTimeoutMs),
      }),
    );
  } catch (err) {
    logger.error(
      { error: describeError(err, url) },
      'Admin alert to Teams failed (no answer or timeout)',
    );
    return 'failed-transient';
  }
  // The body is not read: an error page could echo the request URL.
  void response.body?.cancel().catch(() => {});
  if (response.status < 200 || response.status > 299) {
    logger.error(
      { status: response.status },
      'Admin alert to Teams not accepted',
    );
    return response.status === 429 || response.status >= 500
      ? 'failed-transient'
      : 'failed-permanent';
  }
  logAdminAlertTeams({
    text: fitted.text,
    status: response.status,
    truncated: fitted.truncated,
  });
  return 'sent';
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
  if (routes.includes('teams')) {
    if (isInsideTeamsPost()) {
      logger.error(
        { text: text.slice(0, 500), routes },
        'Admin alert raised during a Teams post; not posted to Teams (no recursion)',
      );
    } else {
      pending.push(
        runRoute('teams', () => sendAdminAlertTeams(text)).then((r) => [
          'teams',
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
      `ADMIN_ALERT_ROUTE="${parsed.invalid}" is not valid (use telegram, email, teams, or several joined by commas, such as telegram,email); using telegram`,
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
  if (parsed.routes.includes('teams')) {
    const target = resolveTeamsWorkflowUrl();
    if (target.problem) {
      problems.push(
        `ADMIN_ALERT_ROUTE includes teams but ${target.problem}; operator alerts will not reach Teams`,
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

/** `teams` is present only when that route is on. */
export interface AdminAlertTestReport {
  telegram: AdminAlertResult | 'off';
  email: AdminAlertResult | 'off';
  teams?: AdminAlertResult;
}

/**
 * First-start check: one test alert on each enabled route, each reported on
 * its own (a working route must not hide a broken one).
 */
export async function sendTestAdminAlerts(opts: {
  telegram: (text: string) => Promise<AdminAlertResult>;
  now?: Date;
}): Promise<AdminAlertTestReport> {
  const routes = resolveAdminAlertRoutes();
  const stamp = (opts.now ?? new Date()).toISOString();
  const text = `Test alert from ${ASSISTANT_NAME} (${stamp}). Operator alerts on this route arrive like this one. No action is needed.`;
  const report: AdminAlertTestReport = { telegram: 'off', email: 'off' };
  if (routes.includes('telegram')) {
    report.telegram = await runRoute('telegram', () => opts.telegram(text));
  }
  if (routes.includes('email')) {
    report.email = await runRoute('email', () => sendAdminAlertEmail(text));
  }
  if (routes.includes('teams')) {
    report.teams = await runRoute('teams', () => sendAdminAlertTeams(text));
  }
  for (const route of routes) {
    const result = report[route] ?? 'off';
    if (result === 'sent') {
      logger.info({ route }, 'Admin alert test delivered');
    } else {
      logger.error({ route, result }, 'Admin alert test NOT delivered');
    }
  }
  return report;
}
