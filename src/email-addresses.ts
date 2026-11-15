/** A complete body token and its cleaned comparison value, never a substring reading. */
export interface EmailAddressToken {
  start: number;
  end: number;
  raw: string;
  address: string;
}

/** Detection/comparison only: preserve the original body, token spelling and offsets. */
export function normalizeAddressDetectionText(text: string): string {
  // NFKC also maps full-width @, full-width/full-stop compatibility forms,
  // and other compatibility characters to their comparison identity.
  // U+3002 does not normalize under NFKC; U+FF61 normalizes to U+3002.
  return text.normalize('NFKC').replace(/[\u3002\uFF0E\uFF61]/g, '.');
}

const WRAPPER_PAIRS: Record<string, string> = {
  "'": "'",
  '"': '"',
  '(': ')',
  '[': ']',
  '<': '>',
  '`': '`',
};
const SPLIT_CHARS = '()[]<>,;';
const URI_PUNCTUATION = new Set("._~:/?#@!$&'()*+,;=%[]-");
function outerBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char) || SPLIT_CHARS.includes(char);
}

/** Only complete line-edge table rows establish cell boundaries. */
function tableBoundaries(text: string): Uint8Array {
  const boundaries = new Uint8Array(text.length);
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    let left = start,
      right = end;
    while (left < right && /\s/u.test(text[left])) left++;
    while (right > left && /\s/u.test(text[right - 1])) right--;
    if (right - left > 1 && text[left] === '|' && text[right - 1] === '|') {
      for (let i = left; i < right; i++) if (text[i] === '|') boundaries[i] = 1;
    }
    start = end + 1;
  }
  return boundaries;
}

/** URL recognition covers the whole token; markup/control characters cannot extend its scope. */
function isWholeUrl(address: string, at: number): boolean {
  const slash = address.indexOf('/');
  if (
    slash < 0 ||
    slash >= at ||
    !(
      address.startsWith('http://') ||
      address.startsWith('https://') ||
      address.startsWith('www.')
    )
  )
    return false;
  // URL link detectors end a URL at unmatched grouping punctuation. Require
  // balanced, correctly ordered parentheses before exempting the whole token.
  let depth = 0;
  for (let i = 0; i < address.length; i++) {
    const char = address[i];
    // Only URI characters can establish a URL exemption. IRI punctuation,
    // quotes and controls can instead delimit a separate rendered contact.
    if (!/[A-Za-z0-9]/.test(char) && !URI_PUNCTUATION.has(char)) return false;
    if (char === '%' && !/^[A-Fa-f0-9]{2}$/.test(address.slice(i + 1, i + 3)))
      return false;
    // Preserve intraword apostrophes, but fail closed on ambiguous quote markup.
    if (
      char === "'" &&
      (!/[A-Za-z0-9]/.test(address[i - 1] ?? '') ||
        !/[A-Za-z0-9]/.test(address[i + 1] ?? ''))
    )
      return false;
    if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return false;
    if (char === '@') {
      // This is only an exemption veto, never a shortened comparison value.
      // A wrapper directly before an address-like local part can expose a
      // separate contact even when the surrounding token parses as a URL.
      let localStart = i;
      while (localStart > 0 && /[A-Za-z0-9._%+-]/.test(address[localStart - 1]))
        localStart--;
      if (localStart > 0 && '(<[\'"'.includes(address[localStart - 1]))
        return false;
    }
  }
  if (depth !== 0) return false;
  try {
    const url = new URL(
      address.startsWith('www.') ? `https://${address}` : address,
    );
    // WHATWG parsing accepts hostnames such as www. and example.org..;
    // those must not exempt a token that can render a separate mailbox.
    if (
      !url.hostname.includes('.') ||
      url.hostname.split('.').some((label) => !label)
    )
      return false;
    // Brackets are URI syntax only for an IPv6 authority, not a mailbox-bearing path/query.
    const rest = url.pathname + url.search + url.hash;
    return !rest.includes('[') && !rest.includes(']');
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return false;
  }
}

