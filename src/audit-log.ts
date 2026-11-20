/**
 * Audit Log for Program Communication Pipeline
 *
 * Appends every inbound message + agent response to daily log files
 * in the program-repo repo: discussions/audit-log/YYYY-MM-DD.md
 *
 * The files are written in the HOST-OWNED repository (host-repo.ts), not in
 * the agent's checkout: the agent cannot change an entry before it is
 * committed, and the host commits and pushes without running git in a tree
 * the agent can write. The agent sees the log after its next pull.
 *
 * Commits are batched — written to disk immediately, committed periodically.
 */
import path from 'path';

import {
  makeSensorId,
  placeholderFor,
  runBehaviourSensor,
  sensorEmailRepliesEnabled,
} from './behaviour-sensor.js';
import { channelFromJid, webChatSessionIdFromJid } from './channel-utils.js';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';
import { BOT_GIT_AUTHOR_EMAIL } from './instance-identity.js';
import { localDateYmd, localTimeHms } from './timezone.js';
import {
  ensureHostRepo,
  getHostRepoPath,
  syncHostRepo,
  type SyncResult,
} from './host-repo.js';
import { appendToCheckout, checkoutHasLine } from './checkout-fs.js';

const COMMIT_INTERVAL = 5 * 60 * 1000; // Commit every 5 minutes

let pendingWrites = 0;
let commitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Root of the host-owned repository, created on first use. Resolved lazily
 * (not a module const) so tests can stub PROGRAM_HOST_REPO after import.
 */
function auditRoot(): string {
  ensureHostRepo();
  return getHostRepoPath();
}

function auditDir(): string {
  return path.join(getHostRepoPath(), 'discussions', 'audit-log');
}

/** Truncation cap for chat-entry bodies (inbound + outbound). */
function truncateBody(text: string): string {
  return text.length > 2000 ? text.slice(0, 2000) + '\n\n*[truncated]*' : text;
}

/**
 * Append one entry to a daily audit file and schedule the batched commit —
 * the frame shared by every entry writer. `lines` are the entry's lines up
 * to (not including) the closing `---` rule, which is added here; writers
 * whose entries end with a blank line or a sensor placeholder include it as
 * their last line. Returns the file written (the sensor hook needs it), or
 * null when the write failed (already logged under `errLabel`).
 */
function appendAuditEntry(
  lines: string[],
  errLabel: string,
  file?: string,
): string | null {
  try {
    const dir = auditDir();
    const target = file ?? path.join(dir, `${localDateYmd(TIMEZONE)}.md`);
    // As the repo's owner, never root, so git (which runs as that owner)
    // can commit the file.
    appendToCheckout(auditRoot(), target, [...lines, '---', ''].join('\n'));
    pendingWrites++;
    scheduleCommit();
    return target;
  } catch (err) {
    logger.warn({ err }, `Audit log: failed to write ${errLabel} entry`);
    return null;
  }
}

export type AuditWriteResult = 'written' | 'already-recorded' | 'write-failed';

function singleLine(value: string, max = 500): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, max);
}

function inspectMarker(
  marker: string,
  onlyFile?: string,
): 'recorded' | 'not-recorded' | 'inspection-failed' {
  try {
    // When the entry's target file is known and stable across retries (e.g.
    // terminal commits keyed by commit date), inspecting that one file
    // avoids a full directory sweep on the event loop per call.
    // Read as the checkout owner: a planted FIFO or link in the
    // container-writable audit dir must not block or redirect a root read.
    return checkoutHasLine(auditRoot(), onlyFile ?? auditDir(), marker)
      ? 'recorded'
      : 'not-recorded';
  } catch (err) {
    // Fail closed: if durable history cannot be checked, do not append a
    // record that could falsely represent a second outcome as distinct.
    logger.warn({ err }, 'Audit log: failed to inspect idempotency markers');
    return 'inspection-failed';
  }
}

