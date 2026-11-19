/**
 * Outbound proactive email: allowlist-gated Resend send + audit logging.
 *
 * Extracted from the send_email IPC case so the HOST can also send — the
 * weekly outreach task composes its email batch as structured output and the
 * host validates and sends it after the run (see task-scheduler.ts). No
 * container ever holds a send capability: the group IPC dir, group logs, and
 * the per-group runner source cache are all shared/writable surfaces, and
 * every in-container grant scheme (shape
 * match, env token, HMAC per-send, group window, exclusivity check) leaks
 * through one of them.
 */
import { createHash, randomUUID } from 'crypto';

import { logOutboundEmail } from './audit-log.js';
import { AGENT_INBOX_ADDRESSES, DEFAULT_BOT_EMAIL } from './config.js';
import {
  gateDirectSend,
  gateFinalEmailBody,
  formatGateRefusal,
  reportDeliveryShortfall,
} from './delivery-gate.js';
import {
  canProcessEmailSender,
  loadEmailAllowlistFrom,
  loadEmailAllowlistFromAsync,
  type EmailAllowlistFallbackMode,
} from './channels/webhook-allowlist.js';
import { stripMarkdown } from './email-format.js';
import { readEnvFile } from './env.js';
import { addressesMissingFromLastSnapshot } from './allowlist-snapshot.js';
import { recordDeliveryNote } from './delivery-notes.js';
import { recordEmailSent } from './email-delivery-check.js';
import { logger } from './logger.js';
import { getRepoReader } from './repo-reader.js';
import {
  getOutboxStore,
  MemoryOutboxStore,
  setOutboxStore,
  type OutboxLane,
  type OutboxRow,
  type OutboxSendOptionsPayload,
  type OutboxStore,
} from './outbound-email-outbox.js';

// --- Staggered outbound send queue ---
//
// Simultaneous Resend sends produce simultaneous inbound replies/bounces that
// burst into the Cloudflare Email Routing destination and can be throttled
// with a 421 4.3.0 upstream error. A durable serial queue with per-lane tails,
// a bounded inter-send delay, a bounded provider deadline, and an outbox that
// survives restarts keeps the implementation simple and prevents the burst
// without losing the actual send result or misreporting it as a delivery
// shortfall.

/** Documented production range: 30,000–60,000 ms. Default 30 s. */
export const DEFAULT_OUTBOUND_EMAIL_STAGGER_MS = 30_000;
export const MIN_OUTBOUND_EMAIL_STAGGER_MS = 30_000;
export const MAX_OUTBOUND_EMAIL_STAGGER_MS = 60_000;

export const DEFAULT_OUTBOUND_EMAIL_PROVIDER_TIMEOUT_MS = 30_000;

const MAX_TRANSACTIONAL_QUEUE_DEPTH = 100;
const MAX_BULK_QUEUE_DEPTH = 25;
const MAX_TRANSACTIONAL_QUEUE_AGE_MS = 5 * 60 * 1000;
const MAX_BULK_QUEUE_AGE_MS = 45 * 60 * 1000;

const DEFAULT_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
const MIN_OUTBOX_RETENTION_MS = 5 * 60 * 1000;
const MAX_OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let outboxRetentionMsOverride: number | undefined;

/** @internal - for tests only. */
export function _setOutboxRetentionMsForTests(ms: number): void {
  outboxRetentionMsOverride = ms;
}

/** @internal - for tests only. */
export function _resetOutboxRetentionForTests(): void {
  outboxRetentionMsOverride = undefined;
}

/**
 * Finalized send attempts a single row gets before the queue stops retrying it
 * and dead-letters it (loudly, via the G46 shortfall alert). Without a budget a
 * row that fails retryably forever is re-claimed until it ages out, and the
 * owner only learns about it at the expiry deadline.
 */
export const MAX_OUTBOX_ATTEMPTS = 5;
const RETRY_BACKOFF_BASE_MS = 1_000;
const MAX_RETRY_BACKOFF_MS = 60_000;

/** Exponential backoff, capped, applied after a retryable provider failure. */
export function retryBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    MAX_RETRY_BACKOFF_MS,
    RETRY_BACKOFF_BASE_MS * Math.pow(2, exponent),
  );
}

let staggerMsOverride: number | undefined;
let providerTimeoutMsOverride: number | undefined;

function isDigitsOnly(value: string): boolean {
  return /^\d+$/.test(value);
}

export function getStaggerMs(): number {
  if (staggerMsOverride !== undefined) return staggerMsOverride;

  const raw =
    process.env.OUTBOUND_EMAIL_STAGGER_MS ||
    readEnvFile(['OUTBOUND_EMAIL_STAGGER_MS']).OUTBOUND_EMAIL_STAGGER_MS;
  if (!raw) return DEFAULT_OUTBOUND_EMAIL_STAGGER_MS;

  if (!isDigitsOnly(raw)) {
    logger.warn(
      {
        raw,
        min: MIN_OUTBOUND_EMAIL_STAGGER_MS,
        max: MAX_OUTBOUND_EMAIL_STAGGER_MS,
      },
      'Invalid OUTBOUND_EMAIL_STAGGER_MS (must be digits-only); using default',
    );
    return DEFAULT_OUTBOUND_EMAIL_STAGGER_MS;
  }

  const parsed = Number(raw);
  if (
    Number.isNaN(parsed) ||
    parsed < MIN_OUTBOUND_EMAIL_STAGGER_MS ||
    parsed > MAX_OUTBOUND_EMAIL_STAGGER_MS
  ) {
    logger.warn(
      {
        raw,
        min: MIN_OUTBOUND_EMAIL_STAGGER_MS,
        max: MAX_OUTBOUND_EMAIL_STAGGER_MS,
      },
      'OUTBOUND_EMAIL_STAGGER_MS out of documented production range; using default',
    );
    return DEFAULT_OUTBOUND_EMAIL_STAGGER_MS;
  }

  return parsed;
}

export function getProviderTimeoutMs(): number {
  return (
    providerTimeoutMsOverride ?? DEFAULT_OUTBOUND_EMAIL_PROVIDER_TIMEOUT_MS
  );
}

/** @internal - for tests only. */
export function _setStaggerMsForTests(ms: number): void {
  staggerMsOverride = ms;
}

/** @internal - for tests only. */
export function _setProviderTimeoutMsForTests(ms: number): void {
  providerTimeoutMsOverride = ms;
}

/** @internal - for tests only. */
export function _nextStaggerDelayMsForTests(): number {
  return nextStaggerDelayMs();
}

