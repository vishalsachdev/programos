/**
 * G46 — uniform delivery-integrity gate (program-repo program/kb-governance.md).
 *
 * ONE shared module owns every leak-signature list and per-channel validation
 * profile. Every outbound transmission passes the profile its channel
 * declares (Channel.gateProfile):
 *
 *   - emailProfile: <reply> block required + scaffolding-signature check.
 *     Never falls back to the raw session text, which would leak internal
 *     scaffolding to the recipient.
 *   - chatProfile: signature check only — free-form text is fine, but known
 *     internal scaffolding and unmatched <reply> tag remnants never transmit.
 *
 * Refusal handling stays with the host delivery coordinator: ordinary replies
 * enter bounded, tool-disabled repair and then terminal disposition; direct
 * host-composed sends fail closed at their call site. This module only decides
 * transmit / refuse. It also owns delivery-completeness
 * reporting for multi-recipient email: any shortfall between intended and
 * actually-sent recipients is reported loudly (log + registered alerter),
 * never as silent partial success.
 */
import {
  claimPendingDeliveryShortfalls,
  deletePendingDeliveryShortfall,
  releasePendingDeliveryShortfallClaim,
  resetExpiredDeliveryShortfallClaims,
  storePendingDeliveryShortfall,
} from './db.js';
import { logger } from './logger.js';
import {
  emailAddressTokensInText,
  emailAddressesInText,
  inboundEmailAddressesInText,
} from './email-addresses.js';
import { stripMarkdown } from './email-format.js';
export {
  emailAddressesInText,
  inboundEmailAddressesInText,
} from './email-addresses.js';
import type { EmailAllowlistState } from './channels/webhook-allowlist.js';
import { TRUSTED_BODY_MAILBOXES } from './trusted-body-mailboxes.js';

// --- Text primitives (moved from router.ts; router re-exports for compat) ---

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

const REPLY_TAG_RE = /<reply>([\s\S]*?)<\/reply>/g;

export function extractReplyBlocks(text: string): string | null {
  const matches = Array.from(text.matchAll(REPLY_TAG_RE));
  if (matches.length === 0) return null;
  return matches
    .map((m) => stripInternalTags(m[1]))
    .filter((s) => s.length > 0)
    .join('\n\n')
    .trim();
}

// Known leak signatures. Body-start patterns are broad (a real reply never
// opens with these); line-start patterns are narrower phrases that are
// unambiguous internal narration wherever they appear, so trailing status
// lines inside an otherwise valid reply are also caught. Mid-sentence
// mentions ("the pilot log committed last week") must not trip the gate.
const SCAFFOLDING_HEAD_RES = [
  /^classification:/i,
  /^mode\s+\d\s*[—–-]/i,
  /^reply\s+sent\b/i,
  /^email\s+sent\b/i,
  /^pilot log committed/i,
];
const SCAFFOLDING_LINE_RES = [
  /^reply sent and pilot log/im,
  /^pilot log committed\b/im,
];

export function looksLikeEmailScaffolding(text: string): boolean {
  const head = text.trimStart();
  return (
    SCAFFOLDING_HEAD_RES.some((re) => re.test(head)) ||
    SCAFFOLDING_LINE_RES.some((re) => re.test(text))
  );
}

/**
 * True when text contains <reply> / </reply> tags that extractReplyBlocks
 * could not pair up — an unmatched tag means malformed agent output, and
 * sending it would put the literal tag (plus surrounding scaffolding) on
 * the wire.
 */
export function hasReplyTagRemnants(text: string): boolean {
  return /<\/?reply>/.test(text);
}

// --- Per-channel delivery profiles ---

export type GateRefusalReason =
  | 'missing-reply-block'
  | 'empty-reply-block'
  | 'scaffolding'
  | 'reply-tag-remnants'
  | 'unverified-email-address';

export type GateResult =
  | { ok: true; text: string }
  | { ok: false; reason: GateRefusalReason; addresses?: string[] };

/** Host-supplied evidence only; validators never read ambient configuration. */
export interface DeliveryGateContext {
  allowlist: EmailAllowlistState;
  /** Already identified intake/state addresses: compare these values exactly, never scan again. */
  trustedBodyAddresses?: readonly string[];
  inboundText?: string[];
  sendFromEmail?: string;
  /** One pre-upgrade saved item, whose evidence was never persisted. */
  legacySavedDeliveryId?: string;
  /** Exact disclosure appended by the host, never supplied by the agent. */
  hostAddedBodySuffix?: string;
}

