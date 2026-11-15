/**
 * CC-as-context detection (R1+R2).
 *
 * The email-inbox Worker's envelope `to`/`cc` are lossy — the audit log has
 * shown `To: program@example.org` for faculty-addressed mail — so CC status
 * is only recoverable from the raw .eml headers (R1). When the bot appears
 * only in Cc and the body contains no direct request addressed to Coordinator, the
 * mail is context: it is still filed to the KB, but the host suppresses the
 * outbound ack (R2). Every ambiguity — unreadable .eml, missing text body,
 * unparseable headers — resolves to "ack as before": suppression is the
 * exception that must be proven, never the default.
 */
import fs from 'fs';

import { extractEmailHeader } from './channels/webhook-threading.js';
import { BOT_EMAIL, DEFAULT_BOT_EMAIL } from './config.js';

/**
 * Addresses that mean "the bot" wherever they appear in To/Cc. BOT_EMAIL
 * carries the .env-configured SEND_FROM_EMAIL — reading process.env alone
 * misses the documented VPS setup, leaving G56 detection on the old
 * mailbox after a migration. The default stays in the set so
 * mail still addressed to the old mailbox during a migration window is
 * recognized; the live process.env read keeps test overrides working.
 */
export function botAddresses(): string[] {
  const fromEnv = (process.env.SEND_FROM_EMAIL || '').trim().toLowerCase();
  const set = new Set([DEFAULT_BOT_EMAIL, BOT_EMAIL]);
  if (fromEnv) set.add(fromEnv);
  // Never return an empty entry: detectDirectRequest builds a regex
  // alternation from this list, and an empty alternative matches every
  // segment. BOT_EMAIL is trimmed at the source too —
  // this is the backstop at the point of regex construction.
  return [...set].filter(Boolean);
}

const ADDR_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * Marker the email-inbox Worker appends when it caps an oversized .eml
 * body. Must match the Worker source (program-repo/email-inbox/src/index.ts).
 */
export const EML_TRUNCATION_MARKER = '[truncated by email-inbox worker]';

/**
 * Lowercased bare addresses out of a raw address-list header value.
 *
 * Structure-aware, not a whole-string regex scan: email-like substrings
 * inside quoted display names or comments must NOT count as recipients — a
 * crafted `"dean@example.edu" <attacker@x>` display name would otherwise
 * smuggle a third party into the G58 mirrored audience, or spoof the bot's
 * own address for G56 detection. Per mailbox (top-level
 * comma split with quoted strings masked), an angle-bracket addr-spec wins;
 * only mailboxes with no angle form are regex-scanned as bare addresses.
 */
export function extractAddresses(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  const noComments = headerValue.replace(/\([^)]*\)/g, ' ');
  // Mask quoted strings so display-name text (and commas inside it) is
  // invisible to both the split and the fallback scan.
  const masked = noComments.replace(/"[^"]*"/g, ' ');
  const out: string[] = [];
  // Split on commas AND semicolons — some clients (Outlook group syntax)
  // separate mailboxes with ';'. A segment with angle
  // forms scans every one of them; only angle-free segments are scanned as
  // bare addresses.
  for (const mailbox of masked.split(/[,;]/)) {
    const angles = [...mailbox.matchAll(/<([^>]*)>/g)].map((m) => m[1]);
    for (const target of angles.length ? angles : [mailbox]) {
      for (const addr of target.match(ADDR_RE) ?? []) {
        out.push(addr.toLowerCase());
      }
    }
  }
  return out;
}

/**
 * The RFC 2822 header block only — everything before the first blank line.
 * `extractEmailHeader` regex-scans whatever it is given, so feeding it the
 * full message would match `Cc:` lines inside quoted reply chains (Outlook
 * quotes headers verbatim) and misclassify mail as Cc-only.
 */
export function headerBlock(rawEml: string): string {
  const sep = rawEml.search(/\r?\n\r?\n/);
  return sep === -1 ? rawEml : rawEml.slice(0, sep);
}