/** @internal - for tests only. */
export function _resetStaggerConfigForTests(): void {
  staggerMsOverride = undefined;
  providerTimeoutMsOverride = undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextStaggerDelayMs(): number {
  const base = getStaggerMs();
  if (base <= 0) return 0;
  // Small jitter (up to 20% of base, capped at 5s) to avoid lockstep bursts.
  const jitterMax = Math.min(5_000, Math.floor(base * 0.2));
  const jitter = Math.floor(Math.random() * (jitterMax + 1));
  return base + jitter;
}

export interface OutboundEmail {
  to: string;
  /** Comma-separated list allowed; each address is allowlist-checked. */
  cc?: string;
  subject: string;
  body: string;
  reply_to?: string;
}

export type { OutboxLane };

export interface SendOutboundEmailOptions {
  /** For logging/audit attribution. */
  sourceGroup: string;
  /**
   * Host-composed sends (outreach batch) always Reply-To the bot: an
   * injected prompt must not route stakeholder replies away from the
   * bot/audit loop.
   */
  forceBotReplyTo: boolean;
  /**
   * Thread this send as a reply: sets In-Reply-To/References to the given
   * RFC822 Message-ID. Used by the webhook reply path.
   */
  inReplyTo?: string;
  /**
   * Extra raw headers merged into the send (e.g. the RFC 3834
   * `Auto-Submitted: auto-replied` pair on the G17 courtesy reply, so the
   * recipient's autoresponder does not loop back at us). Message-ID and
   * threading headers win over collisions here.
   */
  extraHeaders?: Record<string, string>;
  /**
   * Narrow exemption from the To-recipient allowlist check, with a required
   * human-readable reason that is logged on EVERY use. The only legitimate
   * caller is the G17 courtesy reply, whose entire purpose is to answer a
   * non-allowlisted @example.edu sender once. Hard-bounded here regardless
   * of caller: exactly ONE To recipient (a comma-multiplexed To under an
   * exemption is an open relay), and CC recipients are still checked. Do not
   * add callers without a governance-registry row change.
   */
  toAllowlistExemption?: { reason: string };
  /**
   * Reuse the caller's turn snapshot. Standalone sends without one read
   * the pinned mirror asynchronously; no synchronous refresh occurs here.
   */
  allowlistState?: ReturnType<typeof loadEmailAllowlistFrom>;
  /**
   * Allowlist-unavailable behavior for the recipient checks. Defaults to
   * 'closed' (scheduled/proactive sends stay strict). The webhook reply path
   * passes its configured EMAIL_ALLOWLIST_FALLBACK_MODE so a reply to mail
   * that permissive mode ACCEPTED inbound is not refused at send time after
   * the agent already did the work.
   */
  allowlistFallbackMode?: EmailAllowlistFallbackMode;
  /** Host-owned inbound evidence for ordinary replies; never taken from IPC. */
  trustedBodyAddresses?: string[];
  /** Host-only upgrade marker derived from one saved item's missing field. */
  legacySavedDeliveryId?: string;
  /** Exact dropped-CC disclosure appended by the host after validating agent text. */
  hostAddedBodySuffix?: string;
  /**
   * Audit-only annotation (G58): the webhook reply path's summary of
   * thread-audience CCs it dropped BEFORE this call (already disclosed in
   * the reply body). Rendered on the [OUTBOUND EMAIL] record so the audit
   * log shows the full recipient decision, not just the survivors.
   */
  ccDroppedNote?: string;
  /** Defer conversational audit until provider acceptance is persisted. */
  deferAudit?: boolean;
  /** Queue lane. Bulk is reserved for the host-approved outreach batch. */
  lane?: OutboxLane;
  /** Durable batch identifier, used to compose a deterministic deliveryId. */
  batchId?: string;
  /** Position within a batch, stored for visibility and ordering. */
  position?: number;
  /** Caller-supplied delivery id. Required for sendOutboundEmailResult. */
  deliveryId?: string;
}

export type OutboundEmailResult =
  | { status: 'sent'; resendId: string }
  | { status: 'failed'; reason: string; retryable: boolean };

export function classifyResendFailure(
  status: number,
  code?: string,
): { retryable: boolean } {
  if (status === 409) {
    return { retryable: code === 'concurrent_idempotent_requests' };
  }
  return {
    retryable:
      status === 408 || status === 425 || status === 429 || status >= 500,
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export function computeIntendedRecipients(
  email: OutboundEmail,
  _opts?: SendOutboundEmailOptions,
): string[] {
  const intended = [
    ...(email.to
      ? email.to
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      : []),
    ...(email.cc
      ? email.cc
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean)
      : []),
  ];

  const resendEnv = readEnvFile(['OPERATOR_CC_EMAIL']);
  const operatorCc = resendEnv.OPERATOR_CC_EMAIL;
  if (
    operatorCc &&
    intended.some((a) => AGENT_INBOX_ADDRESSES.includes(a.toLowerCase())) &&
    !intended.some((a) => a.toLowerCase() === operatorCc.toLowerCase())
  ) {
    intended.push(operatorCc);
  }

  return intended;
}

function toOutboxSendOptionsPayload(
  opts: SendOutboundEmailOptions,
): OutboxSendOptionsPayload {
  const { allowlistState, deliveryId, legacySavedDeliveryId, ...rest } = opts;
  return {
    ...rest,
    ...(!legacySavedDeliveryId
      ? { trustedBodyAddresses: opts.trustedBodyAddresses ?? [] }
      : {}),
    ...(allowlistState
      ? {
          allowlistState: {
            available: allowlistState.available,
            senders: [...allowlistState.senders],
            source: allowlistState.source,
          },
        }
      : {}),
  };
}

function fromOutboxSendOptionsPayload(
  stored: OutboxSendOptionsPayload,
  deliveryId: string,
): SendOutboundEmailOptions & { deliveryId: string } {
  const { allowlistState, ...rest } = stored;
  return {
    ...rest,
    deliveryId,
    ...(!Object.hasOwn(stored, 'trustedBodyAddresses')
      ? { legacySavedDeliveryId: deliveryId }
      : {}),
    ...(allowlistState
      ? {
          allowlistState: {
            ...allowlistState,
            senders: new Set(allowlistState.senders),
          },
        }
      : {}),
  } as SendOutboundEmailOptions & { deliveryId: string };
}

function toOutboxEmailPayload(email: OutboundEmail): OutboxRow['email'] {
  return { ...email };
}

function createOutboxRow(
  deliveryId: string,
  lane: OutboxLane,
  email: OutboundEmail,
  opts: SendOutboundEmailOptions,
): OutboxRow {
  return {
    deliveryId,
    lane,
    batchId: opts.batchId,
    position: opts.position,
    status: 'pending',
    email: toOutboxEmailPayload(email),
    sendOptions: toOutboxSendOptionsPayload(opts),
    intended: computeIntendedRecipients(email, opts),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function nowMs(): number {
  return Date.now();
}

function getMaxQueueAgeMs(lane: OutboxLane): number {
  return lane === 'bulk'
    ? MAX_BULK_QUEUE_AGE_MS
    : MAX_TRANSACTIONAL_QUEUE_AGE_MS;
}

function getMaxStaggerDelayMs(): number {
  const base = getStaggerMs();
  if (base <= 0) return 0;
  const jitterMax = Math.min(5_000, Math.floor(base * 0.2));
  return base + jitterMax;
}

function getMaxAcceptableDepth(lane: OutboxLane): number {
  const hard =
    lane === 'bulk' ? MAX_BULK_QUEUE_DEPTH : MAX_TRANSACTIONAL_QUEUE_DEPTH;
  const slotMs = getMaxStaggerDelayMs() + getProviderTimeoutMs();
  if (slotMs <= 0) return hard;
  const ageCap = Math.floor(getMaxQueueAgeMs(lane) / slotMs);
  return Math.max(1, Math.min(hard, ageCap));
}

/**
 * Retention for terminal outbox rows. Documented production range: 5 minutes
 * to 30 days, default 24 h. Anything outside it (or non-numeric) falls back to
 * the default with a warning — an unbounded value is how a "retention window"
 * silently becomes no retention at all.
 */
export function getOutboxRetentionMs(): number {
  if (outboxRetentionMsOverride !== undefined) return outboxRetentionMsOverride;

  const raw = process.env.OUTBOUND_EMAIL_OUTBOX_RETENTION_MS;
  if (!raw) return DEFAULT_OUTBOX_RETENTION_MS;

  const valid =
    /^\d+$/.test(raw) &&
    Number(raw) >= MIN_OUTBOX_RETENTION_MS &&
    Number(raw) <= MAX_OUTBOX_RETENTION_MS;
  if (!valid) {
    logger.warn(
      {
        raw,
        min: MIN_OUTBOX_RETENTION_MS,
        max: MAX_OUTBOX_RETENTION_MS,
      },
      'OUTBOUND_EMAIL_OUTBOX_RETENTION_MS invalid or out of range; using default',
    );
    return DEFAULT_OUTBOX_RETENTION_MS;
  }
  return Number(raw);
}

/**
 * Compaction cadence. Startup-only compaction leaves a long-lived process
 * growing without bound (round-3 review P2), so the lane compacts
 * opportunistically as it works.
 */
function compactionIntervalMs(): number {
  return Math.min(getOutboxRetentionMs(), 60 * 60 * 1000);
}

let lastCompactionAt = 0;

function maybeCompact(outbox: OutboxStore): void {
  const now = nowMs();
  if (now - lastCompactionAt < compactionIntervalMs()) return;
  lastCompactionAt = now;
  try {
    const removed = outbox.compact(getOutboxRetentionMs(), now);
    if (removed > 0) {
      logger.debug(
        { removed },
        'Compacted terminal outbound email outbox rows',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Outbound email outbox compaction failed');
  }
}

async function executeSendOutboundEmailResult(
  email: OutboundEmail,
  opts: SendOutboundEmailOptions & { deliveryId: string },
): Promise<OutboundEmailResult> {
  // G46 delivery completeness: every intended recipient either receives the
  // send or the shortfall is reported loudly (log + owner alert naming the
  // missed recipients) — never silent partial success.
  const intended = computeIntendedRecipients(email, opts);
  const shortfall = (missed: string[], sent: string[], reason: string) =>
    reportDeliveryShortfall({
      channel: 'email',
      context: `${opts.sourceGroup}: ${email.subject || '(no subject)'}`,
      intended,
      sent,
      missed,
      reason,
      sourceGroup: opts.sourceGroup,
    });
  // RC-018: terminal outcomes are recorded for the requesting agent's next
  // run. Only call at terminal points (sent, non-retryable refusal).
  const note = (sent: string[], missed: string[], reason: string) =>
    recordDeliveryNote({
      deliveryId: opts.deliveryId,
      sourceGroup: opts.sourceGroup,
      context: email.subject || '(no subject)',
      sent,
      missed,
      reason,
    });

  if (!email.to || !email.subject || !email.body) {
    logger.warn(
      {
        sourceGroup: opts.sourceGroup,
        to: email.to,
        subject: !!email.subject,
        body: !!email.body,
      },
      'send_email missing required fields',
    );
    note([], intended, 'missing-required-fields');
    return {
      status: 'failed',
      reason: 'missing-required-fields',
      retryable: false,
    };
  }

  const resendEnv = readEnvFile([
    'RESEND_API_KEY',
    'SEND_FROM_NAME',
    'SEND_FROM_EMAIL',
    'OPERATOR_CC_EMAIL',
  ]);

  if (!resendEnv.RESEND_API_KEY) {
    logger.warn('send_email: RESEND_API_KEY not set, skipping');
    shortfall(intended, [], 'resend-api-key-missing');
    note([], intended, 'resend-api-key-missing');
    return {
      status: 'failed',
      reason: 'resend-api-key-missing',
      retryable: false,
    };
  }

  // Retain a caller's turn snapshot; standalone sends read the pinned mirror
  // asynchronously so policy reads cannot stall other deliveries or intake.
  const allowlistState =
    opts.allowlistState ?? (await loadEmailAllowlistFromAsync(getRepoReader()));

  const bodyContext = {
    allowlist: allowlistState,
    trustedBodyAddresses: opts.trustedBodyAddresses,
    sendFromEmail: resendEnv.SEND_FROM_EMAIL || DEFAULT_BOT_EMAIL,
    legacySavedDeliveryId: Object.hasOwn(opts, 'trustedBodyAddresses')
      ? undefined
      : opts.legacySavedDeliveryId,
    hostAddedBodySuffix: opts.hostAddedBodySuffix,
  };
  const refuseBody = (bodyGate: {
    reason: string;
    addresses?: string[];
  }): OutboundEmailResult => {
    logger.error(
      {
        sourceGroup: opts.sourceGroup,
        to: email.to,
        subject: email.subject,
        reason: formatGateRefusal(bodyGate),
        sample: email.body.slice(0, 160),
      },
      'send_email: body refused by delivery gate (G46)',
    );
    shortfall(
      intended,
      [],
      `body-refused-by-delivery-gate: ${formatGateRefusal(bodyGate)}`,
    );
    note(
      [],
      intended,
      `body-refused-by-delivery-gate: ${formatGateRefusal(bodyGate)}`,
    );
    return {
      status: 'failed',
      reason: `body-refused-by-delivery-gate: ${formatGateRefusal(bodyGate)}`,
      retryable: false,
    };
  };
  const bodyGate = gateDirectSend(email.body, bodyContext);
  if (!bodyGate.ok) return refuseBody(bodyGate);
  const gatedBody = bodyGate.text;

  const toList = email.to
    .split(',')
    .map((addr) => addr.trim())
    .filter(Boolean);

  if (toList.length === 0) {
    logger.warn({ to: email.to }, 'send_email: no valid To address');
    shortfall(intended, [], 'no-valid-to-address');
    note([], intended, 'no-valid-to-address');
    return {
      status: 'failed',
      reason: 'no-valid-to-address',
      retryable: false,
    };
  }

  if (opts.toAllowlistExemption) {
    if (toList.length !== 1) {
      logger.error(
        { to: email.to, reason: opts.toAllowlistExemption.reason },
        'send_email: exemption refused — exactly one To recipient required',
      );
      shortfall(intended, [], 'exemption-requires-single-recipient');
      return {
        status: 'failed',
        reason: 'exemption-requires-single-recipient',
        retryable: false,
      };
    }
    logger.info(
      { to: email.to, reason: opts.toAllowlistExemption.reason },
      'send_email: To-allowlist exemption in use',
    );
  } else {
    const fallbackMode = opts.allowlistFallbackMode ?? 'closed';
    const rejectedTo = toList.find(
      (addr) =>
        !canProcessEmailSender(addr, allowlistState, fallbackMode).allowed,
    );
    if (rejectedTo) {
      logger.warn(
        { to: email.to, rejected: rejectedTo },
        'send_email recipient rejected by allowlist',
      );
      shortfall(intended, [], `to-recipient-not-allowlisted: ${rejectedTo}`);
      note([], intended, `to-recipient-not-allowlisted: ${rejectedTo}`);
      return {
        status: 'failed',
        reason: `to-recipient-not-allowlisted: ${rejectedTo}`,
        retryable: false,
      };
    }
  }

  const ccCandidates = email.cc
    ? email.cc
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean)
    : [];
  const ccList: string[] = [];
  const ccRejected: { addr: string; reason: string }[] = [];
  for (const ccAddr of ccCandidates) {
    const ccAccess = canProcessEmailSender(
      ccAddr,
      allowlistState,
      opts.allowlistFallbackMode ?? 'closed',
    );
    if (ccAccess.allowed) {
      ccList.push(ccAddr);
    } else {
      logger.warn(
        { cc: ccAddr, reason: ccAccess.reason },
        'send_email: CC recipient rejected by allowlist; dropping this CC',
      );
      ccRejected.push({ addr: ccAddr, reason: ccAccess.reason ?? 'rejected' });
    }
  }
  if (ccRejected.length) {
    shortfall(
      ccRejected.map((r) => r.addr),
      [...toList, ...ccList],
      `cc-recipient-not-allowlisted: ${ccRejected
        .map((r) => `${r.addr} (${r.reason})`)
        .join('; ')}`,
    );
  }

  const operatorCc = resendEnv.OPERATOR_CC_EMAIL;
  if (toList.some((a) => AGENT_INBOX_ADDRESSES.includes(a.toLowerCase()))) {
    if (!operatorCc) {
      logger.warn(
        { to: email.to },
        'send_email: PeerAgent recipient but OPERATOR_CC_EMAIL unset; cannot auto-CC',
      );
    } else if (
      ![...toList, ...ccList].some(
        (a) => a.toLowerCase() === operatorCc.toLowerCase(),
      )
    ) {
      ccList.push(operatorCc);
      logger.info(
        { to: email.to, autoCc: operatorCc },
        'send_email: auto-CC Avery on PeerAgent-bound email',
      );
    }
  }

  const botEmail = resendEnv.SEND_FROM_EMAIL || DEFAULT_BOT_EMAIL;
  const replyTo = opts.forceBotReplyTo ? botEmail : email.reply_to || botEmail;
  const messageIdToken = createHash('sha256')
    .update(opts.deliveryId)
    .digest('hex')
    .slice(0, 32);
  const msgId = `<outreach-${messageIdToken}@example.org>`;
  const plainText = stripMarkdown(gatedBody);

  const providerDeadlineMs = getProviderTimeoutMs();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  // Every entry path (reply, restored prepared delivery, outbox, IPC and
  // scheduler) converges here. No body mutation may follow this check.
  const finalBodyGate = gateFinalEmailBody(plainText, bodyContext);
  if (!finalBodyGate.ok) return refuseBody(finalBodyGate);

  const fetchPromise = fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendEnv.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': opts.deliveryId,
    },
    body: JSON.stringify({
      from: `${resendEnv.SEND_FROM_NAME || 'Coordinator'} <${botEmail}>`,
      to: toList,
      ...(ccList.length ? { cc: ccList } : {}),
      subject: email.subject,
      text: plainText,
      reply_to: replyTo,
      headers: {
        ...(opts.extraHeaders ?? {}),
        'Message-ID': msgId,
        ...(opts.inReplyTo
          ? {
              'In-Reply-To': opts.inReplyTo,
              References: opts.inReplyTo,
            }
          : {}),
      },
    }),
    signal: controller.signal,
  });

  const deadlinePromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('provider-deadline-exceeded'));
    }, providerDeadlineMs);
  });

  try {
    const resp = (await Promise.race([fetchPromise, deadlinePromise])) as {
      ok: boolean;
      status: number;
      text: () => Promise<string>;
      json: () => Promise<unknown>;
    };

    if (!resp.ok) {
      const err = await resp.text();
      let code: string | undefined;
      try {
        const parsed = JSON.parse(err) as { name?: unknown; code?: unknown };
        const candidate = parsed.name ?? parsed.code;
        if (typeof candidate === 'string') code = candidate;
      } catch {
        // Non-JSON Resend/proxy error; status classification still applies.
      }
      logger.error(
        { status: resp.status, err, to: email.to, subject: email.subject },
        'send_email Resend API error',
      );
      shortfall(intended, [], `resend-api-error: HTTP ${resp.status}`);
      const codePart = code ? ` ${code}` : '';
      const retryable = classifyResendFailure(resp.status, code).retryable;
      if (!retryable) {
        note([], intended, `resend-api-error: HTTP ${resp.status}${codePart}`);
      }
      return {
        status: 'failed',
        reason: `resend-api-error: HTTP ${resp.status}${codePart}`,
        retryable,
      };
    }

    const body = (await resp.json()) as { id?: unknown } | null;
    const resendId = typeof body?.id === 'string' ? body.id.trim() : '';
    if (!resendId) {
      // A 2xx without an email id is not proof of acceptance. Retry through
      // the bounded path; the idempotency key prevents a duplicate send.
      logger.error(
        { status: resp.status, body, to: email.to, subject: email.subject },
        'send_email: Resend success response without an email id',
      );
      shortfall(intended, [], 'resend-malformed-success: missing id');
      return {
        status: 'failed',
        reason: 'resend-malformed-success: missing id',
        retryable: true,
      };
    }
    const result = { id: resendId };
    const ccLogged = ccList.length ? ccList.join(', ') : undefined;
    logger.info(
      {
        to: email.to,
        cc: ccLogged,
        subject: email.subject,
        emailId: result.id,
        msgId,
        sourceGroup: opts.sourceGroup,
      },
      'Proactive email sent via Resend',
    );
    recordEmailSent({
      resendId: result.id,
      recipients: [...toList, ...ccList],
      subject: email.subject,
    });
    if (!opts.deferAudit) {
      logOutboundEmail({
        deliveryId: opts.deliveryId,
        to: email.to,
        cc: ccLogged,
        ...(opts.ccDroppedNote ? { ccDropped: opts.ccDroppedNote } : {}),
        subject: email.subject,
        sourceGroup: opts.sourceGroup,
        resendId: result.id,
        body: plainText,
      });
    }
    // The container's precheck judged from the snapshot written at its start;
    // if the allowlist advanced since, its "not sent" warning is now wrong —
    // record the real outcome so the next run corrects it.
    const newlyAllowed = addressesMissingFromLastSnapshot([
      ...toList,
      ...ccList,
    ]);
    if (newlyAllowed.length && !ccRejected.length) {
      note(
        [...toList, ...ccList],
        [],
        `allowlist-updated-since-session-start: ${newlyAllowed.join(', ')}`,
      );
    }
    if (ccRejected.length) {
      note(
        [...toList, ...ccList],
        ccRejected.map((r) => r.addr),
        `cc-recipient-not-allowlisted: ${ccRejected
          .map((r) => `${r.addr} (${r.reason})`)
          .join('; ')}`,
      );
    }
    return { status: 'sent', resendId: result.id };
  } catch (err) {
    logger.error(
      { err, to: email.to, subject: email.subject },
      'send_email failed',
    );
    const reason = isAbortError(err)
      ? 'provider-deadline-exceeded'
      : err instanceof Error
        ? err.message
        : String(err);
    shortfall(intended, [], `send-exception: ${reason}`);
    return {
      status: 'failed',
      reason: `send-exception: ${reason}`,
      retryable: true,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
    fetchPromise.catch(() => {});
    deadlinePromise.catch(() => {});
  }
}