export function trustedBodyAddressesFromContext(
  context: DeliveryGateContext,
): string[] {
  return [
    ...new Set([
      ...(context.trustedBodyAddresses ?? []).map((address) =>
        address.toLowerCase(),
      ),
      ...(context.inboundText ?? []).flatMap(inboundEmailAddressesInText),
    ]),
  ];
}

export function formatGateRefusal(gate: {
  reason: string;
  addresses?: string[];
}): string {
  return gate.addresses?.length
    ? `${gate.reason}: ${gate.addresses.join(', ')}`
    : gate.reason;
}

function checkBodyAddresses(
  text: string,
  context?: DeliveryGateContext,
  alreadyFormatted = false,
): GateResult {
  if (context?.legacySavedDeliveryId) {
    logger.warn(
      { deliveryId: context.legacySavedDeliveryId },
      'Legacy saved email has no trustedBodyAddresses; skipping its body address check only',
    );
    return { ok: true, text };
  }
  const visible = alreadyFormatted ? text : stripMarkdown(text);
  const suffix = context?.hostAddedBodySuffix
    ? `\n\n${stripMarkdown(context.hostAddedBodySuffix)}`
    : undefined;
  // Scan the whole formatted body first. Only tokens wholly inside the
  // exact host disclosure are exempt; they never confer trust elsewhere.
  const disclosureStart =
    suffix && visible.endsWith(suffix)
      ? visible.length - suffix.length
      : visible.length;
  const tokens = emailAddressTokensInText(visible).filter(
    (token) => token.start < disclosureStart,
  );
  if (!tokens.length) return { ok: true, text };
  // Body claims never inherit permissive recipient fallback. Missing evidence
  // must not turn an unrecognized token into an apparently verified address.
  if (!context?.allowlist.available) {
    return {
      ok: false,
      reason: 'unverified-email-address',
      addresses: [...new Set(tokens.map((token) => token.raw))],
    };
  }
  const trusted = new Set(
    [...context.allowlist.senders].map((a) => a.toLowerCase()),
  );
  for (const address of trustedBodyAddressesFromContext(context))
    trusted.add(address);
  for (const address of emailAddressesInText(context.sendFromEmail ?? ''))
    trusted.add(address);
  for (const address of TRUSTED_BODY_MAILBOXES) trusted.add(address);
  const unknown = [
    ...new Set(
      tokens
        .filter((token) => !trusted.has(token.address))
        .map((token) => token.raw),
    ),
  ];
  return unknown.length
    ? { ok: false, reason: 'unverified-email-address', addresses: unknown }
    : { ok: true, text };
}

export interface DeliveryProfile {
  /** Stable profile id — 'email' | 'chat'. */
  readonly name: string;
  /**
   * Validate raw agent/session output for transmission on this channel.
   * ok:true returns the exact text to put on the wire (may be '' — callers
   * skip empty sends); ok:false means REFUSE: never transmit. The host caller
   * must either enter the bounded repair flow or fail closed.
   */
  validate(rawText: string, context?: DeliveryGateContext): GateResult;
}

/**
 * Minimum body length (chars) that a reply must meet before it is sent on
 * the email channel when the inbound message looks like a document/report
 * request. Below this threshold the reply is sent but a WARNING is logged so
 * the event appears in the host logs without blocking the send.
 *
 * Failure prevented: a short status note sent in place of the requested
 * multi-section document. The scaffolding check blocks the known pattern;
 * this threshold catches variants where the agent
 * produces a structurally valid but content-empty reply.
 */
export const SHORT_REPLY_THRESHOLD = 200;

const DOCUMENT_REQUEST_PATTERNS = [
  /\baudit\b/i,
  /\breport\b/i,
  /\bsummary\b/i,
  /\bcategories\b/i,
  /\boverview\b/i,
  /\bcomprehensive\b/i,
  /\bfull\b.*\b(list|detail|breakdown|analysis)\b/i,
];

/**
 * Log a warning when an outbound email body is suspiciously short relative
 * to what the inbound request asked for. Non-blocking — the send still
 * proceeds so a short-but-correct reply (e.g. "Got it, thanks") is not
 * suppressed. The log entry surfaces in PM2 and the audit trail.
 */
export function warnIfShortReply(
  outboundBody: string,
  inboundText: string,
  context: string,
): void {
  if (outboundBody.length >= SHORT_REPLY_THRESHOLD) return;
  const looksLikeDocRequest = DOCUMENT_REQUEST_PATTERNS.some((re) =>
    re.test(inboundText),
  );
  if (!looksLikeDocRequest) return;
  logger.warn(
    {
      outboundLen: outboundBody.length,
      threshold: SHORT_REPLY_THRESHOLD,
      bodySample: outboundBody.slice(0, 120),
      context,
    },
    'short-reply-guard: outbound body suspiciously short for a document request — possible reply-tag or content-selection error',
  );
}