function appendAuditEntryOnce(
  marker: string,
  lines: string[],
  errLabel: string,
  file?: string,
  opts?: { inspectOnlyTargetFile?: boolean },
): AuditWriteResult {
  const inspection = inspectMarker(
    marker,
    opts?.inspectOnlyTargetFile ? file : undefined,
  );
  if (inspection === 'recorded') return 'already-recorded';
  if (inspection === 'inspection-failed') return 'write-failed';
  return appendAuditEntry([...lines, marker], errLabel, file)
    ? 'written'
    : 'write-failed';
}

let asyncAuditWriteChain: Promise<void> = Promise.resolve();

/** Serialize async idempotent writes so two concurrent receipts cannot both
 * pass marker inspection before either append becomes visible. */
function serializeAuditWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = asyncAuditWriteChain.then(operation, operation);
  asyncAuditWriteChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function appendAuditEntryOnceAsync(
  marker: string,
  lines: string[],
  errLabel: string,
): Promise<AuditWriteResult> {
  return serializeAuditWrite(async () => {
    try {
      const dir = auditDir();
      if (checkoutHasLine(auditRoot(), dir, marker)) return 'already-recorded';
      const target = path.join(dir, `${localDateYmd(TIMEZONE)}.md`);
      appendToCheckout(
        auditRoot(),
        target,
        [...lines, marker, '---', ''].join('\n'),
      );
      pendingWrites++;
      scheduleCommit();
      return 'written';
    } catch (err) {
      logger.warn({ err }, `Audit log: failed to write ${errLabel} entry`);
      return 'write-failed';
    }
  });
}

/**
 * Log an inbound message.
 */
export function logInbound(
  jid: string,
  senderName: string,
  content: string,
): void {
  const time = localTimeHms(TIMEZONE);
  const sessionId = webChatSessionIdFromJid(jid);
  const headerLines = [
    `### ${time} — ${channelFromJid(jid)} — inbound`,
    `**From:** ${senderName}`,
  ];
  if (sessionId) headerLines.push(`**Session:** ${sessionId}`);
  appendAuditEntry([...headerLines, '', truncateBody(content), ''], 'inbound');
}

/**
 * Minimal durable evidence that the email Worker handed a message to the
 * host before high-volume attachment storage begins. The later conversational
 * inbound entry remains the full processing record; this receipt is the
 * recovery anchor when that later stage never arrives.
 */
export async function logInboundEmailReceiptOnce(args: {
  receiptId: string;
  from: string;
  subject: string;
  receivedAt?: string;
  attachmentCount: number;
}): Promise<AuditWriteResult> {
  const marker = `**Receipt-ID:** ${singleLine(args.receiptId, 200)}`;
  return appendAuditEntryOnceAsync(
    marker,
    [
      `### ${localTimeHms(TIMEZONE)} — email — inbound receipt`,
      `**[EMAIL INTAKE RECEIPT]** accepted; attachment storage and agent processing may still be pending`,
      `**From:** ${singleLine(args.from || 'unknown')}`,
      `**Subject:** ${singleLine(args.subject || 'unknown')}`,
      `**Received:** ${singleLine(args.receivedAt || 'unknown')}`,
      `**Attachments:** ${args.attachmentCount}`,
      '',
    ],
    'inbound-email-receipt',
  );
}

/**
 * Log an inbound email that was dropped because the sender is not on the
 * allowlist. Gives a repo-visible trail of who tried to reach Coordinator and was
 * blocked — the only record otherwise is an ephemeral PM2 console warning.
 * Intentionally NOT called for transient "allowlist unavailable" failures.
 */
export function logDroppedEmail(
  from: string,
  subject: string,
  senderAuthentication?: string,
): void {
  appendAuditEntry(
    [
      `### ${localTimeHms(TIMEZONE)} — email — dropped (not on allowlist)`,
      // One line each: a decoded subject can hold line breaks, and a second
      // line could be written to look like another entry.
      `**From:** ${singleLine(from)}`,
      `**Subject:** ${singleLine(subject)}`,
      ...(senderAuthentication
        ? [`**Sender authentication:** ${singleLine(senderAuthentication)}`]
        : []),
      '',
    ],
    'dropped-email',
  );
}

