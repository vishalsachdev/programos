/**
 * Audit Log for Program Communication Pipeline
 *
 * Appends every inbound message + agent response to daily log files
 * in the program-repo repo: discussions/audit-log/YYYY-MM-DD.md
 *
 * Commits are batched — written to disk immediately, committed periodically.
 */
import path from 'path';
import { execFile } from 'child_process';

import {
  makeSensorId,
  placeholderFor,
  runBehaviourSensor,
} from './behaviour-sensor.js';
import { channelFromJid, webChatSessionIdFromJid } from './channel-utils.js';
import { logger } from './logger.js';
import { TIMEZONE } from './config.js';
import { BOT_GIT_AUTHOR_EMAIL } from './instance-identity.js';
import { localDateYmd, localTimeHms } from './timezone.js';
import { checkoutGitOptions, getProgramRepoPath } from './program-repo.js';
import { appendToCheckout, checkoutHasLine } from './checkout-fs.js';

const COMMIT_INTERVAL = 5 * 60 * 1000; // Commit every 5 minutes

let pendingWrites = 0;
let commitTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Resolved lazily (not a module const) so tests can stub PROGRAM_REPO
 * after import — the pattern logGateResult established, now shared by every
 * entry writer.
 */
function auditDir(): string {
  return path.join(getProgramRepoPath(), 'discussions', 'audit-log');
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
    // The checkout is container-writable: write as its owner, never root.
    appendToCheckout(
      getProgramRepoPath(),
      target,
      [...lines, '---', ''].join('\n'),
    );
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
    return checkoutHasLine(getProgramRepoPath(), onlyFile ?? auditDir(), marker)
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
      if (checkoutHasLine(getProgramRepoPath(), dir, marker))
        return 'already-recorded';
      const target = path.join(dir, `${localDateYmd(TIMEZONE)}.md`);
      appendToCheckout(
        getProgramRepoPath(),
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
export function logDroppedEmail(from: string, subject: string): void {
  appendAuditEntry(
    [
      `### ${localTimeHms(TIMEZONE)} — email — dropped (not on allowlist)`,
      `**From:** ${from}`,
      `**Subject:** ${subject}`,
      '',
    ],
    'dropped-email',
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

export function logOutboundEmailOnce(
  args: OutboundEmailAuditArgs & { deliveryId: string },
): AuditWriteResult {
  const marker = `**Delivery-ID:** ${singleLine(args.deliveryId, 200)}`;
  return appendAuditEntryOnce(
    marker,
    outboundEmailLines(args),
    'outbound-email',
  );
}

export function logOutboundEmail(args: OutboundEmailAuditArgs): void {
  if (args.deliveryId) {
    logOutboundEmailOnce({ ...args, deliveryId: args.deliveryId });
    return;
  }
  appendAuditEntry(outboundEmailLines(args), 'outbound-email');
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

/**
 * The git sequence behind commitAuditLog, with an injectable runner.
 * Push; if origin moved, rebase our commit on top (autostash any in-flight
 * audit-file write) and retry. On rebase failure, abort cleanly so the shared
 * working tree is never left conflicted; the commit stays local and is
 * retried next cycle (F5: a bare push once stranded commits on a moved origin).
 */
export async function runAuditCommit(
  count: number,
  run: (args: string[]) => Promise<void>,
): Promise<void> {
  // kb-triage/ is staged too, so behaviour-sensor FAIL reports get pushed
  // alongside the audit-log annotation that points to them.
  await run(['add', 'discussions/audit-log/', 'discussions/kb-triage/']);
  try {
    await run([
      'commit',
      '-m',
      `Audit log: ${count} entries`,
      `--author=Coordinator <${BOT_GIT_AUTHOR_EMAIL}>`,
      '--no-verify',
    ]);
  } catch (err) {
    // Nothing staged (entries already in an earlier, unpushed commit): go on
    // and push that commit. Anything else is a real commit failure.
    try {
      await run(['diff', '--cached', '--quiet']);
    } catch {
      throw err;
    }
  }
  try {
    await run(['push']);
    return;
  } catch {
    // fall through to rebase-and-retry
  }
  try {
    await run(['pull', '--rebase', '--autostash', 'origin', 'main']);
    await run(['push']);
  } catch (err) {
    await run(['rebase', '--abort']).catch(() => {});
    throw err;
  }
}

/**
 * Commit pending audit log changes to the program-repo repo. Git runs as the
 * checkout owner (uid 1000), never as root: containers can write .git/hooks
 * and .git/config, so root git here would run their code as root. Objects are
 * created uid-1000-owned, so no ownership repair is needed afterwards.
 */
function gitAsCheckoutOwner(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile('git', args, checkoutGitOptions(), (err, _stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(),
    );
  });
}

let commitInFlight: Promise<void> = Promise.resolve();

/**
 * Returns a promise that settles when this commit (and any already running)
 * has finished, so shutdown can await it: the git steps are separate child
 * processes now, and process.exit would cut the sequence short. A failed
 * commit puts its entries back so the next cycle retries them.
 */
export function commitAuditLog(
  run: (args: string[]) => Promise<void> = gitAsCheckoutOwner,
): Promise<void> {
  commitInFlight = commitInFlight.then(async () => {
    if (pendingWrites === 0) return;
    const count = pendingWrites;
    pendingWrites = 0;
    try {
      await runAuditCommit(count, run);
      logger.info({ entries: count }, 'Audit log: committed and pushed');
    } catch (err) {
      pendingWrites += count;
      scheduleCommit(); // retry next cycle
      logger.warn(
        {
          err: (err as Error).message,
          stderr: (err as { stderr?: string }).stderr,
        },
        'Audit log: commit failed; entries stay pending',
      );
    }
  });
  return commitInFlight;
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
