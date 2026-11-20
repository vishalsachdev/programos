// Sender authentication for inbound email: one verdict per message.
//
// The allowlist names people by the address in the From header, and anyone
// can write any From header. Whether a message really came from that
// address is known only to a mail server that checked SPF, DKIM and DMARC
// when it received the message. The intake worker (`inbound/src/auth.ts`)
// decides which servers' results are read and puts them in the `auth` field
// of its payload. This file decides what those results prove.
//
// The host takes the results from the payload and does not read the
// committed original for them. Both come from the same place: the payload
// is accepted only with the webhook secret, the original only when the
// intake worker committed it, and the payload already carries the `from`
// the allowlist is matched against. The original also lacks one fact the
// rule needs, the envelope sender, which only the mail platform reports.
// What the host does NOT take from the payload is the list of servers it
// believes: that is EMAIL_AUTH_TRUSTED_AUTHSERV_IDS, set on the host.

export type EmailAuthVerdict = 'authenticated' | 'unauthenticated' | 'unknown';
export type EmailAuthMode = 'flag' | 'enforce';

export interface EmailAuthSettings {
  mode: EmailAuthMode;
  /** authserv-ids whose results count. Empty: every verdict is "unknown". */
  trusted: Set<string>;
  /** enforce only: what happens to a message with the verdict "unknown". */
  unknown: 'block' | 'allow';
  /**
   * True (the default): a DMARC pass counts only when the server names the
   * From domain it checked (`header.from`). False: a pass from the mail
   * platform with no domain named is taken as a pass for the From address
   * of the message.
   */
  requireFromDomain: boolean;
}

/** The settings `readEmailAuthSettings` reads, for a caller that collects them. */
export const EMAIL_AUTH_SETTING_KEYS = [
  'EMAIL_AUTH_MODE',
  'EMAIL_AUTH_TRUSTED_AUTHSERV_IDS',
  'EMAIL_AUTH_UNKNOWN',
  'EMAIL_AUTH_REQUIRE_FROM_DOMAIN',
] as const;

export interface EmailAuthDecision {
  verdict: EmailAuthVerdict;
  /** One line for the audit log. No text from the message is in it. */
  reason: string;
}

const HOST_NAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Read the settings from the record given. Throws on a value that is not
 * one of the listed ones, and on "enforce" with no trusted server: that
 * would block every message, or (with EMAIL_AUTH_UNKNOWN=allow) check
 * nothing while saying "enforce".
 *
 * This file reads nothing else and imports nothing, so the offline check
 * (`inbound/scripts/check-message.ts`) runs the same code. The host gets its
 * record from the process environment and `.env` together
 * (`src/email-auth-settings.ts`).
 */
export function readEmailAuthSettings(
  env: Record<string, string | undefined> = process.env,
): EmailAuthSettings {
  const mode = (env.EMAIL_AUTH_MODE || 'flag').trim().toLowerCase();
  if (mode !== 'flag' && mode !== 'enforce') {
    throw new Error('EMAIL_AUTH_MODE must be "flag" or "enforce"');
  }
  const trusted = new Set<string>();
  for (const part of (env.EMAIL_AUTH_TRUSTED_AUTHSERV_IDS || '').split(',')) {
    const id = part.trim().toLowerCase();
    if (!id) continue;
    if (!HOST_NAME.test(id)) {
      throw new Error(
        'EMAIL_AUTH_TRUSTED_AUTHSERV_IDS must be a comma-separated list of host names',
      );
    }
    trusted.add(id);
  }
  const unknown = (env.EMAIL_AUTH_UNKNOWN || 'block').trim().toLowerCase();
  if (unknown !== 'block' && unknown !== 'allow') {
    throw new Error('EMAIL_AUTH_UNKNOWN must be "block" or "allow"');
  }
  const requireRaw = (env.EMAIL_AUTH_REQUIRE_FROM_DOMAIN || 'true')
    .trim()
    .toLowerCase();
  const requireFromDomain = ['1', 'true', 'on'].includes(requireRaw);
  if (!requireFromDomain && !['0', 'false', 'off'].includes(requireRaw)) {
    throw new Error(
      'EMAIL_AUTH_REQUIRE_FROM_DOMAIN must be "true" or "false" (also 1, on, 0, off)',
    );
  }
  if (mode === 'enforce' && trusted.size === 0) {
    throw new Error(
      'EMAIL_AUTH_MODE=enforce needs EMAIL_AUTH_TRUSTED_AUTHSERV_IDS: with no trusted mail server no message can be authenticated. Set the list, or use EMAIL_AUTH_MODE=flag.',
    );
  }
  return { mode, trusted, unknown, requireFromDomain };
}

function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at < 0 ? '' : address.slice(at + 1).toLowerCase();
  return HOST_NAME.test(domain) ? domain : '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

const unauthenticated = (reason: string): EmailAuthDecision => ({
  verdict: 'unauthenticated',
  reason,
});

/**
 * Turn the worker's record into one verdict for the address in `from`.
 *
 * - "unknown" has two causes and no other: nobody was asked, or the mail
 *   platform said nothing. Nobody was asked: the host trusts no server, the
 *   payload has no `auth` field (an intake that does not report), or the
 *   worker has no platform set. The platform said nothing: no header in the
 *   message carries its name. None of these is something the sender of a
 *   message can bring about.
 * - "authenticated": a trusted server reports a DMARC pass and names the
 *   From domain as the one it checked. SPF and DKIM results are recorded
 *   and not used: a pass of either says nothing about the From header
 *   unless DMARC ties it to it, so a sender whose domain publishes no DMARC
 *   record is never "authenticated".
 * - "unauthenticated": everything else. A trusted server reported and no
 *   DMARC pass covers the From domain; or a header with the platform's name
 *   was in the message and could not be relied on (twice, extended, not
 *   the first, malformed); or the worker read results and none is from a
 *   server this host trusts; or the record itself is not in the form this
 *   code knows.
 *
 * `requireFromDomain` false lets a pass from the platform (never from a
 * forwarder) count without a named domain. See EMAIL_AUTH_REQUIRE_FROM_DOMAIN
 * in docs/setup-reference.md for when that is needed and what it gives up.
 */