/**
 * The sender-authentication verdict for one inbound email
 * (`src/email-auth.ts`). Written for every message that passes the
 * allowlist, in both modes. `[EMAIL AUTH]` is the marker to search for;
 * "unauthenticated" means the From address may be forged.
 */
export function logEmailAuthentication(args: {
  from: string;
  subject: string;
  messageId?: string;
  verdict: string;
  reason: string;
  mode: string;
  /** enforce mode only: the message was dropped for this verdict. */
  blocked?: boolean;
}): void {
  appendAuditEntry(
    [
      `### ${localTimeHms(TIMEZONE)} — email — ${
        args.blocked
          ? 'dropped (sender not authenticated)'
          : 'sender authentication'
      }`,
      `**[EMAIL AUTH]** ${args.verdict} — ${singleLine(args.reason)} (mode: ${args.mode})`,
      `**From:** ${singleLine(args.from || 'unknown')}`,
      `**Subject:** ${singleLine(args.subject || 'unknown')}`,
      ...(args.messageId
        ? [`**Message-ID:** ${singleLine(args.messageId, 200)}`]
        : []),
      '',
    ],
    'email-auth',
  );
}

/**
 * Log a CC-as-context ack suppression (G56). The message was
 * processed and filed normally; only the outbound ack was withheld because
 * the bot was Cc'd for context, not asked anything. `[CC-CONTEXT]` is the
 * greppable marker the daily digest's summary line is built from — the
 * digest line is the only place these surface, by design.
 */
export function logCcContextSuppression(args: {
  from: string;
  subject: string;
  reason: string;
}): void {
  appendAuditEntry(
    [
      `### ${localTimeHms(TIMEZONE)} — email — [CC-CONTEXT] ack suppressed`,
      `**From:** ${args.from}`,
      `**Subject:** ${args.subject}`,
      `**Reason:** ${args.reason}`,
      '',
    ],
    'cc-context',
  );
}

/** Idempotent G56 suppression evidence for the restart-safe delivery path. */
export function logCcContextSuppressionOnce(args: {
  outcomeId: string;
  sender?: string;
  subject?: string;
  reason: string;
}): AuditWriteResult {
  const marker = `**Outcome-ID:** ${singleLine(args.outcomeId, 200)}`;
  return appendAuditEntryOnce(
    marker,
    [
      `### ${localTimeHms(TIMEZONE)} — email — [CC-CONTEXT] ack suppressed`,
      `**From:** ${singleLine(args.sender ?? 'unknown')}`,
      `**Subject:** ${singleLine(args.subject ?? 'unknown')}`,
      `**Reason:** ${singleLine(args.reason)}`,
      marker,
      '',
    ],
    'cc-context',
  );
}

/**
 * Log a delivery problem reported by the Resend webhook (bounce, complaint,
 * failure). The Telegram admin ping is ephemeral; this is the durable,
 * repo-visible record tying the problem to the [OUTBOUND EMAIL] entry via the
 * Resend ID, so bad addresses / filter blocks can be traced and corrected in
 * EMAIL_ALLOWLIST.md.
 */
export function logDeliveryProblem(args: {
  type: string;
  to?: string;
  subject?: string;
  resendId?: string;
  reason?: string;
}): AuditWriteResult {
  const lines = [
    `### ${localTimeHms(TIMEZONE)} — email — delivery problem`,
    `**[DELIVERY PROBLEM]** ${args.type} | To: ${args.to ?? 'unknown'} | Subject: ${args.subject ?? 'unknown'}`,
    `**Resend ID:** ${args.resendId ?? 'unknown'} | **Reason:** ${args.reason ?? 'unspecified'}`,
    '',
  ];
  // Idempotent when Resend supplies an event identity: the webhook handler
  // 5xxes on transient owner-ping failures to get Svix retries, and each
  // retry re-runs this — the durable record must be written exactly once.
  // The outcome is returned so a caller with its own retry (the delivery
  // check) can retry a failed write.
  if (args.resendId) {
    return appendAuditEntryOnce(
      `**Delivery-Problem-ID:** ${singleLine(`${args.type}:${args.resendId}`, 200)}`,
      lines,
      'delivery-problem',
    );
  }
  return appendAuditEntry(lines, 'delivery-problem')
    ? 'written'
    : 'write-failed';
}

