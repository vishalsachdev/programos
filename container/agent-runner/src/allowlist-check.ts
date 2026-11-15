/**
 * RC-018: container-side recipient precheck for `send_email`.
 *
 * The host allowlist gate is authoritative and fail-closed; this exists so
 * the TOOL RESULT the agent reads is truthful at call time. Without it the
 * tool says "queued" for every address, the host drops a CC that is not on
 * `program/EMAIL_ALLOWLIST.md`, and the agent narrates a delivery that never
 * happened.
 *
 * Parsing mirrors the host's `parseEmailAllowlist` (src/channels/
 * webhook-allowlist.ts): an address counts only when it sits in the second
 * column of a markdown table row. Prose mentions (retired-access notes) do
 * not count, exactly as on the host.
 */

import { emailAddressTokensInText } from './email-addresses.js';
import { stripMarkdown } from './email-format.js';
import { TRUSTED_BODY_MAILBOXES } from './trusted-body-mailboxes.js';

const TABLE_ROW_EMAIL_RE =
  /\|\s*[^|]+\|\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*\|/g;

export function extractAllowlistAddresses(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(TABLE_ROW_EMAIL_RE)) {
    found.add(m[1].toLowerCase());
  }
  return found;
}

/**
 * Addresses from `candidates` missing from the allowlist table, in input
 * order. Returns null when the allowlist could not be read, so callers
 * distinguish "unknown" from "absent".
 */
export function addressesNotOnAllowlist(
  candidates: string[],
  allowlistText: string | null,
): string[] | null {
  if (allowlistText === null) return null;
  const allowed = extractAllowlistAddresses(allowlistText);
  return candidates
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .filter((c) => !allowed.has(c.toLowerCase()));
}

function splitAddresses(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/**
 * Text to append to the send_email tool result. Empty when every address is
 * on the table. Mirrors host behaviour: a To address off the list refuses the
 * WHOLE send (nobody receives it); a CC address off the list is dropped while
 * the To recipients still receive the email.
 */
export function describeSendPrecheck(args: {
  to: string;
  cc?: string;
  body?: string;
  allowlistText: string | null;
}): string {
  const toList = splitAddresses(args.to);
  const ccList = splitAddresses(args.cc);
  const guidance =
    'Report these recipients as not sent. Addresses come only from program/EMAIL_ALLOWLIST.md; never derive one from a name.';
  if (args.allowlistText === null) {
    return `\nWARNING: program/EMAIL_ALLOWLIST.md could not be read, so this send is unverified. The host gate still decides; do not claim delivery to anyone until the host record confirms it.`;
  }
  const toMissing = addressesNotOnAllowlist(toList, args.allowlistText) ?? [];
  const ccMissing = addressesNotOnAllowlist(ccList, args.allowlistText) ?? [];
  const bodyTokens = emailAddressTokensInText(stripMarkdown(args.body ?? ''));
  const bodyAllowlist = extractAllowlistAddresses(args.allowlistText);
  for (const address of TRUSTED_BODY_MAILBOXES) bodyAllowlist.add(address);
  const bodyMissing = [
    ...new Set(
      bodyTokens
        .filter((token) => !bodyAllowlist.has(token.address))
        .map((token) => token.raw),
    ),
  ];
  if (bodyMissing.length) {
    return `\nWARNING: Unverified body email address(es): ${bodyMissing.join(', ')}. The host body gate refuses the WHOLE send unless it has trusted inbound or configured sender evidence. Remove these addresses and refer to people by name; never substitute a guessed address. Do not claim delivery until the host record confirms it.`;
  }
  if (toMissing.length) {
    return `\nWARNING: To recipient(s) not on program/EMAIL_ALLOWLIST.md: ${toMissing.join(', ')}. The host refuses the WHOLE send, so nobody receives this email, including ${toList.join(', ')}. ${guidance}`;
  }
  if (ccMissing.length) {
    const missingSet = new Set(ccMissing.map((a) => a.toLowerCase()));
    const surviving = [
      ...toList,
      ...ccList.filter((a) => !missingSet.has(a.toLowerCase())),
    ];
    return `\nWARNING: CC recipient(s) not on program/EMAIL_ALLOWLIST.md: ${ccMissing.join(', ')}. The host will NOT send to them; the recipients who do receive this email are ${surviving.join(', ')}. ${guidance}`;
  }
  return '';
}