// --- Durable per-lane queue ---

interface LaneQueue {
  tail: Promise<void>;
  inFlight: Set<string>;
  activeId?: string;
  activeDone?: { promise: Promise<void>; resolve: () => void };
}

const lanes = new Map<OutboxLane, LaneQueue>();
const waiters = new Map<
  string,
  Array<{ resolve: (r: OutboundEmailResult) => void }>
>();
let queueStarted = false;
let shuttingDown = false;

function getLane(lane: OutboxLane): LaneQueue {
  let queue = lanes.get(lane);
  if (!queue) {
    queue = { tail: Promise.resolve(), inFlight: new Set() };
    lanes.set(lane, queue);
  }
  return queue;
}

function resolveWaiters(deliveryId: string, result: OutboundEmailResult): void {
  const list = waiters.get(deliveryId);
  if (!list) return;
  waiters.delete(deliveryId);
  for (const w of list) w.resolve(result);
}

function addWaiter(deliveryId: string): Promise<OutboundEmailResult> {
  let list = waiters.get(deliveryId);
  if (!list) {
    list = [];
    waiters.set(deliveryId, list);
  }
  return new Promise<OutboundEmailResult>((resolve) => {
    list!.push({ resolve });
  });
}

function maxAgeExceeded(row: OutboxRow): boolean {
  const age = nowMs() - Date.parse(row.createdAt);
  return age > getMaxQueueAgeMs(row.lane);
}