/**
 * True when some sentence addresses Coordinator directly: it names the bot AND is
 * either a question or an address-form/second-person construction ("Coordinator,
 * ...", "Coordinator please file this", "Coordinator can you pull..."). Third-person
 * mentions — "ask Coordinator about the framework", "Coordinator can walk anyone through
 * the history", "Coordinator is copied for the record" — do not count; that is
 * exactly the shape of the campaign mail whose acks R2 exists to
 * silence.
 */
export function detectDirectRequest(bodyText: string): boolean {
  // Either the name or any bot address counts as naming the bot in every
  // pattern — "<bot address>, please file this" is as direct as "Coordinator,
  // please file this". Addresses come from botAddresses()
  // (DEFAULT_BOT_EMAIL + SEND_FROM_EMAIL), so an address change cannot
  // silently break direct-request detection.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bot = ['co[\\s-]?ordinator', ...botAddresses().map(escapeRe)].join('|');
  const botName = new RegExp(`\\b(${bot})\\b`, 'i');
  const addressForm = new RegExp(
    `^\\s*(hi |hello |hey |dear )?(${bot})\\s*[,:—-]`,
    'i',
  );
  // Bot name followed by an imperative/second-person cue, punctuated or not:
  // "Coordinator please file this", "Coordinator could you...", "Coordinator you should know".
  // Bare "can"/"will" without "you" stays third-person ("Coordinator can walk
  // anyone through...").
  const imperativeForm = new RegExp(
    `\\b(${bot})[,:]?\\s+(please|pls|kindly|(can|could|would|will|do)\\s+you\\b|you\\b)`,
    'i',
  );
  // Sentence-ish segmentation; keep the terminator so '?' survives.
  const segments = bodyText.split(/(?<=[.!?])\s+|\n+/);
  for (const seg of segments) {
    if (!botName.test(seg)) continue;
    if (seg.includes('?')) return true;
    if (addressForm.test(seg)) return true;
    if (imperativeForm.test(seg)) return true;
  }
  return false;
}

/**
 * Merge a new message's suppression decision with the thread's prior state.
 * emailMetadata is keyed by thread JID while cc-context decisions are
 * per-message, and the per-group queue can batch several messages into one
 * container run with one reply — so overlapping messages in a thread race on
 * the same metadata slot. Resolution is monotone-safe: once a
 * thread has seen a message that must be acked (direct mail, or metadata
 * written before this feature existed), no later Cc-only copy may flip it
 * back to silent. Worst case is an unnecessary ack — never a dropped reply.
 */
export function mergeSuppressDecision(
  prior: CcContextResult | undefined,
  next: CcContextResult,
  priorMetaExists: boolean,
): CcContextResult {
  // Audience continuity (G58): when the thread earlier saw
  // header-verified direct mail, the batched reply answers that mail too —
  // a later Cc-only copy must not clobber botInTo/realTo/realCc or the
  // reply silently ships sender-only, exactly the loss G58 exists to fix.
  // Restricted to POSITIVELY PARSED Cc-only results (next.ccOnly): an
  // ambiguity result (no .eml, unreadable, headers missing) must not
  // inherit the old audience — mirroring for an unverified message would
  // contradict G58's fallback-closed stance.
  const audience =
    prior?.botInTo && next.ccOnly && !next.botInTo
      ? { botInTo: true, realTo: prior.realTo, realCc: prior.realCc }
      : {};
  if (!next.suppressAck) return { ...next, ...audience };
  if (priorMetaExists && !prior?.suppressAck) {
    return {
      ...next,
      ...audience,
      suppressAck: false,
      reason: `thread previously required an ack — acking (was: ${next.reason})`,
    };
  }
  // Suppressed: no reply will be sent, so the audience fields are moot.
  return next;
}

