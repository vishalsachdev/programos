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
// 3. A header that is read must hold exactly one DMARC result, at most one
//    SPF result for each identity (the envelope sender, the HELO name; see
//    `toResult`), no part that is not a result, no comment that is still
//    open at its end, and no property twice in one result (see
//    `readHeader`). Otherwise it is dropped whole. A dropped header keeps
//    its place: no header below it is read in its stead.
// 4. Nothing else is read: no `ARC-*` header (this worker checks no
//    signature), no `Received-SPF`, no header below the ones above.
//
// With both settings empty (the default) nothing is read.
//
// The record also says what became of the platform's result
// (`platform_status`), because "the platform wrote nothing" and "a header
// with the platform's name was there and could not be relied on" are not
// the same thing to the host: the first is nobody's doing, the second can
// be the sender's. Only the first may end as the verdict "unknown".

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
  /**
   * True when `from_mailboxes` is 2 for one reason only: a comma in an
   * unquoted display name or in a comment, beside the one address in angle
   * brackets (`Lee, Dana <dlee@example.edu>`). A reader that follows RFC
   * 5322 takes such a header as one mailbox; one that splits at every comma
   * does not. The host accepts it only together with a DMARC result that
   * names the domain of that address.
   */
  from_display_commas: boolean;
  /**
   * What became of the platform's result:
   * - `unset`: PLATFORM_AUTHSERV_ID is empty, nothing was looked for.
   * - `absent`: no header in the message carries the platform's name, or
   *   the platform's header says that it made no check (`none`).
   * - `read`: the platform's header is the first entry of `results`.
   * - `rejected`: a header carries the platform's name and no result was
   *   taken from it (not the first header, there twice, not the one the
   *   platform's API reports, or in a form that cannot be relied on).
   */
  platform_status: PlatformStatus;
  results: AuthResult[];
}

export type PlatformStatus = 'unset' | 'absent' | 'read' | 'rejected';

/** What `mail.ts` found in the From header text (`fromMailboxes` there). */
export interface FromCount {
  count: number;
  displayCommas: boolean;
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
  for (const [index, part] of parts.entries()) {
    const tokens = part.split(' ').filter(Boolean);
    // Nothing after the last ";", and the word a server writes when it made
    // no check ("authserv-id; none"), are not results and not errors.
    if (tokens.length === 0 && index === parts.length - 1) continue;
    if (parts.length === 1 && part.toLowerCase() === 'none') continue;
    const first = /^([a-z0-9-]+)(?:\/\d+)?=([a-z]+)$/i.exec(tokens[0] ?? '');
    // A part that is not "method=result": it may be the server's real
    // result in a form this code does not read, or what is left of one
    // after sender text got into the header. Either way the results that
    // can be read are not the whole of what the server said.
    if (!first) return unusable;
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
 * comment still open at the end, a property given twice in one result, a
 * part between two ";" that is not a result.
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
 * Reduce one parsed header, or return null when it cannot be relied on.
 *
 * A header must carry exactly one DMARC result. It may carry one SPF result
 * for the envelope sender and one for the HELO name, as RFC 8601 section
 * 2.7.2 registers them (`smtp.mailfrom`, `smtp.helo`): a server that checks
 * both identities writes two results. An SPF result with neither property
 * is taken as the one for the envelope sender. More than one result for the
 * same identity means text was added to the header: by a continuation line
 * at the top of the sender's own headers, or by sender text that a server
 * copied into a comment and that closed the comment early. Such a header
 * is dropped whole, whichever of the two results came first.
 *
 * The platform checked SPF for the envelope sender it gave this worker. A
 * platform result that names another domain in `smtp.mailfrom` is therefore
 * not the platform's own, and the header is dropped. This is what keeps an
 * added "spf=pass smtp.mailfrom=<a forwarder's domain>" from opening the
 * forwarder rule when the platform itself wrote a HELO result only.
 */
function toResult(
  parsed: Parsed,
  source: AuthResult['source'],
  envelopeDomain: string,
): AuthResult | null {
  const of = (method: string) =>
    parsed.methods.filter((m) => m.method === method);
  const dmarcs = of('dmarc');
  if (dmarcs.length !== 1) return null;
  const dmarc = dmarcs[0];
  const spfs = of('spf');
  const forSender = spfs.filter(
    (m) => !m.props.has('smtp.helo') || m.props.has('smtp.mailfrom'),
  );
  const forHelo = spfs.filter(
    (m) => m.props.has('smtp.helo') && !m.props.has('smtp.mailfrom'),
  );
  if (forSender.length > 1 || forHelo.length > 1) return null;
  // The result the host is told about is the one for the envelope sender.
  // A HELO result alone is reported with no domain, so it can never stand
  // for the envelope sender.
  const spf = forSender[0] ?? forHelo[0];
  let spfDomain = '';
  if (forSender[0]) {
    const mailfrom = forSender[0].props.get('smtp.mailfrom');
    if (mailfrom === undefined) {
      // A forwarder checked SPF for the sender it saw, which only its own
      // header names.
      if (source === 'platform') spfDomain = envelopeDomain;
    } else {
      spfDomain = domainProp(mailfrom);
      if (source === 'platform' && spfDomain !== (envelopeDomain || 'invalid'))
        return null;
    }
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
  from: FromCount,
  trust: AuthTrust,
  platformHeader?: string | null,
): AuthRecord {
  const envelopeDomain = domainOf(envelopeFrom);
  const record: AuthRecord = {
    version: 1,
    envelope_from_domain: envelopeDomain,
    // "From :" and a line with no colon are From headers to some readers.
    from_headers: headers.filter((h) => /^from(\s|$)/.test(h.key)).length,
    from_mailboxes: from.count,
    from_display_commas: from.displayCommas,
    platform_status: 'unset',
    results: [],
  };
  if (!trust.platformAuthservId) return record;
  // A header name with a space before the colon is the same header to some
  // readers, so it is looked at too.
  const all = headers
    .filter((h) => h.key.trim() === 'authentication-results')
    .map((h) => ({ value: h.value, ...readHeader(h.value) }));

  const named = all.filter((h) => h.authservId === trust.platformAuthservId);
  // No header says it is the platform's. The platform puts its header
  // above everything the sender wrote and the sender cannot take it out,
  // so this state is not one the sender can bring about.
  record.platform_status = 'absent';
  if (named.length === 0) return record;

  // From here on a header with the platform's name is in the message.
  // Whatever stops it from being read, the message does not go back to
  // "absent": every reason below is one a sender can cause.
  record.platform_status = 'rejected';
  const top = all[0];
  if (!top.parsed || top.authservId !== trust.platformAuthservId) return record;
  // The platform's name on a second header: one of the two is planted, and
  // position alone should not decide which. A second header that cannot be
  // relied on counts too.
  if (named.length !== 1) return record;
  // The first header in the raw bytes must be the one the platform's API
  // reports first. If the platform did not put its header into the raw
  // message, the first one there was written by the sender.
  if (!platformHeader || !squash(platformHeader).startsWith(squash(top.value)))
    return record;
  // "authserv-id; none": the platform says it made no check.
  if (top.parsed.methods.length === 0) {
    record.platform_status = 'absent';
    return record;
  }
  const platform = toResult(top.parsed, 'platform', envelopeDomain);
  if (!platform) return record;
  record.platform_status = 'read';
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
  if (record.results.length === 0)
    return record.platform_status === 'rejected'
      ? 'a header with the platform name could not be relied on'
      : 'no trusted result';
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