/**
 * RC-018: recipients of a dead-lettered row, split by what the host can
 * vouch for. A CC the allowlist rejects was never in any provider request,
 * so it is categorically NOT sent; the rest are unconfirmed once an attempt
 * reached the provider, and NOT sent when none did.
 */
export function partitionDeadLetterRecipients(
  email: { to: string; cc?: string },
  intended: string[],
  attempts: number,
  allowlistState: ReturnType<typeof loadEmailAllowlistFrom>,
  fallbackMode: EmailAllowlistFallbackMode = 'closed',
): { missed: string[]; unknown: string[] } {
  const ccCandidates = (email.cc ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
  const rejectedCc = new Set(
    ccCandidates.filter(
      (a) => !canProcessEmailSender(a, allowlistState, fallbackMode).allowed,
    ),
  );
  const missed = intended.filter((a) => rejectedCc.has(a));
  const rest = intended.filter((a) => !rejectedCc.has(a));
  return attempts > 0
    ? { missed, unknown: rest }
    : {
        missed: [...missed, ...rest].sort(
          (a, b) => intended.indexOf(a) - intended.indexOf(b),
        ),
        unknown: [],
      };
}

async function deadLetterRow(
  outbox: OutboxStore,
  row: OutboxRow,
  reason: string,
): Promise<OutboundEmailResult> {
  const result: OutboundEmailResult = {
    status: 'failed',
    reason,
    retryable: false,
  };
  const finalized = outbox.finalize(row.deliveryId, result, nowMs());
  if (!finalized) {
    // Defensive fallback if the row was not in 'claimed'.
    row.status = 'dead-letter';
    row.result = result;
    row.updatedAt = new Date().toISOString();
    row.terminalAt = row.updatedAt;
    outbox.set(row);
  }
  reportDeliveryShortfall({
    channel: 'email',
    context: `${row.sendOptions.sourceGroup}: ${row.email.subject || '(no subject)'}`,
    intended: row.intended,
    sent: [],
    missed: row.intended,
    reason,
    sourceGroup: row.sendOptions.sourceGroup,
  });
  // An attempt that reached the provider may have been accepted before the
  // response was lost; only a row that never attempted is categorically
  // NOT sent.
  // Classify against the SEND-TIME allowlist when the row carries it (webhook
  // replies freeze it), so a retry window's allowlist edits do not rewrite
  // history; fall back to the mirror only for rows without one.
  let deadLetterAllowlist: ReturnType<typeof loadEmailAllowlistFrom>;
  const frozen = row.sendOptions.allowlistState;
  try {
    deadLetterAllowlist = frozen
      ? {
          available: frozen.available,
          senders: new Set(frozen.senders),
          source: frozen.source,
        }
      : await loadEmailAllowlistFromAsync(getRepoReader());
  } catch (err) {
    // No mirror (fresh process, tests): treat nothing as rejected rather
    // than strand the row; the note then reports all as unconfirmed.
    logger.warn({ err }, 'dead-letter note: allowlist unavailable');
    deadLetterAllowlist = {
      available: false,
      senders: new Set(),
      source: 'program/EMAIL_ALLOWLIST.md',
    };
  }
  const split = partitionDeadLetterRecipients(
    row.email,
    row.intended,
    row.attempts ?? 0,
    deadLetterAllowlist,
    deadLetterAllowlist.available
      ? (row.sendOptions.allowlistFallbackMode ?? 'closed')
      : 'permissive',
  );
  recordDeliveryNote({
    deliveryId: row.deliveryId,
    sourceGroup: row.sendOptions.sourceGroup,
    context: row.email.subject || '(no subject)',
    sent: [],
    missed: split.missed,
    unknown: split.unknown,
    reason,
  });
  resolveWaiters(row.deliveryId, result);
  return result;
}

function rowTerminalResult(row: OutboxRow): OutboundEmailResult | undefined {
  if (row.status === 'sent' && row.result) return row.result;
  if (row.status === 'dead-letter' && row.result) return row.result;
  if (
    row.status === 'failed' &&
    row.result?.status === 'failed' &&
    !row.result.retryable
  ) {
    return row.result;
  }
  return undefined;
}

async function processRow(
  outbox: OutboxStore,
  row: OutboxRow,
): Promise<OutboundEmailResult | undefined> {
  const laneQueue = getLane(row.lane);
  laneQueue.activeId = row.deliveryId;
  let activeResolve!: () => void;
  laneQueue.activeDone = {
    promise: new Promise<void>((r) => {
      activeResolve = r;
    }),
    resolve: activeResolve,
  };

  try {
    const current = outbox.get(row.deliveryId) ?? row;

    if (!current) {
      const missing: OutboundEmailResult = {
        status: 'failed',
        reason: 'outbox-row-missing',
        retryable: false,
      };
      resolveWaiters(row.deliveryId, missing);
      return missing;
    }

    const terminal = rowTerminalResult(current);
    if (terminal) {
      resolveWaiters(current.deliveryId, terminal);
      return terminal;
    }

    if (maxAgeExceeded(current)) {
      return await deadLetterRow(outbox, current, 'outbox-item-expired');
    }

    if (
      current.status === 'pending' ||
      (current.status === 'failed' &&
        current.result?.status === 'failed' &&
        current.result.retryable)
    ) {
      const leaseMs = getProviderTimeoutMs() + getMaxStaggerDelayMs() + 120_000;
      current.status = 'claimed';
      current.claimPid = process.pid;
      current.claimExpiresAt = new Date(nowMs() + leaseMs).toISOString();
      current.updatedAt = new Date().toISOString();
      outbox.set(current);
    } else if (current.status !== 'claimed') {
      const unexpected: OutboundEmailResult = {
        status: 'failed',
        reason: 'outbox-unexpected-status',
        retryable: false,
      };
      resolveWaiters(current.deliveryId, unexpected);
      return unexpected;
    }

    const sendOpts = fromOutboxSendOptionsPayload(
      current.sendOptions,
      current.deliveryId,
    );
    const result = await executeSendOutboundEmailResult(
      current.email,
      sendOpts,
    );

    // A retryable failure is only retryable while budget remains: past it the
    // row becomes a genuine permanent failure the owner is told about, rather
    // than an item that silently churns until it ages out.
    const attempts = (current.attempts ?? 0) + 1;
    if (result.status === 'failed' && result.retryable) {
      if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        return await deadLetterRow(
          outbox,
          current,
          `outbox-max-attempts-exceeded: ${result.reason}`,
        );
      }
      const finalizedRetry = outbox.finalize(
        current.deliveryId,
        result,
        nowMs(),
        nowMs() + retryBackoffMs(attempts),
      );
      if (!finalizedRetry) {
        logger.error(
          { deliveryId: current.deliveryId },
          'Could not finalize retryable outbox row (no longer claimed)',
        );
      }
      resolveWaiters(current.deliveryId, result);
      return result;
    }

    const finalized = outbox.finalize(current.deliveryId, result, nowMs());
    if (!finalized) {
      logger.error(
        { deliveryId: current.deliveryId },
        'Could not finalize outbox row (no longer claimed) — treating as retryable failure',
      );
    }
    resolveWaiters(current.deliveryId, result);
    return result;
  } catch (err) {
    logger.error(
      { err, deliveryId: row.deliveryId },
      'Unexpected outbound email queue processing error',
    );
    const result: OutboundEmailResult = {
      status: 'failed',
      reason: `send-queue-exception: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
    outbox.finalize(row.deliveryId, result, nowMs());
    resolveWaiters(row.deliveryId, result);
    return result;
  } finally {
    laneQueue.activeId = undefined;
    laneQueue.activeDone?.resolve();
    laneQueue.activeDone = undefined;
  }
}

function enqueue(outbox: OutboxStore, row: OutboxRow): void {
  const laneQueue = getLane(row.lane);
  if (laneQueue.inFlight.has(row.deliveryId)) return;
  laneQueue.inFlight.add(row.deliveryId);

  const lane = row.lane;

  laneQueue.tail = laneQueue.tail
    .then(async () => {
      if (shuttingDown) return;
      try {
        const current = outbox.get(row.deliveryId);
        if (!current) {
          const missing: OutboundEmailResult = {
            status: 'failed',
            reason: 'outbox-row-missing',
            retryable: false,
          };
          resolveWaiters(row.deliveryId, missing);
          return;
        }

        const terminal = rowTerminalResult(current);
        if (terminal) {
          resolveWaiters(current.deliveryId, terminal);
          return;
        }

        const result = await processRow(outbox, current);
        if (!result) return;

        // Expired rows are dead-lettered without staggering; otherwise sleep.
        const skipStagger =
          result.status === 'failed' && result.reason === 'outbox-item-expired';
        if (!skipStagger) {
          const delay = nextStaggerDelayMs();
          if (delay > 0) await sleep(delay);
        }
      } catch (err) {
        logger.error(
          { err, deliveryId: row.deliveryId },
          'Unexpected outbound email enqueue error',
        );
        const result: OutboundEmailResult = {
          status: 'failed',
          reason: `send-queue-exception: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true,
        };
        resolveWaiters(row.deliveryId, result);
      } finally {
        laneQueue.inFlight.delete(row.deliveryId);
      }
    })
    .then(() => {
      // Drain any additional pending/retriable work in this lane. The row we
      // just processed is excluded INSIDE the claim: claiming it here and then
      // declining to enqueue it left it stranded as 'claimed' and stopped the
      // lane (round-3 review P1).
      if (shuttingDown) return;
      maybeCompact(outbox);
      const next = outbox.claimNextPending(
        lane,
        nowMs(),
        process.pid,
        getProviderTimeoutMs() + getMaxStaggerDelayMs() + 120_000,
        getMaxQueueAgeMs(lane),
        row.deliveryId,
      );
      if (next) {
        enqueue(outbox, next);
      } else {
        scheduleLaneRetry(lane, outbox);
      }
    })
    .catch((err) => {
      logger.error({ err, lane }, 'Outbound email lane tail error');
      laneQueue.inFlight.delete(row.deliveryId);
    });
}

