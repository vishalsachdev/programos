/**
 * Email loop / auto-reply detection.
 *
 * Drops messages that mail systems mark as auto-generated (Outlook OOO, Gmail
 * vacation, mailing-list expansion, autoresponders) BEFORE the webhook spawns
 * a Coordinator container. Without this, an out-of-office reply from an allowlisted
 * sender can ping-pong with `program@` indefinitely — each round costs ~$0.85
 * in Claude turns and Resend dispatches.
 *
 * Standards consulted:
 *   - RFC 3834 (`Auto-Submitted: auto-replied | auto-generated`)
 *   - RFC 2076 / RFC 2369 (`Precedence: list | bulk | junk`, `List-Id`)
 *   - X-Autoreply / X-Autorespond / X-Auto-Response-Suppress (de facto)
 */
import fs from 'fs';

import { logger } from './logger.js';

interface MailHeaders {
  get(name: string): string | string[] | undefined | { value?: string };
}

interface ParsedHeadersLike {
  headers?: Map<string, unknown> | MailHeaders;
}

export interface LoopCheckResult {
  isAutoReply: boolean;
  reason?: string;
}

/**
 * Header values (case-insensitive name match) that indicate an auto-generated
 * message. We REJECT on any match — false positives (a human happens to set
 * one of these) are vanishingly rare in pilot traffic and the cost of letting
 * a true auto-reply through is much higher than rejecting a real one.
 */
const REJECT_RULES: Array<{
  name: string;
  match: (value: string) => boolean;
  reason: string;
}> = [
  {
    name: 'auto-submitted',
    match: (v) => /^(auto-replied|auto-generated|auto-notified)/i.test(v),
    reason: 'Auto-Submitted header indicates auto-generated message',
  },
  {
    name: 'precedence',
    match: (v) => /^(list|bulk|junk|auto_reply)/i.test(v),
    reason: 'Precedence header indicates list/bulk/auto traffic',
  },
  {
    name: 'list-id',
    match: () => true,
    reason: 'List-Id header indicates mailing-list traffic',
  },
  {
    name: 'list-unsubscribe',
    match: () => true,
    reason: 'List-Unsubscribe header indicates list/marketing traffic',
  },
  {
    name: 'x-autoreply',
    match: (v) => /^(yes|true|1|on)/i.test(v) || v.length > 0,
    reason: 'X-Autoreply header set',
  },
  {
    name: 'x-autorespond',
    match: () => true,
    reason: 'X-Autorespond header set',
  },
  {
    name: 'x-mailer',
    match: (v) => /vacation|out.of.office|autoresponder/i.test(v),
    reason: 'X-Mailer indicates vacation/autoresponder',
  },
];

/**
 * Coerce mailparser's header value into a plain string for regex matching.
 * mailparser returns either a string, an array of strings, or
 * { value, params } depending on the header type.
 */
function headerToString(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(headerToString).join('; ');
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    const v = (raw as { value?: unknown }).value;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/**
 * Look up a header by case-insensitive name in a mailparser `headers` Map.
 */
function getHeaderCI(
  headers: Map<string, unknown> | undefined,
  name: string,
): string {
  if (!headers) return '';
  const lower = name.toLowerCase();
  for (const [key, val] of headers.entries()) {
    if (typeof key === 'string' && key.toLowerCase() === lower) {
      return headerToString(val);
    }
  }
  return '';
}

/**
 * Check parsed mailparser output for auto-reply / loop-suspect headers.
 * Pure function — used by both the runtime path and tests.
 */
export function checkParsedForLoop(parsed: ParsedHeadersLike): LoopCheckResult {
  const headers =
    parsed.headers instanceof Map
      ? (parsed.headers as Map<string, unknown>)
      : undefined;

  for (const rule of REJECT_RULES) {
    const value = getHeaderCI(headers, rule.name);
    if (value && rule.match(value)) {
      return { isAutoReply: true, reason: rule.reason };
    }
  }

  // mailparser folds List-Id / List-Unsubscribe / List-Post into ONE
  // structured `list` header ({ id, unsubscribe, post, ... }) — it never
  // exposes them under their raw names. The string-keyed rules above only
  // fire on hand-built or raw-string headers; the real .eml ingest path
  // (isAutoReplyEml → simpleParser) lands here, so the structured form must
  // be checked explicitly or list traffic slips through.
  const listHeader = headers?.get('list');
  if (listHeader && typeof listHeader === 'object') {
    const l = listHeader as { id?: unknown; unsubscribe?: unknown };
    if (l.id) {
      return {
        isAutoReply: true,
        reason: 'List-Id header indicates mailing-list traffic',
      };
    }
    if (l.unsubscribe) {
      return {
        isAutoReply: true,
        reason: 'List-Unsubscribe header indicates list/marketing traffic',
      };
    }
  }

  return { isAutoReply: false };
}

/**
 * Parse just the headers of an .eml file on disk and check for auto-reply
 * markers. Non-throwing — on parse failure, returns `{isAutoReply: false}`
 * so a malformed file doesn't accidentally bypass downstream allowlist /
 * rate-limit checks (those still run).
 */
export async function isAutoReplyEml(
  emlPath: string,
): Promise<LoopCheckResult> {
  try {
    const { simpleParser } = await import('mailparser');
    const raw = await fs.promises.readFile(emlPath);
    const parsed = await simpleParser(raw);
    return checkParsedForLoop(parsed as ParsedHeadersLike);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), emlPath },
      'email-loop-detection: failed to parse .eml, treating as not-auto-reply',
    );
    return { isAutoReply: false };
  }
}
