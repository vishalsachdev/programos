import { simpleParser, type EmailAddress } from 'mailparser';
import { inboundEmailAddressesInHtml } from '../inbound-html-addresses.js';
import { createServer, Server } from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import { registerChannel } from './registry.js';
import { AGENT_INBOX_ADDRESSES, DEFAULT_BOT_EMAIL } from '../config.js';
import {
  cancelQueuedOutboundEmail,
  peekOutboundEmailResult,
  sendOutboundEmail,
  sendOutboundEmailResult,
  type OutboundEmail,
  type SendOutboundEmailOptions,
} from '../outbound-email.js';
import {
  emailProfile,
  gateDirectSend,
  inboundEmailAddressesInText,
  trustedBodyAddressesFromContext,
  formatGateRefusal,
  type DeliveryGateContext,
  reportDeliveryShortfall,
} from '../delivery-gate.js';
import {
  logDeliveryProblem,
  logDroppedEmail,
  logInboundEmailReceiptOnce,
  logRoutedApproval,
} from '../audit-log.js';
import {
  createRoutedApprovalService,
  dbRoutedApprovalStore,
  OPEN_QUESTIONS_PATH,
} from '../routed-approvals.js';
import {
  analyzeCcContext,
  extractAddresses,
  mergeSuppressDecision,
  type CcContextResult,
} from '../cc-context.js';
import { mirrorReplyCc } from '../reply-cc-mirror.js';
import { getHttpRoute } from './http-routes.js';
import { handleGithubPushRequest } from './github-push-events.js';
import { handleResendWebhookRequest } from './resend-events.js';
import { recordDeliveryEvent } from '../email-delivery-check.js';
import { isBoxNotification, senderDomain } from './box-notifications.js';
import {
  canProcessEmailSender,
  loadEmailAllowlistFrom,
  normalizeEmailAllowlistFallbackMode,
} from './webhook-allowlist.js';
import {
  buildSenderCapAlert,
  buildSenderCapNotice,
  chooseNoticeCc,
  createSenderQuota,
  DEFAULT_PERSON_SENDER_CAP,
  DEFAULT_SENDER_CAP,
  formatCentralTime,
  parseSenderCap,
  retryTransient,
  SENDER_CAP_ALERT_RETRY_DELAYS_MS,
  SENDER_WINDOW_MS,
} from './sender-quota.js';
import {
  resolveKbTriageApproverCc,
  snapshotKbConflictTriage,
  type KbConflictTriageSnapshot,
} from './kb-triage-cc.js';
import { makeTtlCachedAllowlist } from '../channel-utils.js';
import { getRepoReader } from '../repo-reader.js';
import { getProgramRepoPath } from '../program-repo.js';
import { readFromCheckoutBuffer } from '../checkout-fs.js';
import { deriveEmailChatJid, parseEmailIdentity } from './webhook-threading.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { INSTITUTION_DOMAIN } from '../instance-identity.js';
import { Channel, PreparedDelivery } from '../types.js';
import {
  extractEmailAttachments,
  extractDocument,
  saveExtraction,
} from '../document-extractor.js';
import { isAutoReplyEml } from '../email-loop-detection.js';
import { getOutboundMailProvider } from '../outbound-email-smtp.js';
import { sendAdminAlert, type AdminAlertResult } from '../admin-alert.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { safeAttachmentName } from '../attachment-safety.js';
import { getLastTaskRunAt } from '../db.js';

const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3003', 10);
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || '0.0.0.0';
const HIGH_ATTACHMENT_THRESHOLD = 10;

export { deriveEmailChatJid } from './webhook-threading.js';

export function getSchedulerLiveness(): {
  lastTaskRunAt: string | null;
  schedulerStaleHours: number | null;
} {
  try {
    const lastTaskRunAt = getLastTaskRunAt();
    if (lastTaskRunAt === null) {
      return { lastTaskRunAt: null, schedulerStaleHours: null };
    }

    const runAtMs = Date.parse(lastTaskRunAt);
    if (!Number.isFinite(runAtMs)) {
      return { lastTaskRunAt: null, schedulerStaleHours: null };
    }

    return {
      lastTaskRunAt,
      schedulerStaleHours: Math.floor((Date.now() - runAtMs) / 3_600_000),
    };
  } catch {
    return { lastTaskRunAt: null, schedulerStaleHours: null };
  }
}

/**
 * Materialize a raw .eml committed by the email-inbox Worker. The Worker
 * pushes to GitHub before posting this webhook, so a forced mirror refresh
 * is guaranteed to see the file — unlike the live checkout, which is only
 * pulled by containers at task start. Falls back to the live checkout for
 * resilience (e.g. replays of old messages). Returns a readable absolute
 * path (temp file for mirror reads — caller deletes it) or null.
 */
function materializeRawEml(
  rawFilePath: string,
  repoPath: string,
  opts?: { skipRefresh?: boolean },
): string | null {
  const reader = getRepoReader();
  // The refresh is a forced SYNCHRONOUS git fetch. One webhook request may
  // materialize both the .md (loop guard/attachments) and the .eml
  // (cc-context) — the Worker commits every file before POSTing, so a
  // single refresh covers both; a second fetch would only block the event
  // loop again.
  if (!opts?.skipRefresh) reader.refresh({ force: true });
  const buf = reader.readFileBuffer(rawFilePath);
  if (buf) {
    const tmp = join(os.tmpdir(), `nanoclaw-eml-${crypto.randomUUID()}.eml`);
    // 0600: .eml content may carry private program/student information; the
    // shared tmpdir must not expose it to other local users.
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    return tmp;
  }
  // Fallback to the container-writable checkout: read it as the checkout
  // owner into a private temp file, never hand root a path there (a planted
  // link to .env would otherwise be parsed into the agent prompt).
  const live = readFromCheckoutBuffer(repoPath, join(repoPath, rawFilePath));
  if (live) {
    const tmp = join(os.tmpdir(), `nanoclaw-eml-${crypto.randomUUID()}.eml`);
    fs.writeFileSync(tmp, live, { mode: 0o600 });
    return tmp;
  }
  logger.warn({ rawFilePath }, 'Raw .eml not found in mirror or live checkout');
  return null;
}