/**
 * Email: a non-empty <reply> block is REQUIRED and no block may match a
 * scaffolding signature. Never falls back to the full session text.
 */
export const emailProfile: DeliveryProfile = {
  name: 'email',
  validate(rawText: string, context?: DeliveryGateContext): GateResult {
    const matches = Array.from(rawText.matchAll(REPLY_TAG_RE));
    if (matches.length === 0) {
      return { ok: false, reason: 'missing-reply-block' };
    }
    const blocks = matches
      .map((m) => stripInternalTags(m[1]))
      .filter((s) => s.length > 0);
    if (blocks.length === 0) return { ok: false, reason: 'empty-reply-block' };
    // Check each block individually: a second <reply> block that is pure
    // status narration must not ride along with a valid first block.
    if (blocks.some((b) => looksLikeEmailScaffolding(b))) {
      return { ok: false, reason: 'scaffolding' };
    }
    return checkBodyAddresses(blocks.join('\n\n').trim(), context);
  },
};

/**
 * Chat (Telegram, web chat): signature check only. Free-form text is fine —
 * a <reply> block is used when present, otherwise internal tags are stripped
 * and the remainder transmits — but known scaffolding signatures and
 * unmatched reply-tag remnants never go on the wire.
 */
export const chatProfile: DeliveryProfile = {
  name: 'chat',
  validate(rawText: string): GateResult {
    const text = extractReplyBlocks(rawText) ?? stripInternalTags(rawText);
    if (hasReplyTagRemnants(text)) {
      return { ok: false, reason: 'reply-tag-remnants' };
    }
    if (text && looksLikeEmailScaffolding(text)) {
      return { ok: false, reason: 'scaffolding' };
    }
    return { ok: true, text };
  },
};

/** Legacy name kept for existing callers/tests — email profile validation. */
export type EmailGateResult = GateResult;
export function gateEmailOutbound(
  rawText: string,
  context?: DeliveryGateContext,
): GateResult {
  return emailProfile.validate(rawText, context);
}

/**
 * Direct-send backstop for channel sendMessage implementations —
 * defense-in-depth behind the orchestrator's profile validation, for
 * callers that bypass it (IPC sends, scheduler summaries). Unlike
 * emailProfile, tagless text is allowed: a <reply> block is reduced to its
 * contents when present, otherwise internal tags are stripped. Empty
 * bodies, unmatched reply-tag remnants, and known leak signatures never
 * transmit. Lives here so a new leak signature reaches every channel's
 * backstop, not just the profiles (G46: all outbound validation in this
 * module).
 */
export function gateDirectSend(
  rawText: string,
  context?: DeliveryGateContext,
): GateResult {
  const text = extractReplyBlocks(rawText) ?? stripInternalTags(rawText);
  if (!text.trim()) return { ok: false, reason: 'empty-reply-block' };
  if (hasReplyTagRemnants(text)) {
    return { ok: false, reason: 'reply-tag-remnants' };
  }
  if (looksLikeEmailScaffolding(text)) {
    return { ok: false, reason: 'scaffolding' };
  }
  return checkBodyAddresses(text, context);
}

/** Authoritative send boundary: inspect the exact provider text without formatting or extracting it again. */
export function gateFinalEmailBody(
  text: string,
  context?: DeliveryGateContext,
): GateResult {
  if (!text.trim()) return { ok: false, reason: 'empty-reply-block' };
  if (hasReplyTagRemnants(text))
    return { ok: false, reason: 'reply-tag-remnants' };
  if (looksLikeEmailScaffolding(text))
    return { ok: false, reason: 'scaffolding' };
  return checkBodyAddresses(text, context, true);
}

// --- Registry-level profile requirement (startup assertion) ---

const KNOWN_PROFILES: ReadonlySet<DeliveryProfile> = new Set([
  emailProfile,
  chatProfile,
]);

/**
 * Channel.gateProfile is required at the type level; this backstops the
 * compile-time check at startup (JS-built or dynamically constructed
 * channels), so a channel with no declared / unknown profile can never
 * connect and transmit ungated.
 */
export function assertGateProfile(
  channelName: string,
  profile: DeliveryProfile | undefined,
): void {
  if (!profile || !KNOWN_PROFILES.has(profile)) {
    throw new Error(
      `Channel "${channelName}" has no registered delivery-gate profile (G46): ` +
        `every channel must declare gateProfile as one of [email, chat] from delivery-gate.ts`,
    );
  }
}

// --- Delivery completeness (email fan-out) ---

