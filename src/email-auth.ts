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
}

export interface EmailAuthDecision {
  verdict: EmailAuthVerdict;
  /** One line for the audit log. No text from the message is in it. */
  reason: string;
}

const HOST_NAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Read the three settings. Throws on a value that is not one of the listed
 * ones, and on "enforce" with no trusted server: that would block every
 * message, or (with EMAIL_AUTH_UNKNOWN=allow) check nothing while saying
 * "enforce".
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
  if (mode === 'enforce' && trusted.size === 0) {
    throw new Error(
      'EMAIL_AUTH_MODE=enforce needs EMAIL_AUTH_TRUSTED_AUTHSERV_IDS: with no trusted mail server no message can be authenticated. Set the list, or use EMAIL_AUTH_MODE=flag.',
    );
  }
  return { mode, trusted, unknown };
}

/** Start-up check: the host does not start on a setting that cannot work. */
export function assertEmailAuthConfigured(): void {
  readEmailAuthSettings();
}

function domainOfAddress(address: string): string {
  const at = address.lastIndexOf('@');
  const domain = at < 0 ? '' : address.slice(at + 1).toLowerCase();
  return HOST_NAME.test(domain) ? domain : '';
}

/**
 * True when a domain a server authenticated stands for the From domain: the
 * same domain, or a parent of it that has at least two labels. DMARC's
 * "relaxed" alignment also accepts two different subdomains of one
 * organisation; that needs the public suffix list and is not accepted here,
 * so such mail gets "unauthenticated", never a wrong "authenticated".
 */
export function domainAligned(authenticated: string, from: string): boolean {
  if (!authenticated || !from) return false;
  if (authenticated === from) return true;
  return authenticated.includes('.') && from.endsWith(`.${authenticated}`);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * Turn the worker's record into one verdict for the address in `from`.
 *
 * - "unknown": no result from a server in `trusted` (no `auth` field, an
 *   empty one, or only servers the host was not told to believe).
 * - "authenticated": a trusted server reports a pass that covers the From
 *   domain: DMARC pass for that domain, a DKIM pass signed by an aligned
 *   domain, or an SPF pass for an aligned envelope domain.
 * - "unauthenticated": a trusted server reported, and nothing it reported
 *   covers the From domain. A pass for another domain is in this group.
 */
export function emailAuthVerdict(
  from: unknown,
  auth: unknown,
  trusted: ReadonlySet<string>,
): EmailAuthDecision {
  if (trusted.size === 0) {
    return { verdict: 'unknown', reason: 'no trusted mail server is set' };
  }
  const record =
    auth && typeof auth === 'object' ? (auth as Record<string, unknown>) : {};
  const counted = (Array.isArray(record.results) ? record.results : [])
    .filter(
      (r): r is Record<string, unknown> =>
        !!r && typeof r === 'object' && trusted.has(text(r.authserv_id)),
    )
    .slice(0, 4);
  if (record.version !== 1 || counted.length === 0) {
    return {
      verdict: 'unknown',
      reason: 'the intake sent no result from a trusted mail server',
    };
  }
  const ids = counted.map((r) => text(r.authserv_id)).join(', ');
  const fromDomain = domainOfAddress(text(from));
  if (!fromDomain) {
    return { verdict: 'unauthenticated', reason: 'no usable From address' };
  }
  if (record.from_headers !== 1 || record.from_mailboxes !== 1) {
    return {
      verdict: 'unauthenticated',
      reason: `the message does not have exactly one From address (checked by ${ids})`,
    };
  }
  for (const r of counted) {
    const id = text(r.authserv_id);
    const dmarcFrom = text(r.dmarc_from);
    // The mail platform checks DMARC for the From header of the message it
    // hands over and may not name the domain. A forwarder must name it.
    if (
      text(r.dmarc) === 'pass' &&
      (dmarcFrom
        ? domainAligned(dmarcFrom, fromDomain)
        : text(r.source) === 'platform')
    ) {
      return {
        verdict: 'authenticated',
        reason: `DMARC pass for ${fromDomain} (${id})`,
      };
    }
    for (const sig of Array.isArray(r.dkim) ? r.dkim.slice(0, 10) : []) {
      if (!sig || typeof sig !== 'object') continue;
      const s = sig as Record<string, unknown>;
      if (
        text(s.result) === 'pass' &&
        domainAligned(text(s.domain), fromDomain)
      ) {
        return {
          verdict: 'authenticated',
          reason: `DKIM pass signed by ${text(s.domain)} (${id})`,
        };
      }
    }
    if (
      text(r.spf) === 'pass' &&
      domainAligned(text(r.spf_domain), fromDomain)
    ) {
      return {
        verdict: 'authenticated',
        reason: `SPF pass for envelope domain ${text(r.spf_domain)} (${id})`,
      };
    }
  }
  return {
    verdict: 'unauthenticated',
    reason: `no pass covers ${fromDomain} (checked by ${ids})`,
  };
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
