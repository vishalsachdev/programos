import { Parser } from 'htmlparser2';
import {
  inboundEmailAddressesInText,
  normalizeAddressDetectionText,
} from './email-addresses.js';

// HTML parsing is intake-only. Outgoing text is always checked as provider bytes.
const BLOCK_ELEMENTS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Exact received HTML contacts: decoded text and mailto targets, never substrings. */
export function inboundEmailAddressesInHtml(html: string): string[] {
  const text: string[] = [];
  const targets: string[] = [];
  const openCounts = new Map<string, number>();
  class EvidenceParser extends Parser {
    override onclosetag(start: number, endIndex: number): void {
      const name = html.slice(start, endIndex).toLowerCase();
      if (!openCounts.has(name) && !this.isVoidElement(name)) {
        // Parser's absent-name stack search is quadratic for deep malformed
        // HTML. Ignore orphan closers in O(1); matched searches are amortized
        // linear because every visited stack entry is immediately popped.
        this.endIndex = endIndex;
        this.startIndex = endIndex + 1;
        // HTML's orphan </p> implies an empty paragraph, hence a text boundary.
        if (name === 'p') text.push('\n', '\n');
        return;
      }
      super.onclosetag(start, endIndex);
    }
  }
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch (err) {
      if (!(err instanceof URIError)) throw err;
      return value;
    }
  };
  const addRecipients = (value: string) => {
    // Recipient-bearing URI header values are decoded before header syntax is
    // interpreted. Commas inside an RFC quoted local part remain its identity.
    const decoded = decode(value);
    const recipients: string[] = [];
    let start = 0;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < decoded.length; i++) {
      const char = decoded[i];
      if (escaped) escaped = false;
      else if (quoted && char === '\\') escaped = true;
      else if (char === '"') quoted = !quoted;
      else if (!quoted && char === ',') {
        recipients.push(decoded.slice(start, i));
        start = i + 1;
      }
    }
    // An unclosed quote leaves the whole malformed field opaque, not a suffix.
    if (quoted) recipients.splice(0, recipients.length, decoded);
    else recipients.push(decoded.slice(start));
    for (const recipient of recipients) {
      const address = normalizeAddressDetectionText(recipient).trim();
      const at = address.indexOf('@');
      if (at > 0 && address.indexOf('.', at + 1) > at) targets.push(address);
    }
  };
  const parser = new EvidenceParser(
    {
      onopentag(name, attributes) {
        openCounts.set(name, (openCounts.get(name) ?? 0) + 1);
        if (BLOCK_ELEMENTS.has(name)) text.push('\n');
        if (
          name !== 'a' ||
          !attributes.href?.toLowerCase().startsWith('mailto:')
        )
          return;
        const uri = attributes.href.slice(7);
        const query = uri.indexOf('?');
        addRecipients(query === -1 ? uri : uri.slice(0, query));
        if (query === -1) return;
        for (const header of uri.slice(query + 1).split('&')) {
          const equals = header.indexOf('=');
          if (equals === -1) continue;
          const name = decode(header.slice(0, equals)).toLowerCase();
          if (name === 'to' || name === 'cc' || name === 'bcc')
            addRecipients(header.slice(equals + 1));
        }
      },
      ontext(value) {
        text.push(value);
      },
      onclosetag(name) {
        const count = (openCounts.get(name) ?? 1) - 1;
        if (count) openCounts.set(name, count);
        else openCounts.delete(name);
        if (BLOCK_ELEMENTS.has(name)) text.push('\n');
      },
    },
    { decodeEntities: true },
  );
  parser.end(html);
  return [
    ...new Set([
      ...targets.map((target) => target.toLowerCase()),
      ...inboundEmailAddressesInText(text.join('')),
    ]),
  ];
}
