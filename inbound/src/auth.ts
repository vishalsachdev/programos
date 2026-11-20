// What a trusted mail server recorded about SPF, DKIM, DMARC and ARC for one
// message. This file decides WHICH `Authentication-Results` headers are
// read; the host decides what they prove (`src/email-auth.ts` there).
//
// A header in a message proves nothing by itself: the sender can write any
// header, including one that names a server you trust. Each server adds its
// headers ABOVE the ones it received, so only position and a name the
// deployer set can separate a real header from a planted one. The rule:
//
// 1. Platform result. The FIRST `Authentication-Results` header in the
//    message is read only when its authserv-id equals PLATFORM_AUTHSERV_ID.
//    The mail platform that runs this worker puts its header first, so
//    every header the sender wrote is below it. No other header is ever
//    read as the platform's, whatever name it carries.
// 2. Forwarder result. One more header is read, the first one below the
//    platform header whose authserv-id is in FORWARDER_AUTHSERV_IDS, and
//    only when the platform result itself shows that a server of a domain
//    in FORWARDER_DOMAINS handed the message over: SPF passed for an
//    envelope sender in such a domain, or a DKIM signature of such a domain
//    passed. Without that proof a header naming the forwarder is ignored:
//    anyone can send a message straight to the bot's address with that
//    header in it.
// 3. Nothing else is read: no `ARC-*` header (this worker checks no
//    signature), no `Received-SPF`, no header below the ones above.
//
// With both settings empty (the default) nothing is read.

/** One trusted server's results, reduced to what the host uses. */
export interface AuthResult {
  source: 'platform' | 'forwarder';
  authserv_id: string;
  /** SPF result word (`pass`, `fail`, `none`, ...), '' when not reported. */
  spf: string;
  /** Domain SPF was checked for. '' when the server did not say. */
  spf_domain: string;
  /** Every DKIM result, with the signing domain (`header.d`) when given. */
  dkim: { result: string; domain: string }[];
  /** DMARC result word, '' when not reported. */
  dmarc: string;
  /** The From domain DMARC was checked for (`header.from`), '' if absent. */
  dmarc_from: string;
  /** ARC result word as that server reported it. Recorded, never used. */
  arc: string;
}

export interface AuthRecord {
  version: 1;
  /** Domain of the SMTP envelope sender, from the platform (not a header). */
  envelope_from_domain: string;
  /**
   * How many From header fields the message has, and how many mailboxes the
   * first one holds. Anything but 1 and 1 means two readers can disagree
   * about who the sender is, and the host then never calls it authenticated.
   */
  from_headers: number;
  from_mailboxes: number;
  results: AuthResult[];
}

export interface AuthTrust {
  platformAuthservId: string;
  forwarderAuthservIds: string[];
  forwarderDomains: string[];
}

export const NO_TRUST: AuthTrust = {
  platformAuthservId: '',
  forwarderAuthservIds: [],
  forwarderDomains: [],
};

const HOST_NAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A setting that lists host names: lower case, no duplicates, or an error. */
export function hostNameList(value: string | undefined, key: string): string[] {
  const out: string[] = [];
  for (const part of (value ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if (!HOST_NAME.test(name)) {
      throw new Error(`${key} must be a comma-separated list of host names`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** Remove RFC 5322 comments (nested parentheses) outside quoted strings. */
function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && i + 1 < value.length) {
      if (depth === 0) out += ch + value[i + 1];
      i++;
    } else if (quoted) {
      out += ch;
      if (ch === '"') quoted = false;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
      if (depth === 0) out += ' ';
    } else if (depth === 0) {
      out += ch;
      if (ch === '"') quoted = true;
    }
  }
  return out;
}

function domainOf(value: string): string {
  const cleaned = value.replace(/^"|"$/g, '').trim().toLowerCase();
  const domain = cleaned.includes('@')
    ? cleaned.slice(cleaned.lastIndexOf('@') + 1)
    : cleaned;
  return HOST_NAME.test(domain) ? domain : '';
}

interface Parsed {
  authservId: string;
  methods: { method: string; result: string; props: Map<string, string> }[];
}

/**
 * Read one `Authentication-Results` value (RFC 8601). Returns null when the
 * value has no authserv-id: such a header cannot be tied to a named server.
 */
export function parseAuthenticationResults(value: string): Parsed | null {
  // A quoted string can hold text the sender chose (an envelope address
  // such as "a; dmarc=pass"@example.net). Replace each with a plain word
  // before splitting, so nothing inside quotes can look like a result. An
  // unclosed quote makes the whole header unusable.
  const unquoted = stripComments(value).replace(/"(?:[^"\\]|\\.)*"/g, 'q');
  if (unquoted.includes('"')) return null;
  const parts = unquoted.split(';').map((p) => p.replace(/\s+/g, ' ').trim());
  // "authserv-id" or "authserv-id 1". A first part with "=" in it is a
  // result with no server name in front.
  const head = parts.shift() ?? '';
  const id = head.split(' ')[0].toLowerCase();
  if (!id || head.includes('=') || !HOST_NAME.test(id)) return null;
  const methods: Parsed['methods'] = [];
  for (const part of parts) {
    const tokens = part.split(' ').filter(Boolean);
    const first = /^([a-z0-9-]+)(?:\/\d+)?=([a-z]+)$/i.exec(tokens[0] ?? '');
    if (!first) continue;
    const props = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq <= 0) continue;
      const name = token.slice(0, eq).toLowerCase();
      if (!props.has(name)) props.set(name, token.slice(eq + 1));
    }
    methods.push({
      method: first[1].toLowerCase(),
      result: first[2].toLowerCase(),
      props,
    });
  }
  return { authservId: id, methods };
}