export interface CcContextResult {
  /** Real To: header value (display form), when recoverable. */
  realTo?: string;
  /** Real Cc: header value (display form), when recoverable. */
  realCc?: string;
  /** Bot appears in Cc and not in To (per real headers). */
  ccOnly: boolean;
  /**
   * Bot appears in the real To: header. Reply-CC mirroring (G58) is only
   * legal when true — every ambiguity path leaves it false/undefined so the
   * reply degrades to sender-only.
   */
  botInTo?: boolean;
  /** Host should suppress the outbound ack for this message. */
  suppressAck: boolean;
  /** One-line explanation for logs/audit. */
  reason: string;
}

const ACK = (reason: string): Omit<CcContextResult, 'realTo' | 'realCc'> => ({
  ccOnly: false,
  suppressAck: false,
  reason,
});

/**
 * Decide whether this inbound email is CC-as-context. Non-throwing; every
 * failure path returns suppressAck: false (default to ack on ambiguity).
 */
export async function analyzeCcContext(
  emlPath: string | null,
): Promise<CcContextResult> {
  if (!emlPath) {
    return ACK('no .eml available — envelope headers untrusted, acking');
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(emlPath, 'utf-8');
  } catch {
    return ACK('.eml unreadable — acking');
  }

  // Parse recipient headers from the header block ONLY — the body of a
  // threaded reply quotes previous To:/Cc: lines verbatim, and matching one
  // of those would flip a direct mail into cc-only (silent suppression).
  const headers = headerBlock(raw);
  const realTo = extractEmailHeader(headers, 'To');
  const realCc = extractEmailHeader(headers, 'Cc');
  const bots = botAddresses();
  const toAddrs = extractAddresses(realTo);
  const ccAddrs = extractAddresses(realCc);
  const botInTo = toAddrs.some((a) => bots.includes(a));
  const botInCc = ccAddrs.some((a) => bots.includes(a));

  if (!realTo && !realCc) {
    return { realTo, realCc, ...ACK('no To/Cc headers in .eml — acking') };
  }
  if (botInTo || !botInCc) {
    // Directly addressed, or not visibly a recipient at all (Bcc/alias
    // delivery hides the bot from both headers — treat as direct).
    return {
      realTo,
      realCc,
      botInTo,
      ...ACK(botInTo ? 'bot in To — direct mail' : 'bot not in To/Cc — acking'),
    };
  }

  // Bot is Cc-only. Suppress only if the decoded body contains no direct
  // request to Coordinator; an undecodable body is ambiguity → ack.
  //
  // A Worker-truncated .eml (body capped at 256KB) is ambiguity too: the
  // direct request may sit past the cut, and suppressing on a partial body
  // would be silently wrong. Headers
  // always precede the cut, so botInTo/realTo/realCc above stay valid.
  if (raw.includes(EML_TRUNCATION_MARKER)) {
    return {
      realTo,
      realCc,
      ccOnly: true,
      botInTo: false,
      suppressAck: false,
      reason: 'cc-only but .eml truncated by worker — acking on ambiguity',
    };
  }
  let bodyText: string | undefined;
  try {
    const { simpleParser } = await import('mailparser');
    const parsed = await simpleParser(raw);
    bodyText =
      parsed.text ||
      (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, ' ') : undefined);
  } catch {
    bodyText = undefined;
  }
  if (!bodyText || !bodyText.trim()) {
    return {
      realTo,
      realCc,
      ccOnly: true,
      suppressAck: false,
      reason: 'cc-only but body undecodable — acking on ambiguity',
    };
  }
  if (detectDirectRequest(bodyText)) {
    return {
      realTo,
      realCc,
      ccOnly: true,
      suppressAck: false,
      reason: 'cc-only but body directly addresses Coordinator — acking',
    };
  }
  return {
    realTo,
    realCc,
    ccOnly: true,
    botInTo: false,
    suppressAck: true,
    reason: 'cc-only, no direct request — context mail, ack suppressed',
  };
}