/**
 * Log a successful outbound email sent via send_email / outbound-email.ts.
 *
 * Written host-side after a confirmed Resend API success — not from Coordinator's
 * self-report. This is the authoritative record the behaviour sensor checks
 * when corroborating pilot-log claims like "sent email to X".
 *
 * Format is intentionally distinct from logOutbound() so grep/sensor can
 * match [OUTBOUND EMAIL] entries without false-positives from chat replies.
 *
 * The full body is recorded untruncated: unlike inbound email (whose raw .eml
 * is committed to git and referenced by path), the outbound body has no other
 * durable copy in the repo — this entry is the only git-tracked record of what
 * Coordinator actually sent. Callers pass the markdown-stripped text that went to
 * Resend, so the entry matches the payload the recipient received.
 */
interface OutboundEmailAuditArgs {
  to: string;
  cc?: string;
  /** G58: thread-audience CCs dropped by the allowlist before the send. */
  ccDropped?: string;
  subject: string;
  sourceGroup: string;
  resendId: string;
  body: string;
  deliveryId?: string;
}

function outboundEmailLines(args: OutboundEmailAuditArgs): string[] {
  const ccPart =
    (args.cc ? ` | CC: ${args.cc}` : '') +
    (args.ccDropped ? ` | CC-dropped: ${args.ccDropped}` : '');
  return [
    `### ${localTimeHms(TIMEZONE)} — email — outbound`,
    `**[OUTBOUND EMAIL]** To: ${args.to}${ccPart} | Subject: ${args.subject}`,
    `**Source:** ${args.sourceGroup || 'unknown'} | **Resend ID:** ${args.resendId}`,
    '',
    args.body,
    '',
  ];
}

/**
 * What the reply sensor needs to check an email reply: the reply text the
 * delivery gate accepted and the message it answers. Only the reply delivery
 * path passes it; mail from the send_email tool, operator alerts and
 * scheduled mail are not replies and are never checked (the chat path does
 * not check its counterparts either).
 */
export interface EmailReplySensorInput {
  replyText: string;
  requestContext?: string;
}

/**
 * `reply` is given for a delivered reply. With SENSOR_EMAIL_REPLIES on, the
 * entry then carries a sensor line and the sensor runs once, after the entry
 * is written: a retry of the same delivery finds the Delivery-ID and starts
 * nothing. With the setting off (the default) the entry is unchanged and no
 * request is made. The sensor never changes the result returned here.
 */
export function logOutboundEmailOnce(
  args: OutboundEmailAuditArgs & { deliveryId: string },
  reply?: EmailReplySensorInput,
): AuditWriteResult {
  const marker = `**Delivery-ID:** ${singleLine(args.deliveryId, 200)}`;
  if (!reply || !sensorEmailRepliesEnabled()) {
    return appendAuditEntryOnce(
      marker,
      outboundEmailLines(args),
      'outbound-email',
    );
  }
  const inspection = inspectMarker(marker);
  if (inspection === 'recorded') return 'already-recorded';
  if (inspection === 'inspection-failed') return 'write-failed';
  const sensorId = makeSensorId(localTimeHms(TIMEZONE));
  const file = appendAuditEntry(
    [...outboundEmailLines(args), placeholderFor(sensorId), marker],
    'outbound-email',
  );
  if (!file) return 'write-failed';
  // Fire-and-forget, as for chat: the mail is already sent and audited.
  runBehaviourSensor(
    reply.replyText,
    file,
    sensorId,
    undefined,
    reply.requestContext,
  ).catch((err) => logger.warn({ err }, 'Behaviour sensor: unhandled error'));
  return 'written';
}