/** Balanced wrappers can be removed; an unmatched character is mailbox identity. */
function cleanToken(raw: string): string {
  let left = 0,
    right = raw.length;
  let removedMailto = false;
  while (left < right) {
    if ('.:!?,;'.includes(raw[right - 1])) {
      right--;
      continue;
    }
    if (right - left > 1 && WRAPPER_PAIRS[raw[left]] === raw[right - 1]) {
      left++;
      right--;
      continue;
    }
    if (
      !removedMailto &&
      raw.slice(left, left + 7).toLowerCase() === 'mailto:'
    ) {
      left += 7;
      removedMailto = true;
      continue;
    }
    break;
  }
  return raw.slice(left, right).toLowerCase();
}

/** A quoted local part followed by @ includes its spaces and escaped quotes. */
function quotedMailboxEnds(text: string): Map<number, number> {
  const ends = new Map<number, number>();
  if (!text.includes('"')) return ends;
  let lastQuote = -1;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    if (escaped) escaped = false;
    else if (text[i] === '\\') escaped = true;
    else if (text[i] === '"') {
      if (lastQuote >= 0 && text[i + 1] === '@') ends.set(lastQuote, i + 1);
      lastQuote = i;
    }
  }
  return ends;
}

/** Linear whole-token scan shared with the container; never grants a substring reading. */
export function emailAddressTokensInText(text: string): EmailAddressToken[] {
  const detectionText = normalizeAddressDetectionText(text);
  if (!detectionText.includes('@') || !detectionText.includes('.')) return [];
  const cells = tableBoundaries(text);
  const quotedEnds = quotedMailboxEnds(text);
  const isBoundary = (i: number): boolean => {
    const char = text[i];
    if (/\s/u.test(char) || cells[i]) return true;
    // Quotes, brackets and backticks stay in the token until balanced cleanup.
    return (
      ',;'.includes(char) &&
      (outerBoundary(text[i - 1]) || outerBoundary(text[i + 1]))
    );
  };
  const tokens: EmailAddressToken[] = [];
  for (let cursor = 0; cursor < text.length; ) {
    if (isBoundary(cursor)) {
      cursor++;
      continue;
    }
    const start = cursor;
    while (cursor < text.length && !isBoundary(cursor))
      cursor = quotedEnds.get(cursor) ?? cursor + 1;
    const raw = text.slice(start, cursor);
    // Normalize each complete token before any address/URL/handle decision.
    // Keep original token boundaries: normalization must never grant trust
    // to a shorter reading, change sent bytes, or move host-note offsets.
    const normalized = normalizeAddressDetectionText(raw);
    if (!normalized.includes('@')) continue;
    const address = cleanToken(normalized);
    const at = address.indexOf('@');
    if (isWholeUrl(address, at)) continue;
    if (
      (at === 0 && address.indexOf('@', 1) === -1) ||
      address.indexOf('.', at + 1) === -1
    )
      continue;
    tokens.push({ start, end: cursor, raw, address });
  }
  return tokens;
}

/** Exact cleaned tokens only; URL and handle exemptions are whole-token decisions. */
export function emailAddressesInText(text: string): string[] {
  return [
    ...new Set(emailAddressTokensInText(text).map((token) => token.address)),
  ];
}

/** Raw intake trusts whole tokens, with a variant only for matching surrounding underscore runs. */
export function inboundEmailAddressesInText(text: string): string[] {
  const addresses = new Set<string>();
  for (const { address } of emailAddressTokensInText(text)) {
    addresses.add(address);
    let left = 0;
    let right = address.length;
    while (address[left] === '_') left++;
    while (right > left && address[right - 1] === '_') right--;
    if (left > 0 && left === address.length - right)
      addresses.add(address.slice(left, right));
  }
  return [...addresses];
}