function isRowInFlight(row: OutboxRow): boolean {
  const laneQueue = getLane(row.lane);
  return (
    laneQueue.inFlight.has(row.deliveryId) ||
    laneQueue.activeId === row.deliveryId
  );
}

function enqueueNextPending(lane: OutboxLane, outbox: OutboxStore): void {
  const row = outbox.claimNextPending(
    lane,
    nowMs(),
    process.pid,
    getProviderTimeoutMs() + getMaxStaggerDelayMs() + 120_000,
    getMaxQueueAgeMs(lane),
  );
  if (row) {
    enqueue(outbox, row);
  } else {
    scheduleLaneRetry(lane, outbox);
  }
}

const laneRetryTimers = new Map<OutboxLane, ReturnType<typeof setTimeout>>();

/**
 * Wake the lane when the earliest backed-off retry becomes claimable. Without
 * this a retryable row waits for an unrelated send or a restart, which is the
 * same stall the exclusion above fixes, one step later.
 */
function scheduleLaneRetry(lane: OutboxLane, outbox: OutboxStore): void {
  if (shuttingDown) return;
  let due: number | undefined;
  try {
    due = outbox.nextRetryAt(lane, nowMs());
  } catch (err) {
    logger.error({ err, lane }, 'Could not read the next outbox retry time');
    return;
  }
  if (due === undefined) return;

  const existing = laneRetryTimers.get(lane);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => {
      laneRetryTimers.delete(lane);
      if (shuttingDown) return;
      enqueueNextPending(lane, outbox);
    },
    Math.max(1, due - nowMs()),
  );
  timer.unref?.();
  laneRetryTimers.set(lane, timer);
}