export function logOutboundEmail(args: OutboundEmailAuditArgs): void {
  if (args.deliveryId) {
    logOutboundEmailOnce({ ...args, deliveryId: args.deliveryId });
    return;
  }
  appendAuditEntry(outboundEmailLines(args), 'outbound-email');
}

/**
 * Log one operator alert posted to the Teams route (admin-alert.ts), the
 * counterpart of the `[OUTBOUND EMAIL]` entry the email route writes. Only
 * a delivered post is logged, as on the email route. `text` is the text as
 * posted (after any truncation for the size limit). The workflow URL is a
 * credential and is never passed here.
 */
export function logAdminAlertTeams(args: {
  text: string;
  status: number;
  truncated: boolean;
}): void {
  appendAuditEntry(
    [
      `### ${localTimeHms(TIMEZONE)} — teams — outbound`,
      `**[ADMIN ALERT TEAMS]** Accepted: HTTP ${args.status}${args.truncated ? ' | Truncated: yes' : ''}`,
      `**Source:** admin-alert`,
      '',
      args.text,
      '',
    ],
    'admin-alert-teams',
  );
}

/** Cap on the embedded gate-verdict JSON in a gate-result entry. */
const GATE_RESULT_JSON_CAP = 8000;

/**
 * Log a KB-gate run's machine verdict (G51 phase 1 — self-claims
 * verification). The container agent reports each gate script run
 * (kb-conflict-check ingestion cross-check, kb-entry-gate) through IPC
 * (`log_gate_result`, see ipc.ts); this writes the durable, host-visible
 * counterpart in the daily audit-log file. A reply claiming "gate result:
 * clean" must have a matching [GATE RESULT] entry here — a claim without
 * one is unverified.
 *
 */
export function logGateResult(args: {
  sourceGroup: string;
  gate: string;
  script?: string;
  status: string;
  exitCode?: number;
  entryHeading?: string;
  result?: unknown;
}): void {
  const clean = (s: string, max: number) =>
    s.replace(/[\r\n]+/g, ' ').slice(0, max);
  const gate = clean(String(args.gate), 100);
  const status = clean(String(args.status), 200);
  const exitPart =
    args.exitCode === undefined ? '' : ` (exit ${Number(args.exitCode)})`;
  const scriptPart = args.script
    ? ` | Script: ${clean(String(args.script), 120)}`
    : '';

  let resultJson = '';
  if (args.result !== undefined) {
    try {
      resultJson = JSON.stringify(args.result, null, 2);
      if (resultJson.length > GATE_RESULT_JSON_CAP) {
        resultJson =
          resultJson.slice(0, GATE_RESULT_JSON_CAP) + '\n… [truncated]';
      }
    } catch {
      resultJson = '(unserializable result)';
    }
  }

  appendAuditEntry(
    [
      `### ${localTimeHms(TIMEZONE)} — gate — ${gate}`,
      `**[GATE RESULT]** Group: ${clean(args.sourceGroup, 100)}${scriptPart} | Status: ${status}${exitPart}`,
      ...(args.entryHeading
        ? [`**Entry:** ${clean(String(args.entryHeading), 300)}`]
        : []),
      ...(resultJson ? ['', '```json', resultJson, '```'] : []),
      '',
    ],
    'gate-result',
  );
}

/**
 * Routed approval step (G42 Tier 2 email-group relay): recorded, held, a
 * relay sent or failed, closed, removed. Names the parent entry, as G42
 * requires of every Tier 2 send. The relay email itself also gets its
 * ordinary [OUTBOUND EMAIL] entry from the send choke point.
 */
export function logRoutedApproval(args: {
  action: string;
  key: string;
  title: string;
  detail: string;
}): void {
  const clean = (s: string, max: number) =>
    s.replace(/[\r\n]+/g, ' ').slice(0, max);
  appendAuditEntry(
    [
      `### ${localTimeHms(TIMEZONE)} — routed approval — ${clean(args.action, 80)}`,
      `**[ROUTED APPROVAL]** Entry: ${clean(args.title, 300)} | Raw: ${clean(args.key, 300)}`,
      `**Detail:** ${clean(args.detail, 500)}`,
      '',
    ],
    'routed-approval',
  );
}

