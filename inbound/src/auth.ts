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
//    message is read only when its authserv-id equals PLATFORM_AUTHSERV_ID,
//    no other header carries that name, and it is the header the platform's
//    own API (`message.headers`) reports first. The mail platform that runs
//    this worker puts its header first, so every header the sender wrote is
//    below it.
// 2. Forwarder result. One more header is read, the first one below the
//    platform header whose authserv-id is in FORWARDER_AUTHSERV_IDS, and
//    only when the platform result itself shows that a server of a domain
//    in FORWARDER_DOMAINS handed the message over: SPF passed for an
//    envelope sender in such a domain. Without that proof a header naming
//    the forwarder is ignored: anyone can send a message straight to the
//    bot's address with that header in it.
// 3. A header that is read must hold exactly one DMARC result and at most
//    one SPF result (see `toResult`), no comment that is still open at its
//    end, and no property twice in one result (see `readHeader`). Otherwise
//    it is dropped whole. A dropped header keeps its place: no header
//    below it is read in its stead.
// 4. Nothing else is read: no `ARC-*` header (this worker checks no
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
   * How many From header fields the message has, and how many different
   * addresses the first one holds (display name included). Anything but 1 and 1 means two readers can disagree
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

/**
 * Remove RFC 5322 comments (nested parentheses) outside quoted strings.
 * `open` is true when a comment is still open at the end of the value: the
 * text after it was removed with it, and that text may hold the server's
 * real results (sender text copied into a comment can open one more comment
 * than the server closes).
 */
function stripComments(value: string): { text: string; open: boolean } {
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
  return { text: out, open: depth > 0 };
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
 * One header as `readAuth` uses it. `authservId` is the server the header
 * names ('' when it names none). `parsed` is null when the header names no
 * server, or names one and cannot be relied on. The two are kept apart
 * because a header that cannot be relied on still holds its place: it is
 * still "the first header that names the forwarder", and the next one below
 * it, which the sender may have written, must not be read in its stead.
 */
interface Header {
  authservId: string;
  parsed: Parsed | null;
}

function readHeader(value: string): Header {
  // A quoted string can hold text the sender chose (an envelope address
  // such as "a; dmarc=pass"@example.net). Replace each with a plain word
  // before splitting, so nothing inside quotes can look like a result. An
  // unclosed quote makes the whole header unusable, and so does a comment
  // that is still open at the end.
  const stripped = stripComments(value);
  const unquoted = stripped.text.replace(/"(?:[^"\\]|\\.)*"/g, 'q');
  const parts = unquoted.split(';').map((p) => p.replace(/\s+/g, ' ').trim());
  // "authserv-id" or "authserv-id 1". A first part with "=" in it is a
  // result with no server name in front.
  const head = parts.shift() ?? '';
  const id = head.split(' ')[0].toLowerCase();
  if (!id || head.includes('=') || !HOST_NAME.test(id))
    return { authservId: '', parsed: null };
  const unusable: Header = { authservId: id, parsed: null };
  if (stripped.open || unquoted.includes('"')) return unusable;
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
      // A server writes each property of a result once. A second
      // `smtp.mailfrom` or `header.from` means text was added (sender text
      // in a comment that closes the comment and opens it again), and
      // neither position says which of the two is the server's.
      if (props.has(name)) return unusable;
      props.set(name, token.slice(eq + 1));
    }
    methods.push({
      method: first[1].toLowerCase(),
      result: first[2].toLowerCase(),
      props,
    });
  }
  return { authservId: id, parsed: { authservId: id, methods } };
}

/**
 * Read one `Authentication-Results` value (RFC 8601). Returns null when the
 * value has no authserv-id (such a header cannot be tied to a named
 * server), and when the header cannot be relied on: an unclosed quote, a
 * comment still open at the end, a property given twice in one result.
 */
export function parseAuthenticationResults(value: string): Parsed | null {
  return readHeader(value).parsed;
}

/** '' when the property is absent, 'invalid' when it is not a host name. */
function domainProp(value: string | undefined): string {
  if (value === undefined) return '';
  return domainOf(value) || 'invalid';
}