export function emailAuthVerdict(
  from: unknown,
  auth: unknown,
  trusted: ReadonlySet<string>,
  options: { requireFromDomain?: boolean } = {},
): EmailAuthDecision {
  const requireFromDomain = options.requireFromDomain !== false;
  if (trusted.size === 0) {
    return { verdict: 'unknown', reason: 'no trusted mail server is set' };
  }
  if (auth === undefined || auth === null) {
    return {
      verdict: 'unknown',
      reason: 'the intake sent no authentication record',
    };
  }
  if (typeof auth !== 'object' || Array.isArray(auth)) {
    return unauthenticated('the authentication record is not readable');
  }
  const record = auth as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.results)) {
    return unauthenticated(
      'the authentication record is not in a form this host knows',
    );
  }
  const results = record.results as unknown[];
  const status = record.platform_status;
  if (status === 'unset' || status === 'absent') {
    // Said by the worker, never by the message. With results beside it the
    // record contradicts itself.
    if (results.length > 0) {
      return unauthenticated('the authentication record contradicts itself');
    }
    return {
      verdict: 'unknown',
      reason:
        status === 'unset'
          ? 'the intake has no mail platform set to read results from'
          : 'the mail platform wrote no result for this message',
    };
  }
  if (status === 'rejected') {
    return unauthenticated(
      "a header with the mail platform's name was in the message and could not be relied on",
    );
  }
  if (status !== 'read' && status !== undefined) {
    return unauthenticated(
      'the authentication record is not in a form this host knows',
    );
  }
  if (results.length === 0) {
    // `read` with nothing read, or a worker from before `platform_status`:
    // that one sent an empty list both when the platform wrote nothing and
    // when its header was there and unusable, and the two cannot be told
    // apart here.
    return unauthenticated(
      status === 'read'
        ? 'the authentication record contradicts itself'
        : 'the intake worker does not say why it read no result (deploy the current inbound/ worker)',
    );
  }
  if (
    !results.every(
      (r) =>
        !!r &&
        typeof r === 'object' &&
        !Array.isArray(r) &&
        typeof (r as Record<string, unknown>).authserv_id === 'string',
    ) ||
    results.length > 4
  ) {
    return unauthenticated('the authentication record is not readable');
  }
  const counted = (results as Record<string, unknown>[]).filter((r) =>
    trusted.has(text(r.authserv_id)),
  );
  if (counted.length === 0) {
    // The worker read a result and this host trusts none of the servers it
    // read. Not "unknown": with a forwarder trusted and the platform not,
    // whether a forwarder result is in the list depends on the route the
    // sender chose, and mail sent straight to the bot would get out of a
    // check the forwarded copy fails.
    return unauthenticated(
      'the intake read a result, and from no server this host trusts (EMAIL_AUTH_TRUSTED_AUTHSERV_IDS must name the mail platform the intake reads)',
    );
  }
  const ids = counted.map((r) => text(r.authserv_id)).join(', ');
  const fromDomain = domainOfAddress(text(from));
  if (!fromDomain) {
    return unauthenticated('no usable From address');
  }
  // One From header with one address. A count of 2 that comes only from
  // commas in the display name or in a comment (`from_display_commas`) is
  // looked past, and then the server must name the From domain whatever
  // the setting: the named domain is what ties the pass to this address
  // when two readers may have split the header differently.
  const displayCommas =
    record.from_mailboxes === 2 && record.from_display_commas === true;
  if (
    record.from_headers !== 1 ||
    (record.from_mailboxes !== 1 && !displayCommas)
  ) {
    return unauthenticated(
      `the message does not have exactly one From address (checked by ${ids})`,
    );
  }
  let unnamedPass = false;
  for (const r of counted) {
    const id = text(r.authserv_id);
    if (text(r.dmarc) !== 'pass') continue;
    // Only DMARC is used: it is the one check that is about the From
    // header. A named domain must be the From domain exactly.
    const dmarcFrom = text(r.dmarc_from);
    if (dmarcFrom) {
      if (dmarcFrom !== fromDomain) continue;
    } else {
      // No domain named. Only the mail platform may be taken at its word,
      // only when the deployer said so, and never for a From header that
      // needed the lenient reading.
      if (requireFromDomain || displayCommas || text(r.source) !== 'platform') {
        unnamedPass = true;
        continue;
      }
    }
    return {
      verdict: 'authenticated',
      reason: `DMARC pass for ${fromDomain} (${id})`,
    };
  }
  return unauthenticated(
    unnamedPass
      ? `a DMARC pass names no From domain, so it is not tied to ${fromDomain} (checked by ${ids})`
      : `no DMARC pass covers ${fromDomain} (checked by ${ids})`,
  );
}

/** enforce: true when a message with this verdict must not be processed. */
export function emailAuthBlocks(
  settings: EmailAuthSettings,
  verdict: EmailAuthVerdict,
): boolean {
  if (settings.mode !== 'enforce') return false;
  if (verdict === 'authenticated') return false;
  if (verdict === 'unknown') return settings.unknown === 'block';
  return true;
}