/**
 * Log an outbound agent reply.
 */
export function logOutbound(jid: string, replyText: string): void {
  const time = localTimeHms(TIMEZONE);
  const sessionId = webChatSessionIdFromJid(jid);
  const sensorId = makeSensorId(time);
  const headerLines = [
    `### ${time} — ${channelFromJid(jid)} — outbound`,
    `**From:** Program Agent`,
  ];
  if (sessionId) headerLines.push(`**Session:** ${sessionId}`);
  const file = appendAuditEntry(
    [...headerLines, '', truncateBody(replyText), '', placeholderFor(sensorId)],
    'outbound',
  );
  if (!file) return;

  // Fire-and-forget: replaces the [sensor: pending:<id>] placeholder when done.
  runBehaviourSensor(replyText, file, sensorId).catch((err) =>
    logger.warn({ err }, 'Behaviour sensor: unhandled error'),
  );
}

export function logOutboundOnce(
  jid: string,
  replyText: string,
  outcomeId: string,
  requestContext?: string,
): AuditWriteResult {
  const time = localTimeHms(TIMEZONE);
  const sessionId = webChatSessionIdFromJid(jid);
  const sensorId = makeSensorId(time);
  const marker = `**Outcome-ID:** ${singleLine(outcomeId, 200)}`;
  const headerLines = [
    `### ${time} — ${channelFromJid(jid)} — outbound`,
    `**From:** Program Agent`,
  ];
  if (sessionId) headerLines.push(`**Session:** ${sessionId}`);
  const inspection = inspectMarker(marker);
  if (inspection === 'recorded') return 'already-recorded';
  if (inspection === 'inspection-failed') return 'write-failed';
  const file = appendAuditEntry(
    [
      ...headerLines,
      '',
      truncateBody(replyText),
      '',
      placeholderFor(sensorId),
      marker,
    ],
    'outbound',
  );
  if (file) {
    runBehaviourSensor(
      replyText,
      file,
      sensorId,
      undefined,
      requestContext,
    ).catch((err) => logger.warn({ err }, 'Behaviour sensor: unhandled error'));
  }
  return file ? 'written' : 'write-failed';
}

export function logReplySuppressedOnce(args: {
  outcomeId: string;
  channel: string;
  sender?: string;
  subject?: string;
  reason: string;
}): AuditWriteResult {
  const marker = `**Outcome-ID:** ${singleLine(args.outcomeId, 200)}`;
  return appendAuditEntryOnce(
    marker,
    [
      `### ${localTimeHms(TIMEZONE)} — ${singleLine(args.channel, 50)} — reply suppressed`,
      `**[REPLY SUPPRESSED]** From: ${singleLine(args.sender ?? 'unknown')} | Subject: ${singleLine(args.subject ?? 'unknown')}`,
      `**Reason:** ${singleLine(args.reason)}`,
      '',
    ],
    'reply-suppressed',
  );
}

export function logDeadLetterOnce(args: {
  outcomeId: string;
  channel: string;
  sender?: string;
  subject?: string;
  receivedAt?: string;
  chatJid: string;
  targetMessageId?: string;
  targetTimestamp: string;
  phase: string;
  attempts: number;
  reason: string;
}): AuditWriteResult {
  const marker = `**Outcome-ID:** ${singleLine(args.outcomeId, 200)}`;
  return appendAuditEntryOnce(
    marker,
    [
      `### ${localTimeHms(TIMEZONE)} — ${singleLine(args.channel, 50)} — dead letter`,
      `**[DEAD LETTER]** From: ${singleLine(args.sender ?? 'unknown')} | Subject: ${singleLine(args.subject ?? 'unknown')}`,
      `**Chat:** ${singleLine(args.chatJid)} | **Message:** ${singleLine(args.targetMessageId ?? 'unknown')} | **Received:** ${singleLine(args.receivedAt ?? 'unknown')}`,
      `**Target timestamp:** ${singleLine(args.targetTimestamp)} | **Phase:** ${singleLine(args.phase)} | **Attempts:** ${args.attempts}`,
      `**Reason:** ${singleLine(args.reason)}`,
      '',
    ],
    'dead-letter',
  );
}