function ensureQueueStarted(): void {
  if (queueStarted) return;
  queueStarted = true;

  const outbox = getOutboxStore();
  try {
    outbox.acquireProcessLock();
  } catch (err) {
    logger.fatal(
      { err },
      'Could not acquire outbound email outbox lock; another process may be running',
    );
    throw err;
  }

  const now = nowMs();
  outbox.resetInFlightClaims();
  outbox.compact(getOutboxRetentionMs(), now);
  lastCompactionAt = now;

  for (const lane of ['transactional', 'bulk', 'alert'] as OutboxLane[]) {
    enqueueNextPending(lane, outbox);
  }
}

export function startOutboundEmailQueue(): void {
  ensureQueueStarted();
}

export async function shutdownOutboundEmailQueue(
  gracePeriodMs: number,
): Promise<void> {
  shuttingDown = true;
  for (const timer of laneRetryTimers.values()) clearTimeout(timer);
  laneRetryTimers.clear();
  const deadline = nowMs() + gracePeriodMs;
  const laneShutdowns: Promise<void>[] = [];

  for (const laneQueue of lanes.values()) {
    laneShutdowns.push(
      (async () => {
        if (laneQueue.activeDone) {
          const remaining = deadline - nowMs();
          if (remaining > 0) {
            await Promise.race([
              laneQueue.activeDone.promise,
              sleep(remaining),
            ]);
          }
        }

        const remaining = deadline - nowMs();
        if (remaining > 0) {
          await Promise.race([laneQueue.tail, sleep(remaining)]);
        }
      })(),
    );
  }

  await Promise.all(laneShutdowns);

  // A restart is NOT a delivery disposition (round-3 review P1). Anything this
  // process claimed but did not finish goes back to 'pending' so the next
  // process replays it; everything already pending stays pending. The provider
  // idempotency key is the deliveryId, so a send that was in flight when the
  // grace period expired cannot become a duplicate.
  const outbox = getOutboxStore();
  try {
    const reset = outbox.resetInFlightClaims(process.pid);
    if (reset > 0) {
      logger.info(
        { reset },
        'Shutdown: returned in-flight outbox claims to pending for startup replay',
      );
    }
  } catch (err) {
    logger.error(
      { err },
      'Could not reset in-flight outbox claims on shutdown',
    );
  }

  // In-process callers still awaiting a queued row get a RETRYABLE failure that
  // is never written to the outbox: the row itself remains pending and the next
  // process delivers it under the same deliveryId. Leaving these promises
  // unresolved would hang the rest of the shutdown sequence instead.
  for (const deliveryId of [...waiters.keys()]) {
    resolveWaiters(deliveryId, {
      status: 'failed',
      reason: 'outbox-deferred-restart',
      retryable: true,
    });
  }

  try {
    outbox.releaseProcessLock();
  } catch {
    // Ignore release failures during shutdown.
  }
}