/**
 * Reduce one parsed header, or return null when it cannot be relied on. A
 * header must carry exactly one DMARC result and at most one SPF result.
 * A second one means text was added to the header: by a continuation line
 * at the top of the sender's own headers, or by sender text that a server
 * copied into a comment and that closed the comment early. Such a header
 * is dropped whole, whichever of the two results came first.
 */
function toResult(
  parsed: Parsed,
  source: AuthResult['source'],
  envelopeDomain: string,
): AuthResult | null {
  const of = (method: string) =>
    parsed.methods.filter((m) => m.method === method);
  const spfs = of('spf');
  const dmarcs = of('dmarc');
  if (dmarcs.length !== 1 || spfs.length > 1) return null;
  const spf = spfs[0];
  const dmarc = dmarcs[0];
  // The platform checked SPF for the envelope sender it gave this worker,
  // unless its result names another identity (the HELO name). A forwarder
  // checked it for the sender it saw, which only its own header names.
  let spfDomain = '';
  if (spf) {
    const mailfrom = spf.props.get('smtp.mailfrom');
    if (mailfrom !== undefined) spfDomain = domainProp(mailfrom);
    else if (source === 'platform' && !spf.props.has('smtp.helo'))
      spfDomain = envelopeDomain;
  }
  return {
    source,
    authserv_id: parsed.authservId,
    spf: spf?.result ?? '',
    spf_domain: spfDomain,
    dkim: of('dkim')
      .slice(0, 10)
      .map((m) => ({
        result: m.result,
        domain: domainProp(m.props.get('header.d')),
      })),
    dmarc: dmarc.result,
    dmarc_from: domainProp(dmarc.props.get('header.from')),
    arc: of('arc')[0]?.result ?? '',
  };
}

/**
 * True when the platform result shows a forwarder's server handed the
 * message over: SPF passed for an envelope sender in a listed domain. A
 * DKIM signature is not used as proof here.
 */
function cameThroughForwarder(platform: AuthResult, trust: AuthTrust): boolean {
  return (
    platform.spf === 'pass' &&
    trust.forwarderDomains.includes(platform.spf_domain)
  );
}

const squash = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * Apply the rule at the top of this file. `headers` is every header of the
 * message in the order it has in the raw bytes, first header first.
 * `platformHeader` is what the mail platform's own API returns for
 * `Authentication-Results` (`message.headers.get(...)`); the sender cannot
 * set it apart from the raw bytes.
 */
export function readAuth(
  headers: { key: string; value: string }[],
  envelopeFrom: string,
  fromMailboxes: number,
  trust: AuthTrust,
  platformHeader?: string | null,
): AuthRecord {
  const envelopeDomain = domainOf(envelopeFrom);
  const record: AuthRecord = {
    version: 1,
    envelope_from_domain: envelopeDomain,
    // "From :" and a line with no colon are From headers to some readers.
    from_headers: headers.filter((h) => /^from(\s|$)/.test(h.key)).length,
    from_mailboxes: fromMailboxes,
    results: [],
  };
  const all = headers
    .filter((h) => h.key === 'authentication-results')
    .map((h) => ({ value: h.value, ...readHeader(h.value) }));
  if (!trust.platformAuthservId || all.length === 0) return record;

  const top = all[0];
  if (!top.parsed || top.authservId !== trust.platformAuthservId) return record;
  // The platform's name on a second header: one of the two is planted, and
  // position alone should not decide which. A second header that cannot be
  // relied on counts too.
  if (all.filter((h) => h.authservId === trust.platformAuthservId).length !== 1)
    return record;
  // The first header in the raw bytes must be the one the platform's API
  // reports first. If the platform did not put its header into the raw
  // message, the first one there was written by the sender.
  if (!platformHeader || !squash(platformHeader).startsWith(squash(top.value)))
    return record;
  const platform = toResult(top.parsed, 'platform', envelopeDomain);
  if (!platform) return record;
  record.results.push(platform);

  if (!cameThroughForwarder(platform, trust)) return record;
  for (const header of all.slice(1)) {
    if (!trust.forwarderAuthservIds.includes(header.authservId)) continue;
    // The first header that names the forwarder is the only candidate,
    // also when it cannot be relied on: the search stops at it.
    const forwarder =
      header.parsed && toResult(header.parsed, 'forwarder', envelopeDomain);
    if (forwarder) record.results.push(forwarder);
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