function scheduleCommit(): void {
  if (commitTimer) return;
  commitTimer = setTimeout(() => {
    commitTimer = null;
    void commitAuditLog();
  }, COMMIT_INTERVAL);
}

/**
 * Log a direct terminal commit (push from a human author, not a bot).
 *
 * Writes to the audit-log file matching the commit's local date — not today —
 * so a commit pushed Monday morning but authored Sunday lands in the Sunday file.
 *
 * Caller is responsible for filtering out bot authors and non-KB commits before
 * invoking this. We don't run the behaviour-sensor here: terminal commits
 * bypassed Coordinator entirely, so there's no reasoning trace to check.
 */
/**
 * Durable record of a protected-path tripwire firing (G11/G39). Written
 * BEFORE the Telegram owner alert is attempted — the highest-severity
 * governance event must exist in the audit trail even when the alert
 * channel is down or misconfigured (G51: tripwire outcomes are
 * machine-logged). Idempotent per tripwire key (commit SHA or range).
 */
export function logTripwireOnce(args: {
  key: string;
  rules: string;
  paths: string;
  authorEmail?: string;
  detail: string;
}): AuditWriteResult {
  const marker = `**Tripwire-ID:** ${singleLine(args.key, 200)}`;
  return appendAuditEntryOnce(
    marker,
    [
      `### ${localTimeHms(TIMEZONE)} — governance — protected-path tripwire`,
      `**[TRIPWIRE]** ${args.rules} | ${args.paths}`,
      `**Author:** ${args.authorEmail ?? 'unknown'}`,
      '',
      args.detail,
      '',
    ],
    'tripwire',
  );
}

/**
 * Durable record of a protected-path alert being SUPPRESSED because a merge
 * only inherited an admin-authored change (G39 merge-awareness).
 *
 * A security control that can silently decline to fire needs its non-firings
 * on the record too: without this, the only trace of a suppression is an
 * application log line, and bot-authored commits also skip terminal-commit
 * logging — so a bad suppression would leave no durable evidence anywhere.
 * Deliberately labelled distinctly from [TRIPWIRE] so a suppression can never
 * be misread as a violation. Idempotent per commit SHA.
 */
export function logTripwireSuppressionOnce(args: {
  key: string;
  paths: string;
  authorEmail?: string;
  supplyingParent: string;
  detail: string;
}): AuditWriteResult {
  const marker = `**Tripwire-Suppression-ID:** ${singleLine(args.key, 200)}`;
  return appendAuditEntryOnce(
    marker,
    [
      `### ${localTimeHms(TIMEZONE)} — governance — protected-path alert suppressed (merge inherited admin work)`,
      `**[TRIPWIRE-SUPPRESSED]** ${args.paths}`,
      `**Merge author:** ${args.authorEmail ?? 'unknown'}`,
      `**Admin content inherited from parent:** ${singleLine(args.supplyingParent, 60)}`,
      '',
      args.detail,
      '',
    ],
    'tripwire-suppression',
  );
}