/**
 * Staggered wrapper around the single Resend send. Every outbound email,
 * regardless of caller, joins a serial lane with a bounded inter-send delay.
 * The promise returned resolves as soon as the actual send completes, so the
 * delivery state machine and the outreach loop see the real outcome without
 * the delay being misread as failure.
 */
export async function sendOutboundEmailResult(
  email: OutboundEmail,
  opts: SendOutboundEmailOptions,
): Promise<OutboundEmailResult> {
  if (!opts.deliveryId) {
    throw new Error('sendOutboundEmailResult requires a deliveryId');
  }

  ensureQueueStarted();

  const lane: OutboxLane = opts.lane ?? 'transactional';
  const deliveryId = opts.deliveryId;
  const outbox = getOutboxStore();
  const existing = outbox.get(deliveryId);

  if (existing) {
    const terminal = rowTerminalResult(existing);
    if (terminal) return terminal;

    // Pending, claimed, or retriable-failed: wait for the lane tail.
    const resultPromise = addWaiter(deliveryId);
    if (!isRowInFlight(existing)) {
      enqueue(outbox, existing);
    }
    return resultPromise;
  }

  const pendingCount = outbox.getPendingCount(lane, getMaxQueueAgeMs(lane));
  if (pendingCount >= getMaxAcceptableDepth(lane)) {
    const intended = computeIntendedRecipients(email, opts);
    reportDeliveryShortfall({
      channel: 'email',
      context: `${opts.sourceGroup}: ${email.subject || '(no subject)'}`,
      intended,
      sent: [],
      missed: intended,
      reason: 'outbox-max-depth-exceeded',
      sourceGroup: opts.sourceGroup,
    });
    recordDeliveryNote({
      deliveryId,
      sourceGroup: opts.sourceGroup,
      context: email.subject || '(no subject)',
      sent: [],
      missed: intended,
      reason: 'outbox-max-depth-exceeded',
    });
    return {
      status: 'failed',
      reason: 'outbox-max-depth-exceeded',
      retryable: false,
    };
  }

  const row = createOutboxRow(deliveryId, lane, email, opts);
  try {
    outbox.insert(row);
  } catch (err) {
    const existingAfterRace = outbox.get(deliveryId);
    if (existingAfterRace) {
      // Another process (or concurrent claim) inserted first; use the durable row.
      return sendOutboundEmailResult(email, opts);
    }
    throw err;
  }

  const resultPromise = addWaiter(deliveryId);
  enqueue(outbox, row);
  return resultPromise;
}