registerChannel('webhook', (opts) => {
  const env = readEnvFile(['WEBHOOK_SECRET']);
  const secret = env.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;

  if (!secret) {
    logger.info('Webhook channel: WEBHOOK_SECRET not set, skipping');
    return null;
  }

  // Read Resend config once at init
  const githubPushSecret =
    readEnvFile(['GITHUB_PUSH_WEBHOOK_SECRET']).GITHUB_PUSH_WEBHOOK_SECRET ||
    process.env.GITHUB_PUSH_WEBHOOK_SECRET;
  const resendEnv = readEnvFile([
    'RESEND_API_KEY',
    'OPERATOR_CC_EMAIL',
    'SEND_FROM_NAME',
    'SEND_FROM_EMAIL',
    'RESEND_WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ADMIN_CHAT_ID',
  ]);

  // Tri-state result so retry-inviting callers (webhook adapters that 5xx on
  // failure) can distinguish a transient outage (worth a retry) from a
  // permanent misconfiguration (retrying forever would get the endpoint
  // auto-disabled by the sender, e.g. Svix).
  async function pingAdminViaTelegram(text: string): Promise<AdminAlertResult> {
    const token =
      resendEnv.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
    const chatId =
      resendEnv.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (!token || !chatId) {
      logger.warn(
        'Cannot ping admin: TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID missing',
      );
      return 'unconfigured';
    }
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      );
      if (!response.ok) {
        logger.error(
          { status: response.status },
          'Failed to ping admin via Telegram',
        );
        return response.status === 429 || response.status >= 500
          ? 'failed-transient'
          : 'failed-permanent';
      }
      return 'sent';
    } catch (err) {
      logger.error({ err }, 'Failed to ping admin via Telegram');
      return 'failed-transient';
    }
  }

  // Every operator alert from this channel goes through here. The route
  // (Telegram, email to the operator, or both) follows ADMIN_ALERT_ROUTE;
  // see admin-alert.ts. Do not call pingAdminViaTelegram directly.
  const alertAdmin = (text: string): Promise<AdminAlertResult> =>
    sendAdminAlert(text, { telegram: () => pingAdminViaTelegram(text) });

  // Live checkout path — still needed for WRITE-side work (raw .eml reads of
  // just-committed mail, attachment extraction output) and for ownership
  // repair after host-side commits. Allowlist READS no longer touch it.
  const repoPath = getProgramRepoPath();

  // Email allowlist served from the pinned read-mirror SHA (RepoReader),
  // refreshed lazily. RepoReader owns last-good semantics at the SHA level —
  // a failed fetch keeps serving the previous commit, which removes the need
  // for a reload-reconcile workaround.
  const allowlistFallbackMode = normalizeEmailAllowlistFallbackMode(
    process.env.EMAIL_ALLOWLIST_FALLBACK_MODE,
  );
  const allowlistCache = makeTtlCachedAllowlist(loadEmailAllowlistFrom);
  const getAllowlist = allowlistCache.get;
  // Reply paths must use peek(), never get() — see makeTtlCachedAllowlist.
  const peekAllowlist = allowlistCache.peek;

  // Store email metadata per chat for reply threading
  interface EmailMetadata {
    bodyAddresses?: string[];
    bodyEvidenceVersion?: 1;
    from: string;
    subject: string;
    message_id: string;
    to: string;
    cc: string;
    /**
     * CC-as-context decision made at intake from the real .eml headers
     * (G56). Envelope to/cc above are the Worker's lossy values, kept for
     * fallback; suppressAck here is the only thing sendMessage branches on.
     */
    ccContext?: CcContextResult;
    kbConflictSnapshot: KbConflictTriageSnapshot;
    /**
     * The exact allowlist snapshot that ADMITTED this message. The reply is
     * judged against this, not the live cache: a concurrent inbound can
     * refresh the global state mid-turn, and a sender admitted under
     * permissive fallback (or removed from the list mid-turn) must not have
     * their reply refused by a snapshot that never saw their message.
     */
    allowlistSnapshot: ReturnType<typeof loadEmailAllowlistFrom>;
  }
  interface PreparedEmailReply {
    email: OutboundEmail;
    options: Omit<SendOutboundEmailOptions, 'allowlistState'> & {
      allowlistState?: {
        available: boolean;
        senders: string[];
        source: string;
      };
    };
  }
  interface EmailDeliveryContextV1 {
    type: 'webhook-email-v1';
    bodyAddresses?: string[];
    bodyEvidenceVersion?: 1;
    from: string;
    subject: string;
    messageId: string;
    ccContext?: CcContextResult;
    kbConflictSnapshot: KbConflictTriageSnapshot;
    allowlistSnapshot: {
      available: boolean;
      senders: string[];
      source: string;
    };
  }
  const emailMetadata = new Map<string, EmailMetadata>();
  const MAX_EMAIL_METADATA = 500; // prevent unbounded growth (one entry per thread)

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function restoreEmailDeliveryContext(jid: string, value: unknown): boolean {
    if (!isRecord(value) || value.type !== 'webhook-email-v1') return false;
    if (
      (value.bodyEvidenceVersion !== undefined &&
        value.bodyEvidenceVersion !== 1) ||
      (value.bodyAddresses !== undefined &&
        (!Array.isArray(value.bodyAddresses) ||
          !value.bodyAddresses.every((a) => typeof a === 'string'))) ||
      typeof value.from !== 'string' ||
      !value.from ||
      typeof value.subject !== 'string' ||
      typeof value.messageId !== 'string' ||
      !isRecord(value.kbConflictSnapshot) ||
      !isRecord(value.allowlistSnapshot) ||
      typeof value.allowlistSnapshot.available !== 'boolean' ||
      typeof value.allowlistSnapshot.source !== 'string' ||
      !Array.isArray(value.allowlistSnapshot.senders) ||
      !value.allowlistSnapshot.senders.every(
        (sender) => typeof sender === 'string',
      )
    ) {
      return false;
    }
    let ccContext: CcContextResult | undefined;
    if (value.ccContext !== undefined) {
      if (
        !isRecord(value.ccContext) ||
        typeof value.ccContext.ccOnly !== 'boolean' ||
        typeof value.ccContext.suppressAck !== 'boolean' ||
        typeof value.ccContext.reason !== 'string' ||
        (value.ccContext.botInTo !== undefined &&
          typeof value.ccContext.botInTo !== 'boolean') ||
        (value.ccContext.realTo !== undefined &&
          typeof value.ccContext.realTo !== 'string') ||
        (value.ccContext.realCc !== undefined &&
          typeof value.ccContext.realCc !== 'string')
      ) {
        return false;
      }
      ccContext = value.ccContext as unknown as CcContextResult;
    }
    emailMetadata.set(jid, {
      ...(value.bodyEvidenceVersion === 1 && value.bodyAddresses
        ? {
            bodyAddresses: value.bodyAddresses as string[],
            bodyEvidenceVersion: 1 as const,
          }
        : {}),
      from: value.from,
      subject: value.subject,
      message_id: value.messageId,
      to: '',
      cc: '',
      ...(ccContext ? { ccContext } : {}),
      kbConflictSnapshot:
        value.kbConflictSnapshot as unknown as KbConflictTriageSnapshot,
      allowlistSnapshot: {
        available: value.allowlistSnapshot.available,
        source: value.allowlistSnapshot.source,
        senders: new Set(value.allowlistSnapshot.senders),
      },
    });
    return true;
  }

  function snapshotEmailDeliveryContext(
    jid: string,
  ): EmailDeliveryContextV1 | undefined {
    const meta = emailMetadata.get(jid);
    if (!meta) return undefined;
    return {
      type: 'webhook-email-v1',
      ...(meta.bodyEvidenceVersion === 1 && meta.bodyAddresses
        ? { bodyAddresses: meta.bodyAddresses, bodyEvidenceVersion: 1 as const }
        : {}),
      from: meta.from,
      subject: meta.subject,
      messageId: meta.message_id,
      ...(meta.ccContext ? { ccContext: meta.ccContext } : {}),
      kbConflictSnapshot: meta.kbConflictSnapshot,
      allowlistSnapshot: {
        available: meta.allowlistSnapshot.available,
        source: meta.allowlistSnapshot.source,
        senders: [...meta.allowlistSnapshot.senders].sort(),
      },
    };
  }

  // Deduplicate: track processed message IDs + filename hashes to prevent double-processing
  const processedEmails = new Set<string>();
  const processingEmails = new Set<string>();
  const MAX_PROCESSED = 500; // prevent unbounded growth

  function markEmailProcessed(dedupKey: string): void {
    processingEmails.delete(dedupKey);
    processedEmails.add(dedupKey);
    if (processedEmails.size > MAX_PROCESSED) {
      const first = processedEmails.values().next().value;
      if (first) processedEmails.delete(first);
    }
  }

  function attachmentCountFrom(value: unknown): number | null {
    return Number.isInteger(value) && (value as number) >= 0
      ? (value as number)
      : null;
  }

  function alertField(value: string | undefined, fallback: string): string {
    return (value || fallback).replace(/[\r\n]+/g, ' ').slice(0, 300);
  }

  async function recordHighAttachmentReceipt(args: {
    receiptId: string;
    from: string;
    subject: string;
    receivedAt?: string;
    attachmentCount: number;
  }): Promise<boolean> {
    const result = await logInboundEmailReceiptOnce(args);
    const alertFrom = alertField(args.from, 'unknown');
    const alertSubject = alertField(args.subject, 'No Subject');
    if (result === 'write-failed') {
      await alertAdmin(
        `Email intake audit failed for a ${args.attachmentCount}-attachment message from ${alertFrom}: ${alertSubject}. The Worker must retry this receipt.`,
      );
      return false;
    }
    if (result === 'written') {
      await alertAdmin(
        `High-attachment email accepted (${args.attachmentCount} files).\nFrom: ${alertFrom}\nSubject: ${alertSubject}\nA durable intake receipt exists; attachment storage and agent processing may still be pending.`,
      );
    }
    return true;
  }

  // Per-sender daily turn cap (G19, tiers in sender-quota.ts). Backstops the
  // auto-reply header check for misbehaving senders that don't set
  // Auto-Submitted/Precedence/etc. Resets on process restart, which is
  // acceptable — the auto-reply header detection handles the actual loop
  // scenario; this is for residual abuse.
  const senderQuota = createSenderQuota({
    defaultCap: parseSenderCap(
      process.env.EMAIL_SENDER_DAILY_CAP,
      DEFAULT_SENDER_CAP,
    ),
    personCap: parseSenderCap(
      process.env.EMAIL_PERSON_SENDER_DAILY_CAP,
      DEFAULT_PERSON_SENDER_CAP,
    ),
  });

  /**
   * A person on the allowlist, not an agent principal. Anything the
   * allowlist cannot vouch for (unavailable list under permissive fallback,
   * or a snapshot without agent data) gets the lower default cap.
   */
  function isAllowlistedPerson(
    from: string | undefined,
    state: ReturnType<typeof getAllowlist>,
  ): boolean {
    const addr = (from || '').toLowerCase().trim();
    return (
      state.available &&
      state.senders.has(addr) &&
      state.agentSenders !== undefined &&
      !state.agentSenders.has(addr)
    );
  }

  // Over-cap reporting: one Telegram alert to Avery per sender window (G30
  // named exception) and one notice to a person (never an agent: a reply can
  // feed its loop). The notice goes right after the first alert attempt; a
  // transient alert failure keeps retrying after it. If every attempt fails
  // the alert is released, so the next over-cap message tries again. The
  // notice says Avery was told only when the alert or an allowlisted CC
  // proves it.
  async function reportSenderCapReached(event: {
    from: string;
    subject: string | undefined;
    messageId: string | undefined;
    count: number;
    cap: number;
    allowlistedPerson: boolean;
    windowStart: number;
    alert: boolean;
    notice: boolean;
    noticeAlreadySent: boolean;
    /** The snapshot that admitted this message (see sendSenderCapNotice). */
    allowlistSnapshot: ReturnType<typeof getAllowlist>;
  }): Promise<void> {
    const resetAt = formatCentralTime(event.windowStart + SENDER_WINDOW_MS);
    const alertText = buildSenderCapAlert({
      ...event,
      resetAt,
      notice: event.notice
        ? 'sending'
        : event.noticeAlreadySent
          ? 'sent-earlier'
          : 'none',
    });
    const firstAlert = event.alert ? await alertAdmin(alertText) : undefined;
    if (event.notice) {
      // A notice failure must not stop the alert retry and release below.
      await sendSenderCapNotice(event, resetAt, firstAlert === 'sent').catch(
        (err) =>
          logger.error({ err, from: event.from }, 'Sender cap notice failed'),
      );
    }
    if (!event.alert || firstAlert === undefined) return;
    const finalAlert = await retryTransient(
      firstAlert,
      () => alertAdmin(alertText),
      SENDER_CAP_ALERT_RETRY_DELAYS_MS,
    );
    if (finalAlert !== 'sent') {
      senderQuota.releaseAlert(event.from, event.windowStart);
      logger.error(
        { from: event.from, result: finalAlert },
        'Sender cap alert not delivered; the next over-cap message retries it',
      );
    }
  }

  async function sendSenderCapNotice(
    event: {
      from: string;
      subject: string | undefined;
      messageId?: string;
      cap: number;
      allowlistSnapshot: ReturnType<typeof getAllowlist>;
    },
    resetAt: string,
    alertSent: boolean,
  ): Promise<void> {
    // The snapshot that admitted the message, as ordinary replies keep it: a
    // concurrent refresh (failed or changed) must not refuse the one notice,
    // which is never re-claimed. The CC proves Avery was told only if this
    // same snapshot lets it through.
    const allowlistState = event.allowlistSnapshot;
    const cc = chooseNoticeCc({
      alertSent,
      fallbackCc: resendEnv.OPERATOR_CC_EMAIL,
      fallbackCcAddresses: extractAddresses(resendEnv.OPERATOR_CC_EMAIL),
      allowlist: allowlistState,
    });
    const subject = (event.subject || '').startsWith('Re:')
      ? event.subject!
      : `Re: ${event.subject || 'your message to Coordinator'}`;
    const ok = await sendOutboundEmail(
      {
        to: event.from,
        ...(cc ? { cc } : {}),
        subject,
        body: buildSenderCapNotice({
          cap: event.cap,
          resetAt,
          operatorTold: alertSent || cc !== undefined,
        }),
      },
      {
        sourceGroup: 'webhook-sender-cap',
        forceBotReplyTo: true,
        ...(event.messageId ? { inReplyTo: event.messageId } : {}),
        allowlistState,
        extraHeaders: { 'Auto-Submitted': 'auto-replied', Precedence: 'bulk' },
      },
    );
    if (ok) {
      logger.info({ from: event.from }, 'Sender cap notice sent');
    } else {
      logger.error({ from: event.from }, 'Sender cap notice failed');
    }
  }

  // Routed approvals (G42 Tier 2 email-group relay, v9.10). Intake keeps the
  // host's own copy of each email; every new `## Routed Approvals` entry is
  // checked against it and the allowlist pin before the host relays to the
  // approver. A failed check holds the relay and tells Avery (G30 named
  // exception). Runs on each GitHub push and hourly (routed-approvals.ts).
  const routedApprovals = createRoutedApprovalService({
    store: dbRoutedApprovalStore,
    // Reads never fetch. A push force-refreshes the mirror before its scan;
    // only the hourly fallback scan calls refreshMirror, which fetches
    // without blocking the event loop.
    readOpenQuestions: () => getRepoReader().readFileAsync(OPEN_QUESTIONS_PATH),
    readAllowlist: () =>
      getRepoReader().readFileAsync('program/EMAIL_ALLOWLIST.md'),
    sendEmail: (email, opts) => sendOutboundEmailResult(email, opts),
    peekRelay: (deliveryId) => peekOutboundEmailResult(deliveryId),
    cancelRelay: (deliveryId, reason) =>
      cancelQueuedOutboundEmail(deliveryId, reason),
    refreshMirror: () => getRepoReader().refreshAsync(),
    pingOwner: alertAdmin,
    audit: (event) => logRoutedApproval(event),
  });

  // Box update-notification detection lives in box-notifications.ts (dormant
  // fallback for the scheduled Box sync job). The
  // route-side debounce + optional filename backstop below stay here.
  const BOX_PING_DEBOUNCE_MS = parseInt(
    process.env.BOX_NOTIFY_DEBOUNCE_MS || String(15 * 60 * 1000),
    10,
  );
  // Optional filename backstop. Primary scoping is done in Box (collaborate
  // the bot on the specific Excel files, not the folder), so this is OFF by
  // default (empty). If folder-level notifications ever leak through, set
  // e.g. BOX_NOTIFY_WATCH_FILES="Course Map,Instructional Activity Roster"
  // and only subjects containing one of those substrings will ping.
  const BOX_NOTIFY_WATCH_FILES = (process.env.BOX_NOTIFY_WATCH_FILES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  let lastBoxPingAt = 0;

  // ───────────────────────────────────────────────────────────────────────
  // "Access closed" auto-reply for blocked EXU senders.
  // Coordinator access is allowlist-scoped; non-allowlisted senders are normally dropped
  // silently. But a non-allowlisted **@example.edu** sender is a real
  // colleague who deserves a response, not silence — so we send a one-time
  // courteous reply pointing them to Avery. Truly external/unknown senders
  // still drop silently (no backscatter to spoofed addresses). Deduped per
  // sender (resets on restart — at most one extra reply per restart), and we
  // skip obvious automated addresses + set Auto-Submitted so we don't loop
  // with the recipient's own autoresponder.
  // ───────────────────────────────────────────────────────────────────────
  const institutionAddressRe = new RegExp(
    `^[^\\s@<>,;]+@([a-z0-9-]+\\.)*${INSTITUTION_DOMAIN.replace(/\./g, '\\.')}$`,
  );
  const blockedNotified = new Set<string>();
  const MAX_BLOCKED_NOTIFIED = 1000;

  function isInstitutionSender(from: string | undefined): boolean {
    const dom = senderDomain(from);
    return dom === INSTITUTION_DOMAIN || dom.endsWith('.' + INSTITUTION_DOMAIN);
  }

  function isLikelyAutomatedAddress(from: string | undefined): boolean {
    const addr = extractAddresses(from)[0] ?? (from || '').toLowerCase();
    const local = addr.split('@')[0] || '';
    return /(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?|automated)([._-]|$)/.test(
      local,
    );
  }

  /**
   * Exactly one bare EXU mailbox, or null. The exemption path must not
   * trust `senderDomain()` (it inspects text after the LAST @, so
   * "attacker@evil.com, victim@example.edu" passes) — extract the single
   * addr-spec and require the EXU suffix on the address itself.
   */
  function singleInstitutionAddress(from: string): string | null {
    if (from.includes(',') || from.includes(';')) return null;
    const angle = from.match(/<([^>]+)>/);
    const addr = (angle ? angle[1] : from).trim().toLowerCase();
    if (!institutionAddressRe.test(addr)) return null;
    return addr;
  }

  async function sendAccessClosedReply(
    from: string,
    subject: string | undefined,
  ): Promise<void> {
    const to = singleInstitutionAddress(from);
    if (!to) {
      logger.warn(
        { from },
        'Access-closed reply refused: From is not a single bare EXU address',
      );
      return;
    }
    const replySubject = (subject || '').startsWith('Re:')
      ? subject
      : `Re: ${subject || 'your message to Coordinator'}`;
    const text =
      `Thanks for reaching out to Coordinator, the Program knowledge-base assistant.\n\n` +
      `Coordinator access is currently limited to the Program program team, so your ` +
      `message wasn't processed. For Program questions ` +
      `or to request access, please contact Avery Morgan (avery@example.edu).\n\n` +
      `— Coordinator`;
    // Routed through the sendOutboundEmail choke
    // point. The recipient is BY DEFINITION not allowlisted (G17's courtesy
    // reply answers a blocked @example.edu sender once), so this is the one
    // sanctioned user of toAllowlistExemption — logged on every use. Gains
    // over the old direct call: an [OUTBOUND EMAIL] audit record (G23 — this
    // send was previously invisible to the audit log) and G46 shortfall
    // reporting on failure.
    const ok = await sendOutboundEmail(
      {
        to,
        ...(resendEnv.OPERATOR_CC_EMAIL
          ? { cc: resendEnv.OPERATOR_CC_EMAIL }
          : {}),
        subject: replySubject ?? 'Re: your message to Coordinator',
        body: text,
      },
      {
        sourceGroup: 'webhook-access-closed',
        forceBotReplyTo: true,
        toAllowlistExemption: {
          reason: 'G17 courtesy reply to non-allowlisted EXU sender',
        },
        // Snapshot WITHOUT refresh: never a sync git fetch on a send path.
        allowlistState: peekAllowlist(),
        // RFC 3834: mark as an auto-reply so the recipient's mail system
        // doesn't fire its own autoresponder back at us (loop guard).
        extraHeaders: { 'Auto-Submitted': 'auto-replied', Precedence: 'bulk' },
      },
    );
    if (ok) {
      logger.info({ from }, 'Access-closed reply sent to blocked EXU sender');
    } else {
      logger.error({ from }, 'Access-closed reply failed');
    }
  }

  let server: Server | null = null;
  let connected = false;

  const channel: Channel = {
    name: 'webhook',
    gateProfile: emailProfile,

    async connect() {
      server = createServer((req, res) => {
        // Handle CORS preflight for /chat endpoint
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization',
          );
          res.writeHead(204);
          res.end();
          return;
        }

        // Liveness probe (external uptime monitor hits this).
        // Reaching this handler proves the HTTP server + event loop are alive.
        if (
          (req.method === 'GET' || req.method === 'HEAD') &&
          (req.url === '/health' || req.url === '/healthz')
        ) {
          const schedulerLiveness = getSchedulerLiveness();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              service: 'programos',
              connected,
              uptimeSec: Math.round(process.uptime()),
              ...schedulerLiveness,
            }),
          );
          return;
        }

        // Only accept POST
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method Not Allowed');
          return;
        }

        const url = new URL(req.url || '/', `http://${req.headers.host}`);

        // Route /chat to web chat handler
        if (url.pathname === '/chat') {
          const chatHandler = getHttpRoute('/chat');
          if (chatHandler) {
            void chatHandler(req, res);
            return;
          }
          res.writeHead(404);
          res.end('Web chat not configured');
          return;
        }

        if (url.pathname === '/resend/webhook') {
          handleResendWebhookRequest(req, res, {
            webhookSecret: resendEnv.RESEND_WEBHOOK_SECRET,
            // Throw only on transient failure so the handler 500s and
            // Resend/Svix retries the event. Permanent misconfiguration
            // degrades to log-and-200 — endlessly failing deliveries would
            // get the endpoint auto-disabled, ending bounce visibility.
            pingAdminViaTelegram: async (text) => {
              if ((await alertAdmin(text)) === 'failed-transient') {
                throw new Error('Owner alert failed');
              }
            },
            logDeliveryProblem,
            recordDeliveryEvent,
          });
          return;
        }

        if (url.pathname === '/api/github-push') {
          // The owner alert must THROW on failure: a protected-path violation
          // alert that cannot be delivered makes the handler return 5xx so
          // the delivery shows as failed in GitHub (redelivery is manual —
          // GitHub does not auto-retry webhook deliveries).
          // Unlike Svix, GitHub never auto-retries or auto-disables on 5xx,
          // so ANY undelivered alert throws here — the failed delivery in
          // GitHub's webhook UI is the visibility signal.
          handleGithubPushRequest(
            req,
            res,
            githubPushSecret,
            async (text) => {
              if ((await alertAdmin(text)) !== 'sent') {
                throw new Error('Owner alert failed');
              }
            },
            // A push is the moment a new Routed Approvals entry is committed.
            () => void routedApprovals.scanSoon(),
          );
          return;
        }

        // Check secret
        const authHeader = req.headers['authorization'];
        if (authHeader !== `Bearer ${secret}`) {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
          // Raw .eml materialized once per request on first need (see
          // materializeRawEml). Mirror reads land in a temp file that the
          // finally below removes; live-checkout fallbacks are left alone.
          let materializedEmlPath: string | null | undefined;
          let materializedHeaderEmlPath: string | null | undefined;
          let activeDedupKey: string | undefined;
          let activeQuota: { sender: string; windowStart: number } | undefined;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const {
              filename,
              subject,
              from,
              to,
              cc,
              date,
              message_id,
              raw_file_path,
              eml_file_path,
              raw_email,
              inbound_text,
              phase,
              attachment_count,
              attachment_state,
            } = body;

            if (!filename || !subject) {
              res.writeHead(400);
              res.end('Missing filename or subject');
              return;
            }

            // Reject any payload whose paths try to escape the repo via `..`.
            // raw_file_path is set by our Cloudflare email-inbox Worker, but the
            // webhook is authenticated only by HMAC — defense-in-depth here
            // protects against a compromised worker or replay with a tampered
            // body.
            if (
              (typeof raw_file_path === 'string' &&
                /(^|\/)\.\.(\/|$)/.test(raw_file_path)) ||
              (typeof eml_file_path === 'string' &&
                /(^|\/)\.\.(\/|$)/.test(eml_file_path)) ||
              (typeof filename === 'string' &&
                /(^|\/)\.\.(\/|$)/.test(filename))
            ) {
              logger.warn(
                { raw_file_path, eml_file_path, filename, from },
                'webhook: rejecting payload with path traversal',
              );
              res.writeHead(400);
              res.end('Invalid path');
              return;
            }

            // All pre-container reads of the raw file go through this — the
            // live checkout is never pulled by the host anymore, so reading
            // join(repoPath, raw_file_path) directly would always miss fresh
            // mail. Memoized: at most one forced mirror refresh per request.
            let mirrorRefreshed = false;
            const getEmlPath = (): string | null => {
              if (materializedEmlPath === undefined) {
                materializedEmlPath =
                  typeof raw_file_path === 'string' && raw_file_path
                    ? materializeRawEml(raw_file_path, repoPath, {
                        skipRefresh: mirrorRefreshed,
                      })
                    : null;
                mirrorRefreshed = true;
              }
              return materializedEmlPath;
            };

            // The ACTUAL RFC 2822 message (may be
            // body-truncated at 256KB). raw_file_path above is the Worker's
            // markdown summary, which has no parseable header block —
            // analyzeCcContext always falls into "no To/Cc headers"
            // ambiguity on it. Used ONLY for cc-context
            // analysis: the auto-reply and attachment consumers keep the
            // .md they have always received, so their behavior does not
            // shift under a truncated MIME structure. Falls back to the .md
            // path for pre-.eml buffered payloads (ambiguity → ack, as
            // before).
            const getHeaderEmlPath = (): string | null => {
              if (typeof eml_file_path !== 'string' || !eml_file_path) {
                return getEmlPath();
              }
              if (materializedHeaderEmlPath === undefined) {
                materializedHeaderEmlPath = materializeRawEml(
                  eml_file_path,
                  repoPath,
                  { skipRefresh: mirrorRefreshed },
                );
                mirrorRefreshed = true;
              }
              return materializedHeaderEmlPath;
            };

            const attachmentCount = attachmentCountFrom(attachment_count);
            const attachmentState =
              attachment_state === 'ready' ||
              attachment_state === 'partial' ||
              attachment_state === 'pending'
                ? attachment_state
                : undefined;
            if (phase === 'accepted') {
              if (
                attachmentCount === null ||
                attachmentCount <= HIGH_ATTACHMENT_THRESHOLD
              ) {
                res.writeHead(400);
                res.end('Invalid high-attachment receipt');
                return;
              }
              const preflightAllowlist = getAllowlist();
              const preflightAccess = canProcessEmailSender(
                from,
                preflightAllowlist,
                allowlistFallbackMode,
              );
              if (!preflightAccess.allowed) {
                const unavailable =
                  preflightAccess.reason === 'allowlist unavailable';
                res.writeHead(unavailable ? 503 : 200, {
                  'Content-Type': 'application/json',
                });
                res.end(
                  JSON.stringify({
                    ok: !unavailable,
                    skipped: true,
                    reason: preflightAccess.reason,
                  }),
                );
                return;
              }
              const receiptId =
                (typeof message_id === 'string' &&
                  message_id.replace(/^<|>$/g, '')) ||
                crypto
                  .createHash('sha256')
                  .update(`${from}\n${subject}\n${date}`)
                  .digest('hex');
              const recorded = await recordHighAttachmentReceipt({
                receiptId,
                from: from || 'unknown',
                subject,
                receivedAt: date,
                attachmentCount,
              });
              res.writeHead(recorded ? 202 : 503, {
                'Content-Type': 'application/json',
              });
              res.end(JSON.stringify({ ok: recorded, receiptId }));
              return;
            }

            const emailIdentity = await parseEmailIdentity(getHeaderEmlPath(), {
              subject,
              messageId: message_id,
            });
            const emailSubject = emailIdentity.subject;
            const emailMessageId = emailIdentity.messageId || message_id;
            const replyMessageId = emailIdentity.messageId
              ? `<${emailIdentity.messageId}>`
              : message_id;
            if (emailIdentity.parseFallback) {
              logger.warn(
                { from, subject, eml_file_path },
                'webhook: real email identity unavailable; using payload fallback',
              );
            }

            // Box update notification → ping admin to run a sync sweep, then
            // stop. Handled before the allowlist (see isBoxNotification note)
            // so Box's machine sender isn't dropped as "not on allowlist".
            // Debounced so a burst of faculty saves doesn't spam Telegram.
            if (isBoxNotification(from)) {
              // Optional filename backstop (default-off; see BOX_NOTIFY_WATCH_FILES).
              if (
                BOX_NOTIFY_WATCH_FILES.length > 0 &&
                !BOX_NOTIFY_WATCH_FILES.some((f) =>
                  emailSubject.toLowerCase().includes(f),
                )
              ) {
                logger.info(
                  { from, subject: emailSubject },
                  'Box notification: not a watched file, ignoring',
                );
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: true,
                    skipped: true,
                    reason: 'box-notification-unwatched',
                  }),
                );
                return;
              }
              const now = Date.now();
              if (now - lastBoxPingAt >= BOX_PING_DEBOUNCE_MS) {
                lastBoxPingAt = now;
                await alertAdmin(
                  `📦 Box update detected (from ${from}).\n` +
                    `Subject: ${emailSubject}\n` +
                    `→ Run a Box sync sweep to refresh Coordinator's course data.`,
                );
                logger.info(
                  { from, subject: emailSubject },
                  'Box notification: pinged admin to re-sync',
                );
              } else {
                logger.info(
                  { from, subject: emailSubject },
                  'Box notification: within debounce window, ping suppressed',
                );
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: true,
                  skipped: true,
                  reason: 'box-notification',
                }),
              );
              return;
            }

            // Check sender against allowlist
            const allowlistState = getAllowlist();
            const access = canProcessEmailSender(
              from,
              allowlistState,
              allowlistFallbackMode,
            );
            if (!access.allowed) {
              logger.warn(
                {
                  from,
                  subject: emailSubject,
                  reason: access.reason,
                  allowlistSource: allowlistState.source,
                  fallbackMode: allowlistFallbackMode,
                },
                'Email sender rejected',
              );
              // Leave a repo-visible trail of blocked senders. Skip transient
              // "allowlist unavailable" failures — those aren't unauthorized
              // senders, just a failed read (see CLAUDE.md reliability note).
              if (access.reason === 'sender not on allowlist') {
                logDroppedEmail(from || 'unknown', emailSubject);
                // A blocked **@example.edu** colleague gets one courteous
                // reply instead of a silent drop. External/unknown senders
                // stay silent (anti-backscatter). Deduped + skip automated.
                const key = (from || '').toLowerCase().trim();
                if (
                  key &&
                  isInstitutionSender(from) &&
                  !isLikelyAutomatedAddress(from) &&
                  !blockedNotified.has(key)
                ) {
                  // Reuse the robust header-based auto-reply/list guard BEFORE
                  // emitting outbound mail, so a spoofed or auto-generated EXU
                  // From can't turn a silent drop into backscatter or an
                  // autoresponder loop. (True SPF/DKIM sender-auth isn't
                  // available at this layer; the per-sender dedup caps residual
                  // forged-From backscatter to one notice per address.)
                  let isAuto = false;
                  if (raw_file_path) {
                    try {
                      // null (eml not found anywhere) matches the old
                      // missing-file behavior: isAutoReplyEml is non-throwing
                      // and returns not-auto-reply for an unreadable path.
                      const emlPath = getEmlPath();
                      if (emlPath) {
                        isAuto = (await isAutoReplyEml(emlPath)).isAutoReply;
                      }
                    } catch {
                      isAuto = true; // unreadable → don't risk outbound mail
                    }
                  }
                  if (isAuto) {
                    logger.info(
                      { from, subject: emailSubject },
                      'Access-closed reply suppressed (auto-reply / list / unreadable eml)',
                    );
                  } else {
                    blockedNotified.add(key);
                    if (blockedNotified.size > MAX_BLOCKED_NOTIFIED) {
                      const first = blockedNotified.values().next().value;
                      if (first) blockedNotified.delete(first);
                    }
                    void sendAccessClosedReply(from, emailSubject);
                  }
                }
              }
              const unavailable = access.reason === 'allowlist unavailable';
              res.writeHead(unavailable ? 503 : 200, {
                'Content-Type': 'application/json',
              });
              res.end(
                JSON.stringify({
                  ok: !unavailable,
                  skipped: true,
                  reason: access.reason,
                }),
              );
              return;
            }

            // (A missing sender never reaches this point when the allowlist
            // is available — canProcessEmailSender already rejected it above.)
            if (!allowlistState.available) {
              logger.warn(
                {
                  from,
                  subject: emailSubject,
                  allowlistSource: allowlistState.source,
                  fallbackMode: allowlistFallbackMode,
                },
                'EMAIL_ALLOWLIST.md unavailable, using permissive fallback',
              );
            }

            // Deduplicate: skip if we already processed this email
            const dedupKey =
              emailMessageId || from + ':' + emailSubject + ':' + date;
            if (processedEmails.has(dedupKey)) {
              logger.warn(
                { from, subject: emailSubject, dedupKey },
                'Duplicate email, skipping',
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: true,
                  skipped: true,
                  reason: 'duplicate',
                }),
              );
              return;
            }
            if (processingEmails.has(dedupKey)) {
              logger.warn(
                { from, subject: emailSubject, dedupKey },
                'Email is already processing; asking sender Worker to retry',
              );
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  reason: 'email-processing-in-progress',
                }),
              );
              return;
            }
            processingEmails.add(dedupKey);
            activeDedupKey = dedupKey;

            // Auto-reply / mailing-list loop detection. Drops Outlook OOO,
            // Gmail vacation, list expansions, autoresponders BEFORE we
            // spawn an expensive Coordinator container.
            if (raw_file_path) {
              const emlPath = getEmlPath();
              // null (eml not found anywhere) matches the old missing-file
              // behavior: isAutoReplyEml returns not-auto-reply → proceed.
              const loopCheck = emlPath
                ? await isAutoReplyEml(emlPath)
                : { isAutoReply: false as const, reason: undefined };
              if (loopCheck.isAutoReply) {
                logger.warn(
                  {
                    from,
                    subject: emailSubject,
                    reason: loopCheck.reason,
                    message_id: emailMessageId,
                  },
                  'Email loop guard: rejected auto-reply / list traffic',
                );
                markEmailProcessed(dedupKey);
                activeDedupKey = undefined;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: true,
                    skipped: true,
                    reason: `auto-reply: ${loopCheck.reason}`,
                  }),
                );
                return;
              }
            }

            if (
              attachmentCount !== null &&
              attachmentCount > HIGH_ATTACHMENT_THRESHOLD
            ) {
              const recorded = await recordHighAttachmentReceipt({
                receiptId: dedupKey,
                from: from || 'unknown',
                subject: emailSubject,
                receivedAt: date,
                attachmentCount,
              });
              if (!recorded) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    reason: 'inbound-receipt-write-failed',
                  }),
                );
                return;
              }
              if (
                attachmentState !== 'ready' &&
                attachmentState !== 'partial'
              ) {
                logger.warn(
                  {
                    from,
                    subject: emailSubject,
                    attachmentCount,
                    attachmentState: attachment_state,
                  },
                  'High-attachment manifest is not terminal; asking sender Worker to retry',
                );
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    ok: false,
                    reason: 'attachment-manifest-not-terminal',
                  }),
                );
                return;
              }
            }

            // Per-sender daily turn cap (backstop for misbehaving senders).
            // Non-terminal high-attachment retries return above and do not
            // consume quota; only a manifest that can actually be processed
            // counts as a sender turn.
            const allowlistedPerson = isAllowlistedPerson(from, allowlistState);
            const quota = senderQuota.check(from, allowlistedPerson);
            if (!quota.allowed) {
              logger.warn(
                {
                  from,
                  subject: emailSubject,
                  count: quota.count,
                  cap: quota.cap,
                  allowlistedPerson,
                },
                'Email sender daily turn cap exceeded, dropping',
              );
              markEmailProcessed(dedupKey);
              activeDedupKey = undefined;
              if ((quota.alert || quota.notice) && quota.windowStart !== null) {
                void reportSenderCapReached({
                  from,
                  subject: emailSubject,
                  // Bracketed form, as the normal reply path threads with.
                  messageId: replyMessageId,
                  count: quota.count,
                  cap: quota.cap,
                  allowlistedPerson,
                  windowStart: quota.windowStart,
                  alert: quota.alert,
                  notice: quota.notice,
                  noticeAlreadySent: quota.noticeAlreadySent,
                  allowlistSnapshot: allowlistState,
                }).catch((err) =>
                  logger.error({ err, from }, 'Sender cap report failed'),
                );
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: true,
                  skipped: true,
                  reason: `sender quota exceeded (${quota.count}/${quota.cap} per 24h)`,
                }),
              );
              return;
            }
            if (quota.windowStart !== null) {
              activeQuota = { sender: from, windowStart: quota.windowStart };
            }

            // R1+R2 (G56): recover real To/Cc from the .eml — the Worker's
            // envelope values are lossy (they can show
            // `To: program@example.org` for faculty-addressed mail) — and
            // decide CC-as-context. Non-throwing; every ambiguity acks.
            const messageCcContext = await analyzeCcContext(getHeaderEmlPath());

            // Create a synthetic message for the agent
            const chatJid = deriveEmailChatJid({
              rawFilePath: getHeaderEmlPath() ?? undefined,
              messageId: emailMessageId,
              subject: emailSubject,
              from,
            });
            const messageId = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            // Thread metadata is one slot per chatJid while cc-context is
            // per-message; merge so a thread that ever required an ack can
            // never be flipped silent by a later Cc-only copy.
            const priorMeta = emailMetadata.get(chatJid);
            const ccContext = mergeSuppressDecision(
              priorMeta?.ccContext,
              messageCcContext,
              priorMeta !== undefined,
            );
            if (ccContext.suppressAck) {
              logger.info(
                { from, subject: emailSubject, reason: ccContext.reason },
                'CC-as-context email: ack will be suppressed host-side',
              );
            }

            // Store metadata for reply threading. Insertion-order eviction
            // (same as processedEmails): each entry retains an allowlist +
            // kb-conflict snapshot, so an unbounded map is a slow leak over
            // the PM2 process lifetime. A thread evicted after hundreds of
            // newer threads just loses reply threading it no longer uses.
            emailMetadata.delete(chatJid); // re-insert as most recent
            // The authenticated payload or original Worker .eml commit is
            // intake evidence. Never read body evidence at the mirror's tip.
            const receivedEml =
              typeof raw_email === 'string'
                ? raw_email
                : typeof eml_file_path === 'string' && eml_file_path
                  ? await getRepoReader().readFileAtCreationAsync(eml_file_path)
                  : null;
            const receivedAddresses: string[] = [];
            let receivedText: string | undefined;
            const receivedSources = [
              `From: ${from ?? ''}\nTo: ${to ?? ''}\nCc: ${cc ?? ''}`,
              typeof subject === 'string' ? subject : '',
            ];
            if (typeof inbound_text === 'string')
              receivedSources.push(inbound_text);
            if (receivedEml !== null) {
              try {
                const received = await simpleParser(receivedEml);
                receivedText = received.text ?? undefined;
                receivedSources.push(
                  received.subject ?? '',
                  received.text ?? '',
                  typeof received.html === 'string' ? received.html : '',
                );
                if (typeof received.html === 'string')
                  receivedAddresses.push(
                    ...inboundEmailAddressesInHtml(received.html),
                  );
                // Mailbox headers are structured evidence. Re-scanning their
                // wire representation as prose (especially folded table-like
                // lines) can invent a second, shorter mailbox identity.
                const addressHeaders = new Set<string>();
                for (const [name, header] of received.headers) {
                  for (const field of Array.isArray(header)
                    ? header
                    : [header]) {
                    if (
                      !field ||
                      typeof field !== 'object' ||
                      !('value' in field) ||
                      !Array.isArray(field.value)
                    )
                      continue;
                    addressHeaders.add(name);
                    const mailboxes: EmailAddress[] = [...field.value];
                    while (mailboxes.length) {
                      const mailbox = mailboxes.pop()!;
                      if (mailbox.address)
                        receivedAddresses.push(mailbox.address.toLowerCase());
                      if (mailbox.name)
                        receivedSources.push(`Display name: ${mailbox.name}`);
                      if (mailbox.group) mailboxes.push(...mailbox.group);
                    }
                  }
                }
                for (const header of received.headerLines)
                  if (!addressHeaders.has(header.key))
                    receivedSources.push(header.line);
              } catch (err) {
                logger.warn(
                  { err },
                  'webhook: received email evidence could not be parsed; trusting payload headers only',
                );
              }
            }
            const bodyAddresses = [
              ...new Set([
                // Separate received fields have independent token boundaries.
                // Address-free MIME parts can then use the scanner's fast path
                // instead of inheriting a header's @ and forcing a full scan.
                ...receivedSources.flatMap(inboundEmailAddressesInText),
                ...receivedAddresses,
              ]),
            ];
            // Routed approvals: the host's own copy of what this sender wrote,
            // keyed by the raw path the agent is told to cite.
            routedApprovals.recordEvidence({
              rawPath: raw_file_path || `discussions/raw/${filename}`,
              sender: from,
              subject: emailSubject,
              ...(emailMessageId ? { messageId: emailMessageId } : {}),
              receivedAt: Date.now(),
              texts: [
                typeof inbound_text === 'string' ? inbound_text : '',
                receivedText ?? '',
              ],
            });
            emailMetadata.set(chatJid, {
              bodyAddresses,
              bodyEvidenceVersion: 1,
              from,
              subject: emailSubject,
              message_id: replyMessageId,
              to,
              cc,
              ccContext,
              kbConflictSnapshot: snapshotKbConflictTriage(repoPath),
              allowlistSnapshot: allowlistState,
            });
            if (emailMetadata.size > MAX_EMAIL_METADATA) {
              const oldest = emailMetadata.keys().next().value;
              if (oldest) emailMetadata.delete(oldest);
            }

            // Extract attachments from the .eml file if available
            const attachmentSummaryLines: string[] = [];
            const attachmentPreviewLines: string[] = [];

            if (
              raw_file_path &&
              !(
                attachmentCount !== null &&
                attachmentCount > HIGH_ATTACHMENT_THRESHOLD
              )
            ) {
              try {
                const emlPath = getEmlPath();
                if (!emlPath) {
                  // Same outcome as the old missing-file path: the catch
                  // below logs and extraction is skipped.
                  throw new Error(
                    'raw .eml not found in mirror or live checkout',
                  );
                }
                const attachments = await extractEmailAttachments(emlPath);

                const emailGroup =
                  opts.registeredGroups()['webhook-email@program'];
                const _emailGroupDir = emailGroup
                  ? resolveGroupFolderPath(emailGroup.folder)
                  : null;

                for (const {
                  filename: rawAttachFilename,
                  contentType,
                  buffer,
                } of attachments) {
                  const attachFilename = safeAttachmentName(
                    rawAttachFilename,
                    'eml-attachment',
                    (raw, repl) =>
                      logger.warn(
                        { rawName: raw, replacement: repl, raw_file_path },
                        'webhook: refused unsafe attachment filename',
                      ),
                  );
                  try {
                    const isImage =
                      contentType?.startsWith('image/') ||
                      /\.(jpg|jpeg|png|gif|webp)$/i.test(attachFilename);

                    if (isImage) {
                      // Skip images entirely — email images are almost always
                      // inline logos, signatures, or decorative elements with no
                      // curriculum value. Saving them creates noisy git commits
                      // ("Add attachment: image.png") and disk bloat.
                      // If a meaningful image is ever needed, it should be sent
                      // as a document attachment, not an inline email image.
                      logger.debug(
                        { attachFilename, contentType },
                        'webhook: skipping image attachment (no curriculum value)',
                      );
                      continue;
                    }

                    const extraction = await extractDocument(
                      buffer,
                      attachFilename,
                    );

                    // Derive save path: strip .eml extension, append -<filename>.extracted.md
                    const emlBase = raw_file_path.replace(/\.eml$/i, '');
                    const saveRelPath = `${emlBase}-${attachFilename}.extracted.md`;
                    const savePath = join(repoPath, saveRelPath);

                    await saveExtraction(
                      extraction.fullText,
                      savePath,
                      repoPath,
                    );

                    // Build summary line
                    const sheetInfo =
                      extraction.sheets && extraction.sheets.length > 0
                        ? ` (${extraction.sheets.length} sheets: ${extraction.sheets.join(', ')})`
                        : '';
                    attachmentSummaryLines.push(
                      `- ${attachFilename} → ${saveRelPath}${sheetInfo}`,
                    );

                    // Build preview section
                    attachmentPreviewLines.push(
                      `---`,
                      `**Preview: ${attachFilename}**`,
                      extraction.preview,
                    );
                  } catch (attachErr) {
                    logger.warn(
                      { err: attachErr, attachFilename },
                      'webhook: failed to extract attachment, skipping',
                    );
                  }
                }
              } catch (emlErr) {
                logger.warn(
                  { err: emlErr, raw_file_path },
                  'webhook: failed to read .eml for attachment extraction, skipping',
                );
              }
            }

            const content = [
              `Process this email that was just committed to the repo:`,
              ``,
              `**File:** ${raw_file_path || `discussions/raw/${filename}`}`,
              `**Subject:** ${emailSubject}`,
              `**From:** ${from}`,
              `**To:** ${ccContext.realTo ?? to}`,
              (ccContext.realCc ?? cc)
                ? `**CC:** ${ccContext.realCc ?? cc}`
                : '',
              `**Date:** ${date}`,
              emailMessageId ? `**Message-ID:** ${emailMessageId}` : '',
              ...(attachmentSummaryLines.length > 0
                ? [``, `**Attachments extracted:**`, ...attachmentSummaryLines]
                : []),
              ...(attachmentPreviewLines.length > 0
                ? [``, ...attachmentPreviewLines]
                : []),
              ...(attachmentCount !== null &&
              attachmentCount > HIGH_ATTACHMENT_THRESHOLD
                ? [
                    ``,
                    `**High-attachment handling:** ${attachmentCount} attachments were accepted. They are not expanded into this prompt; use the committed message manifest and inspect only the files needed for the task.`,
                    ...(attachmentState === 'partial'
                      ? [
                          `**Attachment status:** The attachment manifest is partial. Do not assume every file was stored; disclose and preserve every manifest failure.`,
                        ]
                      : []),
                  ]
                : []),
              ...(ccContext.suppressAck
                ? [
                    ``,
                    `**CC-as-context (G56):** Coordinator is only CC'd on this email and it contains no direct request to Coordinator — it is context, not a question for you. Read and file it per your instructions exactly as usual (KB extraction, commits). You must still end with the required <reply> block (a brief filing summary), but the host will record it without emailing anyone — so address it to no one and do NOT compose an audience-facing reply or introduce yourself to the recipients.`,
                  ]
                : []),
              ``,
              `Read the file, classify as update or question, and process according to your instructions.`,
            ]
              .filter((line) => line !== null && line !== undefined)
              .join('\n');

            // Deliver as inbound message
            opts.onChatMetadata(
              chatJid,
              new Date().toISOString(),
              'Program Email',
              'webhook',
              false,
            );
            opts.onMessage(
              chatJid,
              {
                id: messageId,
                chat_jid: chatJid,
                sender: from || 'unknown',
                sender_name: from || 'Unknown',
                content,
                timestamp: new Date().toISOString(),
              },
              snapshotEmailDeliveryContext(chatJid),
            );
            markEmailProcessed(dedupKey);
            activeDedupKey = undefined;
            activeQuota = undefined;

            logger.info(
              { filename, subject: emailSubject, from },
              'Webhook email received',
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, messageId }));
          } catch (err: any) {
            if (activeDedupKey) processingEmails.delete(activeDedupKey);
            if (activeQuota) {
              senderQuota.rollback(activeQuota.sender, activeQuota.windowStart);
              activeQuota = undefined;
            }
            const invalidJson = err instanceof SyntaxError;
            logger.error(
              { err },
              invalidJson ? 'Webhook parse error' : 'Webhook processing error',
            );
            res.writeHead(invalidJson ? 400 : 503);
            res.end(invalidJson ? 'Invalid JSON' : 'Email processing failed');
          } finally {
            if (activeDedupKey) processingEmails.delete(activeDedupKey);
            // Only mirror reads create a temp copy; a live-checkout
            // fallback path lives inside the repo and must not be deleted.
            for (const tmp of [
              materializedEmlPath,
              materializedHeaderEmlPath,
            ]) {
              if (tmp && tmp.startsWith(os.tmpdir())) {
                try {
                  fs.unlinkSync(tmp);
                } catch {
                  // best-effort cleanup; temp dir is OS-managed anyway
                }
              }
            }
          }
        });
      });

      return new Promise<void>((resolve, reject) => {
        server!.listen(WEBHOOK_PORT, WEBHOOK_HOST, async () => {
          connected = true;
          // index.ts starts the outbox (which replays queued mail) only after
          // connect() resolves: cancel relays for entries closed while down.
          await routedApprovals.reconcileBeforeReplay();
          routedApprovals.start();
          // First scan once startup settles; hourly after that.
          setTimeout(() => void routedApprovals.scanSoon(), 60_000).unref();
          logger.info(
            {
              port: WEBHOOK_PORT,
              host: WEBHOOK_HOST,
              allowlistSize: peekAllowlist().senders.size,
              allowlistAvailable: peekAllowlist().available,
              allowlistFallbackMode,
            },
            'Webhook channel listening',
          );
          resolve();
        });
        server!.on('error', reject);
      });
    },

    snapshotDeliveryContext(jid: string): EmailDeliveryContextV1 | undefined {
      return snapshotEmailDeliveryContext(jid);
    },

    restoreDeliveryContext: restoreEmailDeliveryContext,

    async prepareDelivery(
      jid: string,
      text: string,
      deliveryId: string,
      gateContext?: DeliveryGateContext,
    ) {
      const meta = emailMetadata.get(jid);

      if (!resendEnv.RESEND_API_KEY && getOutboundMailProvider() !== 'smtp') {
        logger.warn({ jid }, 'RESEND_API_KEY not set, reply not sent');
        return {
          status: 'failed' as const,
          reason: 'resend-api-key-missing',
          retryable: false as const,
        };
      }

      if (!meta?.from) {
        // Reachable after a restart or if the thread's entry aged past the
        // emailMetadata cap while an agent run was still in flight.
        // We no longer know who to reply to, so losing the reply is
        // forced — losing it SILENTLY is not (G46): alert the owner.
        reportDeliveryShortfall({
          channel: 'email',
          context: `webhook sendMessage: ${jid}`,
          intended: ['<unknown — email metadata missing>'],
          sent: [],
          missed: ['<unknown — email metadata missing>'],
          reason: 'email-metadata-missing (restart or cap eviction)',
        });
        return {
          status: 'failed' as const,
          reason: 'email-metadata-missing',
          retryable: false as const,
        };
      }

      // Agent-to-agent guard: never reply via email to PeerAgent Agent.
      // PeerAgent sends status updates / PR notifications for Coordinator to process,
      // but does not expect or handle email replies. Replying triggers an
      // 11-iteration reply loop. Process the inbound message normally but
      // drop the outbound email reply silently.
      if (AGENT_INBOX_ADDRESSES.includes(meta.from.toLowerCase())) {
        logger.info(
          { jid, from: meta.from },
          'webhook: suppressing email reply to agent-inbox sender (no reply path for agent-to-agent)',
        );
        return {
          status: 'suppressed' as const,
          reason: 'agent-inbox-no-reply',
          outcomeId: deliveryId,
        };
      }

      // CC-as-context suppression (G56): the agent processed and filed the
      // mail and produced its gate-required <reply>; the host records it and
      // sends nothing. Must be host-side — a prompt-only "don't reply" would
      // make the delivery gate refuse the missing block and enter repair
      // (G46). Surfaces as a [CC-CONTEXT] audit entry → daily digest line.
      if (meta.ccContext?.suppressAck) {
        logger.info(
          { jid, from: meta.from, reason: meta.ccContext.reason },
          'webhook: suppressing ack for CC-as-context email (G56)',
        );
        return {
          status: 'suppressed' as const,
          reason: meta.ccContext.reason,
          outcomeId: deliveryId,
          suppressionKind: 'cc-context' as const,
        };
      }

      const replySubject = meta.subject.startsWith('Re:')
        ? meta.subject
        : `Re: ${meta.subject}`;

      // Defense-in-depth behind the orchestrator's gateEmailOutbound: callers
      // that bypass the streaming callback (IPC sends, scheduler) must never
      // put literal <reply> tags or known scaffolding on the wire. The
      // composition lives in delivery-gate.ts (gateDirectSend) so a new leak
      // signature reaches this backstop too — not just the profiles.
      const turnAllowlist =
        gateContext?.allowlist ?? meta.allowlistSnapshot ?? peekAllowlist();
      const trustedBodyAddresses = trustedBodyAddressesFromContext({
        allowlist: turnAllowlist,
        trustedBodyAddresses:
          gateContext?.trustedBodyAddresses ??
          (meta.bodyEvidenceVersion === 1 ? (meta.bodyAddresses ?? []) : []),
        inboundText: [...(gateContext?.inboundText ?? []), meta.from],
      });
      const gate = gateDirectSend(text, {
        allowlist: turnAllowlist,
        trustedBodyAddresses,
        sendFromEmail:
          gateContext?.sendFromEmail ??
          resendEnv.SEND_FROM_EMAIL ??
          DEFAULT_BOT_EMAIL,
        legacySavedDeliveryId: gateContext?.legacySavedDeliveryId,
      });
      if (!gate.ok) {
        logger.error(
          {
            jid,
            to: meta.from,
            reason: formatGateRefusal(gate),
            sample: text.slice(0, 160),
          },
          'webhook: refusing outbound email (empty, malformed, or scaffolding body)',
        );
        return {
          status: 'failed' as const,
          reason: `email-gate-refused: ${formatGateRefusal(gate)}`,
          retryable: false as const,
        };
      }
      const body = gate.text;

      const kbTriageCc = resolveKbTriageApproverCc({
        repoPath,
        before: meta.kbConflictSnapshot,
        allowlistContent: await getRepoReader().readFileAsync(
          'program/EMAIL_ALLOWLIST.md',
        ),
        senderEmail: meta.from,
      });

      // G58: replies to header-verified direct mail keep the inbound
      // thread's audience. The allowlist is the spam boundary — only
      // addresses already on EMAIL_ALLOWLIST.md are CC'd; drops are
      // disclosed in a note appended to the reply body (never a silent
      // partial audience) and recorded on the [OUTBOUND EMAIL] audit entry.
      const mirror = mirrorReplyCc({
        ccContext: meta.ccContext,
        sender: meta.from,
        allowlistState: turnAllowlist,
        fallbackMode: allowlistFallbackMode,
      });
      const ccAll = [...mirror.cc];
      if (
        kbTriageCc &&
        !ccAll.some((a) => a.toLowerCase() === kbTriageCc.toLowerCase())
      ) {
        ccAll.push(kbTriageCc);
      }
      const bodyOut = mirror.note ? `${body}\n\n${mirror.note}` : body;

      // Replies go through the sendOutboundEmail choke point that G22/G46
      // enforcement lives in, so there is one send path. The choke point
      // strips markdown (HTML stays disabled),
      // threads via inReplyTo, allowlist-checks the recipient against the
      // channel's TTL-cached state (never a sync git fetch on this path —
      // the sender already cleared the same check inbound), reports any
      // shortfall loudly, and writes the authoritative [OUTBOUND EMAIL]
      // audit record (recipient/subject/Resend ID, success-only — the
      // conversational channel log cannot corroborate delivery).
      const payload: PreparedEmailReply = {
        email: {
          to: meta.from,
          ...(ccAll.length ? { cc: ccAll.join(', ') } : {}),
          subject: replySubject,
          body: bodyOut,
        },
        options: {
          sourceGroup: jid,
          ...(gateContext?.legacySavedDeliveryId
            ? {}
            : { trustedBodyAddresses }),
          ...(mirror.note ? { hostAddedBodySuffix: mirror.note } : {}),
          forceBotReplyTo: true,
          deferAudit: true,
          ...(mirror.dropped.length
            ? {
                ccDroppedNote: mirror.dropped
                  .map((d) => `${d.address} (${d.reason})`)
                  .join('; '),
              }
            : {}),
          ...(meta.message_id ? { inReplyTo: meta.message_id } : {}),
          // The snapshot that admitted THIS message; peekAllowlist() only as
          // a fallback for metadata written before this field existed.
          allowlistState: {
            ...turnAllowlist,
            senders: [...turnAllowlist.senders].sort(),
          },
          // Mirror the inbound decision: mail accepted under permissive
          // fallback must not have its reply refused at send time.
          allowlistFallbackMode,
        },
      };

      return {
        status: 'prepared' as const,
        delivery: {
          channel: 'webhook',
          deliveryId,
          jid,
          payload,
        },
      };
    },

    async deliverPrepared(delivery: PreparedDelivery) {
      if (
        delivery.channel !== 'webhook' ||
        !delivery.payload ||
        typeof delivery.payload !== 'object'
      ) {
        return {
          status: 'failed' as const,
          reason: 'invalid-email-delivery',
          retryable: false,
        };
      }
      const payload = delivery.payload as Partial<PreparedEmailReply>;
      if (
        !payload.email ||
        typeof payload.email.to !== 'string' ||
        typeof payload.email.subject !== 'string' ||
        typeof payload.email.body !== 'string' ||
        !payload.options ||
        typeof payload.options.sourceGroup !== 'string' ||
        (Object.hasOwn(payload.options, 'trustedBodyAddresses') &&
          (!Array.isArray(payload.options.trustedBodyAddresses) ||
            !payload.options.trustedBodyAddresses.every(
              (address) => typeof address === 'string',
            ))) ||
        (payload.options.allowlistState !== undefined &&
          (typeof payload.options.allowlistState.available !== 'boolean' ||
            typeof payload.options.allowlistState.source !== 'string' ||
            !Array.isArray(payload.options.allowlistState.senders) ||
            !payload.options.allowlistState.senders.every(
              (sender) => typeof sender === 'string',
            )))
      ) {
        return {
          status: 'failed' as const,
          reason: 'invalid-email-delivery',
          retryable: false,
        };
      }

      const { allowlistState: serializedAllowlistState, ...sendOptions } =
        payload.options;
      const result = await sendOutboundEmailResult(payload.email, {
        ...sendOptions,
        deliveryId: delivery.deliveryId,
        ...(!Object.hasOwn(payload.options, 'trustedBodyAddresses')
          ? { legacySavedDeliveryId: delivery.deliveryId }
          : {}),
        ...(serializedAllowlistState
          ? {
              allowlistState: {
                ...serializedAllowlistState,
                senders: new Set(serializedAllowlistState.senders),
              },
            }
          : {}),
      });
      if (result.status === 'sent') {
        logger.info(
          { jid: delivery.jid, to: payload.email.to, cc: payload.email.cc },
          'Reply email sent via outbound choke point',
        );
        return {
          status: 'sent' as const,
          providerId: result.resendId,
        };
      } else {
        // sendOutboundEmail has already logged the cause and fired the G46
        // shortfall alert naming the recipient.
        logger.error(
          { jid: delivery.jid, to: payload.email.to },
          'Failed to send reply email',
        );
        return {
          status: 'failed' as const,
          reason: result.reason,
          retryable: result.retryable,
        };
      }
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return (
        jid === 'webhook-email@program' || jid.startsWith('webhook-email:')
      );
    },

    async disconnect() {
      routedApprovals.stop();
      if (server) {
        server.close();
        connected = false;
      }
    },
  };

  return channel;
});