export interface DeliveryShortfall {
  channel: string;
  context: string;
  intended: string[];
  sent: string[];
  missed: string[];
  reason: string;
  /**
   * Group folder whose agent requested the send (e.g. `program-telegram`).
   * Lets the host write the drop back into that agent's conversation so its
   * next turn narrates what was actually sent (RC-018).
   */
  sourceGroup?: string;
}

export type DeliveryShortfallAlerter = (
  shortfall: DeliveryShortfall,
) => Promise<void>;

let shortfallAlerter: DeliveryShortfallAlerter | null = null;
let shortfallFlushTimer: ReturnType<typeof setInterval> | undefined;

/**
 * How often a registered alerter re-attempts alerts still queued. Without a
 * sweep, an alert whose send failed (or whose claim was held by a process that
 * died) would wait for the next restart — persistence that never replays is
 * the same lost alert with extra steps.
 */
export const DELIVERY_SHORTFALL_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/** Wired at startup to the owner's dead-letter channel (Telegram DM). */
export function setDeliveryShortfallAlerter(
  fn: DeliveryShortfallAlerter | null,
): void {
  shortfallAlerter = fn;

  if (shortfallFlushTimer) {
    clearInterval(shortfallFlushTimer);
    shortfallFlushTimer = undefined;
  }
  if (!fn) return;

  flushPendingShortfalls(fn);
  shortfallFlushTimer = setInterval(() => {
    if (shortfallAlerter) flushPendingShortfalls(shortfallAlerter);
  }, DELIVERY_SHORTFALL_FLUSH_INTERVAL_MS);
  shortfallFlushTimer.unref?.();
}

/**
 * Deliver every queued shortfall alert that is not already in flight.
 *
 * Acknowledgement-safe (round-4): each alert is CLAIMED, delivered, and only
 * then deleted. Deleting the table up front lost every alert that was still in
 * flight when the process exited, and treated a failed send as a successful
 * one.
 */
function flushPendingShortfalls(fn: DeliveryShortfallAlerter): void {
  try {
    resetExpiredDeliveryShortfallClaims();
    const pending = claimPendingDeliveryShortfalls(process.pid);
    if (pending.length === 0) return;
    for (const { id, shortfall } of pending) {
      fn(shortfall).then(
        () => {
          try {
            deletePendingDeliveryShortfall(id);
          } catch (err) {
            logger.error(
              { err, id },
              'Could not clear an acknowledged shortfall alert',
            );
          }
        },
        (err: unknown) => {
          logger.error(
            { err },
            'Delivery-shortfall alert flush failed; leaving it queued for retry',
          );
          try {
            releasePendingDeliveryShortfallClaim(id);
          } catch (releaseErr) {
            logger.error(
              { err: releaseErr, id },
              'Could not release a failed shortfall alert claim',
            );
          }
        },
      );
    }
  } catch (err) {
    logger.error(
      { err },
      'Could not flush pending delivery shortfalls (database may not be ready)',
    );
  }
}

export function formatShortfallAlert(s: DeliveryShortfall): string {
  return (
    `⚠️ Coordinator delivery shortfall (${s.channel}, ${s.context}): ` +
    `missed recipient(s): ${s.missed.join(', ') || '(none listed)'} — ` +
    `reason: ${s.reason}. Intended ${s.intended.length}, sent ${s.sent.length}. ` +
    `Never treat this send as complete.`
  );
}

/**
 * Report that a transmission did not reach every intended recipient.
 * Always logs at error level; additionally fires the registered alerter
 * (fire-and-forget — an alert failure must not mask the original failure,
 * but it is itself logged and queued for retry).
 */
export function reportDeliveryShortfall(shortfall: DeliveryShortfall): void {
  if (shortfall.missed.length === 0) return;
  logger.error(
    { ...shortfall },
    'Delivery shortfall: intended recipients were NOT all sent (G46 — never silently partial)',
  );
  if (shortfallAlerter) {
    shortfallAlerter(shortfall).catch((err) => {
      logger.error(
        { err, missed: shortfall.missed },
        'Delivery-shortfall alert could not be delivered; queueing for retry',
      );
      try {
        storePendingDeliveryShortfall(shortfall);
      } catch (storeErr) {
        logger.error(
          { err: storeErr, shortfall },
          'Could not queue shortfall alert for retry',
        );
      }
    });
  } else {
    // No alerter registered yet; persist the shortfall so it can be retried
    // once the owner channel is wired.
    try {
      storePendingDeliveryShortfall(shortfall);
    } catch (err) {
      logger.error(
        { err, shortfall },
        'Could not queue shortfall alert (database may not be ready)',
      );
    }
  }
}