/**
 * Where a delivery id stands, without enqueueing it or waiting on it:
 * `none` (never submitted, or purged after retention), `pending` (queued,
 * in flight, or failed but still retrying), or `done` with the terminal
 * result. For host callers that must reconcile a send they started in an
 * earlier process (routed approvals).
 */
export function peekOutboundEmailResult(
  deliveryId: string,
):
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'done'; result: OutboundEmailResult } {
  const row = getOutboxStore().get(deliveryId);
  if (!row) return { state: 'none' };
  const result = rowTerminalResult(row);
  return result ? { state: 'done', result } : { state: 'pending' };
}

/**
 * Cancel a send that has not started: a pending or still-retrying row
 * becomes a terminal failure, which the lane skips when it reaches it (it
 * re-reads the row and returns on a terminal result). A row claimed by an
 * earlier process is an abandoned claim (the startup reset would revive it
 * as pending), so it is cancelled too. A row claimed by this process (in
 * flight) or finished is left alone. Returns whether the row was cancelled.
 */
export function cancelQueuedOutboundEmail(
  deliveryId: string,
  reason: string,
): boolean {
  const outbox = getOutboxStore();
  const row = outbox.get(deliveryId);
  if (!row) return false;
  const retrying =
    row.status === 'failed' &&
    row.result?.status === 'failed' &&
    row.result.retryable;
  const abandoned = row.status === 'claimed' && row.claimPid !== process.pid;
  if (row.status !== 'pending' && !retrying && !abandoned) return false;
  const at = new Date().toISOString();
  const result = { status: 'failed' as const, reason, retryable: false };
  outbox.set({
    ...row,
    status: 'failed',
    result,
    updatedAt: at,
    terminalAt: at,
    claimPid: undefined,
    claimExpiresAt: undefined,
  });
  resolveWaiters(deliveryId, result);
  return true;
}

/**
 * Compatibility wrapper for one-shot proactive callers. Conversational mail
 * uses sendOutboundEmailResult directly so retryability and provider evidence
 * are preserved by the delivery state machine.
 */
export async function sendOutboundEmail(
  email: OutboundEmail,
  opts: Omit<SendOutboundEmailOptions, 'deliveryId'>,
): Promise<boolean> {
  const result = await sendOutboundEmailResult(email, {
    ...opts,
    deliveryId: randomUUID(),
  });
  return result.status === 'sent';
}

// --- Test helpers ---

/** @internal - for tests only. */
export function _resetStaggerQueueForTests(): void {
  // Kept for backward compat; use _resetOutboundEmailQueueForTests.
  _resetOutboundEmailQueueForTests();
}

/** @internal - for tests only. */
export function _resetOutboundEmailQueueForTests(store?: OutboxStore): void {
  const previous = getOutboxStore();
  try {
    previous.releaseProcessLock();
  } catch {
    // Previous store may not have an active lock.
  }

  for (const timer of laneRetryTimers.values()) clearTimeout(timer);
  laneRetryTimers.clear();
  for (const laneQueue of lanes.values()) {
    laneQueue.tail = Promise.resolve();
    laneQueue.inFlight.clear();
    laneQueue.activeId = undefined;
    laneQueue.activeDone = undefined;
  }
  waiters.clear();
  queueStarted = false;
  shuttingDown = false;
  lastCompactionAt = 0;
  _resetStaggerConfigForTests();
  _resetOutboxRetentionForTests();
  if (store) {
    setOutboxStore(store);
  } else if (!getOutboxStore()) {
    setOutboxStore(new MemoryOutboxStore());
  }
  getOutboxStore().clear();
}

/** @internal - for tests only. Resets in-memory queue state without clearing the outbox or waiters. */
export function _resetOutboundQueueTailForTests(): void {
  try {
    getOutboxStore().releaseProcessLock();
  } catch {
    // Tests may run a store without an active lock.
  }

  for (const timer of laneRetryTimers.values()) clearTimeout(timer);
  laneRetryTimers.clear();
  for (const laneQueue of lanes.values()) {
    laneQueue.tail = Promise.resolve();
    laneQueue.inFlight.clear();
    laneQueue.activeId = undefined;
    laneQueue.activeDone = undefined;
  }
  // Keep existing waiters so callers awaiting a pending row still get a result
  // after a simulated restart. Start as not-started so a restart will replay.
  queueStarted = false;
  shuttingDown = false;
}

/** @internal - for tests only. */
export function _setOutboxStoreForTests(store: OutboxStore): void {
  setOutboxStore(store);
}
