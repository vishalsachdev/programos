/**
 * G58 reply-CC mirror: when Coordinator was directly addressed (bot in the real
 * To: header, per G56's .eml parsing), the reply keeps the inbound thread's
 * audience — every other To/Cc address — so the sender's chosen witnesses
 * see the answer they were meant to see. Without it, a reply written for
 * the thread reaches the sender alone.
 *
 * The spam boundary is EMAIL_ALLOWLIST.md: only inbound-thread addresses
 * already on the allowlist are CC'd. Everyone else is dropped, and the drop
 * is disclosed in a plain-text note appended to the reply body — never a
 * silent partial audience. No new spontaneous reach: only addresses a human
 * put on the thread can ever appear here.
 */
import { botAddresses, extractAddresses } from './cc-context.js';
import {
  canProcessEmailSender,
  type EmailAllowlistState,
} from './channels/webhook-allowlist.js';

export interface DroppedCc {
  address: string;
  reason: string;
}

export interface ReplyCcMirror {
  /** Allowlist-cleared thread audience to CC on the reply. */
  cc: string[];
  /** Thread audience refused by the allowlist. */
  dropped: DroppedCc[];
  /** Disclosure line for the reply body when anyone was dropped. */
  note?: string;
}

export function mirrorReplyCc(args: {
  ccContext:
    | { realTo?: string; realCc?: string; botInTo?: boolean }
    | undefined;
  sender: string;
  allowlistState: EmailAllowlistState;
  /**
   * Accepted for call-site symmetry with the send path but intentionally
   * unused: mirror checks always run fallback-closed. Permissive fallback
   * exists so a reply to the SENDER is not refused when the allowlist is
   * unreadable; it must never widen third-party CC reach.
   */
  fallbackMode: 'closed' | 'permissive';
}): ReplyCcMirror {
  const empty: ReplyCcMirror = { cc: [], dropped: [] };
  const ctx = args.ccContext;
  // Mirror only for header-verified direct mail; every ambiguity path
  // (no .eml, unparsed headers, pre-G58 metadata) degrades to sender-only.
  if (!ctx?.botInTo) return empty;

  const bots = botAddresses();
  // Normalize via extractAddresses so a display-form sender ("Name <a@b>")
  // still excludes correctly — a missed match here would CC the sender a
  // second copy of their own reply.
  const sender =
    extractAddresses(args.sender)[0] ?? args.sender.trim().toLowerCase();
  const audience = [
    ...new Set([
      ...extractAddresses(ctx.realTo),
      ...extractAddresses(ctx.realCc),
    ]),
  ].filter((a) => a !== sender && !bots.includes(a));
  if (audience.length === 0) return empty;

  const cc: string[] = [];
  const dropped: DroppedCc[] = [];
  for (const addr of audience) {
    const access = canProcessEmailSender(addr, args.allowlistState, 'closed');
    if (access.allowed) cc.push(addr);
    else
      dropped.push({
        address: addr,
        reason: access.reason ?? 'not on the authorized recipient list',
      });
  }

  const note = dropped.length
    ? `Note: this reply was not copied to ${dropped
        .map((d) => d.address)
        .join(', ')} from the original thread — Coordinator can only email ` +
      `addresses on the program's authorized recipient list` +
      (dropped.some((d) => d.reason.includes('unavailable'))
        ? ' (the list was temporarily unavailable, so no one was copied)'
        : '') +
      `.`
    : undefined;

  return { cc, dropped, ...(note ? { note } : {}) };
}