function toResult(
  parsed: Parsed,
  source: AuthResult['source'],
  envelopeDomain: string,
): AuthResult {
  const first = (method: string) =>
    parsed.methods.find((m) => m.method === method);
  const spf = first('spf');
  const dmarc = first('dmarc');
  return {
    source,
    authserv_id: parsed.authservId,
    spf: spf?.result ?? '',
    // The platform checked SPF for the envelope sender it gave this worker.
    // A forwarder checked it for the sender it saw, which only its own
    // header names.
    spf_domain:
      domainOf(spf?.props.get('smtp.mailfrom') ?? '') ||
      (source === 'platform' && spf ? envelopeDomain : ''),
    dkim: parsed.methods
      .filter((m) => m.method === 'dkim')
      .slice(0, 10)
      .map((m) => ({
        result: m.result,
        domain: domainOf(m.props.get('header.d') ?? ''),
      })),
    dmarc: dmarc?.result ?? '',
    dmarc_from: domainOf(dmarc?.props.get('header.from') ?? ''),
    arc: first('arc')?.result ?? '',
  };
}

/** True when the platform result shows a forwarder's server handed it over. */
function cameThroughForwarder(platform: AuthResult, trust: AuthTrust): boolean {
  const listed = (domain: string) =>
    domain !== '' && trust.forwarderDomains.includes(domain);
  return (
    (platform.spf === 'pass' && listed(platform.spf_domain)) ||
    platform.dkim.some((d) => d.result === 'pass' && listed(d.domain))
  );
}

/**
 * Apply the rule at the top of this file. `headers` is every header of the
 * message in the order it has in the raw bytes, first header first.
 */
export function readAuth(
  headers: { key: string; value: string }[],
  envelopeFrom: string,
  fromMailboxes: number,
  trust: AuthTrust,
): AuthRecord {
  const envelopeDomain = domainOf(envelopeFrom);
  const record: AuthRecord = {
    version: 1,
    envelope_from_domain: envelopeDomain,
    from_headers: headers.filter((h) => h.key === 'from').length,
    from_mailboxes: fromMailboxes,
    results: [],
  };
  const all = headers.filter((h) => h.key === 'authentication-results');
  if (!trust.platformAuthservId || all.length === 0) return record;

  const top = parseAuthenticationResults(all[0].value);
  if (!top || top.authservId !== trust.platformAuthservId) return record;
  const platform = toResult(top, 'platform', envelopeDomain);
  record.results.push(platform);

  if (!cameThroughForwarder(platform, trust)) return record;
  for (const header of all.slice(1)) {
    const parsed = parseAuthenticationResults(header.value);
    if (!parsed || !trust.forwarderAuthservIds.includes(parsed.authservId))
      continue;
    // A forwarder that is also the platform would have been read above.
    if (parsed.authservId === trust.platformAuthservId) continue;
    record.results.push(toResult(parsed, 'forwarder', envelopeDomain));
    break;
  }
  return record;
}

/** One line for the Markdown copy. Built only from the record above. */
export function authLine(record: AuthRecord): string {
  if (record.results.length === 0) return 'no trusted result';
  return record.results
    .map((r) => {
      const dkim = r.dkim.length
        ? r.dkim
            .map((d) => `dkim=${d.result}${d.domain ? ` (${d.domain})` : ''}`)
            .join(' ')
        : 'dkim=';
      const spf = `spf=${r.spf}${r.spf_domain ? ` (${r.spf_domain})` : ''}`;
      const dmarc = `dmarc=${r.dmarc}${r.dmarc_from ? ` (${r.dmarc_from})` : ''}`;
      return `${r.source} ${r.authserv_id}: ${spf} ${dkim} ${dmarc}${r.arc ? ` arc=${r.arc}` : ''}`;
    })
    .join('; ');
}