export function logTerminalCommit(args: {
  sha: string;
  authorEmail: string;
  subject: string;
  kbFiles: Array<{ path: string; stats: string }>;
  commitIso: string;
}): AuditWriteResult {
  const commitDate = new Date(args.commitIso);
  if (isNaN(commitDate.getTime())) {
    logger.warn(
      { commitIso: args.commitIso },
      'Audit log: invalid commit timestamp, skipping',
    );
    return 'write-failed';
  }
  const filesBlock = args.kbFiles
    .map((f) => `- \`${f.path}\` (${f.stats})`)
    .join('\n');
  // Idempotent on the full commit SHA: a webhook redelivery (e.g. after a
  // tripwire-alert 500) must not duplicate the terminal-commit entry. The
  // target file is keyed by commit date, so retries always hit the same
  // file — inspect only it (no per-commit full-directory sweep). The result
  // is returned so the push handler can 500 on a dropped entry, keeping the
  // manual-redelivery recovery path alive.
  const marker = `**Commit-ID:** ${singleLine(args.sha, 200)}`;
  return appendAuditEntryOnce(
    marker,
    [
      `### ${localTimeHms(TIMEZONE, commitDate)} — terminal — direct`,
      `**Author:** ${args.authorEmail}`,
      `**Commit:** ${args.sha.slice(0, 7)}`,
      '',
      args.subject,
      '',
      `**KB files:**`,
      filesBlock,
      '',
    ],
    'terminal commit',
    path.join(auditDir(), `${localDateYmd(TIMEZONE, commitDate)}.md`),
    { inspectOnlyTargetFile: true },
  );
}

let commitInFlight: Promise<SyncResult | void> = Promise.resolve();

/**
 * Commit pending audit log changes and push them. The work is syncHostRepo
 * (host-repo.ts): commit in the host-owned repository; take checked commits
 * from the agent checkout; push; if the origin moved, rebase and push again.
 * No git runs in the agent checkout.
 *
 * Returns a promise that settles when this commit (and any already running)
 * has finished, so shutdown can await it: the git steps are separate child
 * processes, and process.exit would cut the sequence short. A failed commit
 * or push puts its entries back so the next cycle retries them.
 *
 * `sync` is injectable for tests.
 */
export function commitAuditLog(
  sync: typeof syncHostRepo = syncHostRepo,
): Promise<void> {
  commitInFlight = commitInFlight.then(async () => {
    if (pendingWrites === 0) return;
    await runSyncWithPending(sync, {});
  });
  return commitInFlight.then(() => {});
}

async function runSyncWithPending(
  sync: typeof syncHostRepo,
  opts: { fetchOrigin?: boolean },
): Promise<SyncResult> {
  const count = pendingWrites;
  pendingWrites = 0;
  const result = await sync({ ...opts, count });
  if (result.failed) {
    pendingWrites += count;
    if (count > 0) scheduleCommit(); // retry next cycle
    logger.warn(
      { failed: result.failed },
      'Audit log: commit or push failed; entries stay pending',
    );
  } else if (count > 0) {
    // Say what this run did. A run with no failure may still have committed
    // nothing (the host repo is waiting for the origin's history, or an
    // earlier run already committed the files) or pushed nothing (no origin
    // is set, or the origin already has the commit).
    if (result.committed && result.pushed)
      logger.info({ entries: count }, 'Audit log: committed and pushed');
    else if (result.committed)
      logger.info(
        { entries: count },
        'Audit log: committed in the host repo; nothing was pushed in this run',
      );
    else
      logger.info(
        { entries: count, pushed: result.pushed },
        'Audit log: no new commit in this run; entries not yet committed stay as files for a later run',
      );
  }
  return result;
}

/**
 * Bring the knowledge base up to date around an agent turn, whether or not
 * audit entries are pending: commit the host's writes, take the agent's
 * commits out of its checkout, push, and refresh the export the container
 * pulls from. `fetchOrigin` (before a turn) also fetches the origin first.
 * Never throws.
 */
export function syncKnowledgeBase(
  opts: { fetchOrigin?: boolean } = {},
  sync: typeof syncHostRepo = syncHostRepo,
): Promise<SyncResult> {
  const run = commitInFlight.then(() => runSyncWithPending(sync, opts));
  commitInFlight = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Test hook: set the pending-entry count. */
export function _setPendingWritesForTests(n: number): void {
  pendingWrites = n;
}

/**
 * Flush any pending audit log entries (call on shutdown).
 */
export function flushAuditLog(): Promise<void> {
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
  return commitAuditLog();
}
