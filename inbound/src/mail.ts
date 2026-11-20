// One received message in, three things out: the Markdown copy the agent
// reads, the repo paths, and the JSON the host webhook expects.

import PostalMime from 'postal-mime';
import type { Address, Email } from 'postal-mime';

import {
  NO_TRUST,
  authLine,
  readAuth,
  type AuthRecord,
  type AuthTrust,
  type FromCount,
} from './auth.js';

/** SMTP envelope values, as the mail platform reports them. */
export interface Envelope {
  from: string;
  to: string;
  /**
   * `Authentication-Results` as the platform's own API reports it
   * (`message.headers`), not as read from the raw bytes. Used only to
   * confirm which raw header is the platform's (`auth.ts`).
   */
  authenticationResults?: string | null;
}

/**
 * The fields the host's email handler reads (`src/channels/webhook.ts`,
 * search for `Missing filename or subject`). This worker does not send
 * `raw_email`, `inbound_text` or `phase`: the committed `.eml` is the one
 * copy of the original.
 */
export interface HostPayload {
  filename: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  message_id?: string;
  raw_file_path: string;
  eml_file_path: string;
  attachment_count: number;
  attachment_state: 'ready';
  /**
   * What trusted mail servers recorded about the sender (`auth.ts`). The
   * host turns it into one verdict; it never reads the message's own
   * headers for this.
   */
  auth: AuthRecord;
}

export interface Intake {
  /** SHA-256 of the raw bytes, hex. Also the buffer key. */
  id: string;
  markdownPath: string;
  emlPath: string;
  markdown: string;
  payload: HostPayload;
}

/**
 * Original headers copied into the Markdown copy when present. The first
 * three keep the thread; the rest are the ones the host's loop guard checks
 * (`REJECT_RULES` in `src/email-loop-detection.ts`). The host runs that
 * guard on `raw_file_path`, which is the Markdown copy, so an auto-reply is
 * caught only if these lines are in it.
 */
const COPIED_HEADERS = [
  'message-id',
  'in-reply-to',
  'references',
  'auto-submitted',
  'precedence',
  'list-id',
  'list-unsubscribe',
  'x-autoreply',
  'x-autorespond',
  'x-mailer',
] as const;

const HEADER_NAMES: Record<(typeof COPIED_HEADERS)[number], string> = {
  'message-id': 'Message-ID',
  'in-reply-to': 'In-Reply-To',
  references: 'References',
  'auto-submitted': 'Auto-Submitted',
  precedence: 'Precedence',
  'list-id': 'List-Id',
  'list-unsubscribe': 'List-Unsubscribe',
  'x-autoreply': 'X-Autoreply',
  'x-autorespond': 'X-Autorespond',
  'x-mailer': 'X-Mailer',
};

/** One line, no control characters: a value can never start a new header. */
function oneLine(value: string | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mailboxes(
  list: Address[] | undefined,
): { name: string; address: string }[] {
  const out: { name: string; address: string }[] = [];
  for (const entry of list ?? []) {
    for (const box of entry.group ?? [entry]) {
      const address = oneLine(box.address).toLowerCase();
      if (address) out.push({ name: oneLine(box.name), address });
    }
  }
  return out;
}

function display(box: { name: string; address: string }): string {
  // A display name is free text from the sender. Drop the characters that
  // could close the quoted string or look like a second address.
  const name = box.name.replace(/["<>\\]/g, '').trim();
  return name && name.toLowerCase() !== box.address
    ? `"${name}" <${box.address}>`
    : box.address;
}

const ADDRESS_TOKEN = /[^\s<>(),;:]+@[^\s<>(),;:]+/g;

/** The different address-like words in the text, lower case, no quotes. */
function addressTokens(fromHeader: string): { raw: string[]; found: string[] } {
  const raw = fromHeader.match(ADDRESS_TOKEN) ?? [];
  const found = new Set(
    raw.map((a) => a.replace(/^["']+|["']+$/g, '').toLowerCase()),
  );
  return { raw, found: [...found] };
}

/**
 * How the From header text reads when it holds one address word:
 *
 * - `one`: every reader takes it as the same single mailbox.
 * - `ambiguous`: a second reader could take it as more than one mailbox, or
 *   as another mailbox than the one word `addressTokens` found. Every test
 *   here errs towards this answer.
 * - `display-commas`: it would be `one` but for commas in two places where
 *   RFC 5322 does not make them separators for a reader that follows it: in
 *   the unquoted display name before the one address in angle brackets
 *   (`Lee, Dana <dlee@example.edu>`), and inside a comment beside it
 *   (`Dana (Alumni, East) <dana@example.edu>`). A reader that splits at
 *   every comma still sees a list, so this is not `one`; see
 *   `fromMailboxes` for what it is used for.
 */
type FromForm = 'one' | 'display-commas' | 'ambiguous';

function fromForm(fromHeader: string, raw: string[]): FromForm {
  // A control character: one reader stops at it, another drops it.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(fromHeader)) return 'ambiguous';
  // Every "@" must sit inside exactly one address word. An "@" with a
  // comment or a space beside it ("a(x)@b", "a @b") is in no word, and an
  // address with two ("a@b@c") has one too many: both are addresses to some
  // readers that the count would miss.
  const ats = (fromHeader.match(/@/g) ?? []).length;
  if (
    ats !== raw.length ||
    raw.some((a) => a.indexOf('@') !== a.lastIndexOf('@'))
  )
    return 'ambiguous';
  // More than one address in angle brackets, or brackets that do not pair.
  const open = (fromHeader.match(/</g) ?? []).length;
  const close = (fromHeader.match(/>/g) ?? []).length;
  if (open > 1 || open !== close) return 'ambiguous';
  const lt = fromHeader.indexOf('<');
  const gt = fromHeader.indexOf('>');
  if (gt < lt) return 'ambiguous';
  // Outside a quoted display name: a comma separates mailboxes, a colon or
  // a semicolon writes a group or a route, a backslash escapes for one
  // reader and not for another. A quote or a comment left open hides text
  // from one reader only. A comment is taken as part of the display name
  // only beside an address in angle brackets; inside the brackets, or with
  // no brackets at all, readers join or split the address around it
  // differently ("<dl(x)ee@example.edu>").
  let quoted = false;
  let depth = 0;
  let commas = false;
  for (let i = 0; i < fromHeader.length; i++) {
    const ch = fromHeader[i];
    if (quoted) {
      if (ch === '\\') i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '(') {
      if (lt < 0 || (i > lt && i < gt)) return 'ambiguous';
      depth++;
    } else if (ch === ')') {
      if (depth === 0) return 'ambiguous';
      depth--;
    } else if (ch === ',') {
      // In a comment, or in the display name before "<". Anywhere else
      // (no brackets, inside them, after them) it separates mailboxes.
      if (depth === 0 && !(lt >= 0 && i < lt)) return 'ambiguous';
      commas = true;
    } else if (ch === ':' || ch === ';' || ch === '\\') return 'ambiguous';
  }
  if (quoted || depth !== 0) return 'ambiguous';
  if (!commas) return 'one';
  // The comma reading holds only for the plainest form around it: the
  // brackets hold the address word and nothing else, nothing but comments
  // follows them, and the display name has no encoded word (a reader that
  // decodes before it splits could find an address or a bracket in it).
  if (fromHeader.slice(lt + 1, gt) !== raw[0]) return 'ambiguous';
  if (fromHeader.includes('=?')) return 'ambiguous';
  let tailDepth = 0;
  for (const ch of fromHeader.slice(gt + 1)) {
    if (ch === '(') tailDepth++;
    else if (ch === ')') tailDepth--;
    else if (tailDepth === 0 && !/[ \t]/.test(ch)) return 'ambiguous';
  }
  return 'display-commas';
}

/**
 * How many different addresses the From header text holds, display name
 * included, so a group or a second address the parser drops still counts.
 * The same address as display name and as mailbox counts once. A character
 * outside ASCII counts as one more: two readers may fold it differently.
 *
 * The result is 1 only for a header that every reader takes as the same
 * single mailbox. A header with one address word that could still be read
 * as more than one mailbox (`fromForm`) counts 2.
 */
export function fromAddressCount(fromHeader: string): number {
  const { raw, found } = addressTokens(fromHeader);
  // Checked before lower-casing: the Kelvin sign lower-cases to "k".
  // eslint-disable-next-line no-control-regex
  const count =
    found.length + (raw.some((a) => /[^\x00-\x7f]/.test(a)) ? 1 : 0);
  return count === 1 && fromForm(fromHeader, raw) !== 'one' ? 2 : count;
}

/**
 * The `from_mailboxes` value for the payload. `address` is the address the
 * payload carries as `from` when it was read from the From header, null
 * when it was not (the envelope sender was used instead).
 *
 * The host matches the allowlist on `from`, and a DMARC result is about the
 * From header. The two are the same sender only when the one address in the
 * From header text IS `from`. When the mail parser read another address
 * than the one counted, or none at all, a DMARC pass for the header says
 * nothing about `from`; the count is then 2, which the host never calls
 * authenticated.
 */
export function fromMailboxCount(
  fromHeader: string,
  address: string | null,
): number {
  const count = fromAddressCount(fromHeader);
  if (count !== 1) return count;
  const only = addressTokens(fromHeader).found[0];
  return address !== null && only === address.toLowerCase() ? 1 : 2;
}

/**
 * What the payload says about the From header: `from_mailboxes` (above),
 * and whether a count of 2 has the one cause the host may look past, commas
 * in an unquoted display name or in a comment (`fromForm`). That is only
 * said when the mail parser read the same address as the one counted, the
 * condition `fromMailboxCount` puts on a count of 1.
 */
export function fromMailboxes(
  fromHeader: string,
  address: string | null,
): FromCount {
  const count = fromMailboxCount(fromHeader, address);
  const { raw, found } = addressTokens(fromHeader);
  const displayCommas =
    count === 2 &&
    found.length === 1 &&
    // eslint-disable-next-line no-control-regex
    !/[^\x00-\x7f]/.test(raw.join('')) &&
    address !== null &&
    found[0] === address.toLowerCase() &&
    fromForm(fromHeader, raw) === 'display-commas';
  return { count, displayCommas };
}

/** Lowercase ASCII words joined by hyphens, for the file name. */
export function slug(subject: string): string {
  const ascii = subject
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return ascii || 'no-subject';
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function attachmentSize(content: ArrayBuffer | Uint8Array | string): number {
  return typeof content === 'string'
    ? new TextEncoder().encode(content).byteLength
    : content.byteLength;
}

/** Inline parts (logos in a signature) are listed but not counted. */
function isInline(att: Email['attachments'][number]): boolean {
  return att.disposition === 'inline' || att.related === true;
}

function markdownCopy(
  email: Email,
  fields: {
    from: string;
    to: string;
    cc: string;
    date: string;
    subject: string;
  },
  emlPath: string,
  auth: AuthRecord,
): string {
  const lines: string[] = [
    `From: ${fields.from}`,
    `To: ${fields.to}`,
    ...(fields.cc ? [`Cc: ${fields.cc}`] : []),
    `Date: ${fields.date}`,
    `Subject: ${fields.subject}`,
  ];
  for (const key of COPIED_HEADERS) {
    for (const header of email.headers) {
      if (header.key !== key) continue;
      const value = oneLine(header.value);
      if (value) lines.push(`${HEADER_NAMES[key]}: ${value}`);
    }
  }
  // Written by this worker, never copied from the message: no header of
  // this name is in COPIED_HEADERS.
  lines.push(`X-Intake-Authentication: ${authLine(auth)}`);
  const body = (email.text ?? '').replace(/\r\n?/g, '\n').trim();
  lines.push('', `# ${fields.subject}`, '', body || '_(no text body)_');

  if (email.attachments.length > 0) {
    lines.push(
      '',
      '## Attachments',
      '',
      `These files are inside the original message, \`${emlPath}\`. They are not stored as separate files.`,
      '',
    );
    email.attachments.forEach((att, i) => {
      const name =
        oneLine(att.filename ?? '').replace(/`/g, "'") || '(no name)';
      const type = oneLine(att.mimeType).replace(/`/g, "'");
      const inline = isInline(att) ? ', inline' : '';
      lines.push(
        `${i + 1}. \`${name}\` (${type}, ${attachmentSize(att.content)} bytes${inline})`,
      );
    });
  }
  lines.push('', '---', '', `Original message: \`${emlPath}\``, '');
  return lines.join('\n');
}

/**
 * Parse the raw message and build everything that depends on it. The result
 * depends only on the arguments, so a retry from the buffer builds the same
 * file names and the same payload.
 */
export async function buildIntake(
  raw: Uint8Array,
  envelope: Envelope,
  receivedAt: Date,
  inboxDir: string,
  trust: AuthTrust = NO_TRUST,
): Promise<Intake> {
  const email = await PostalMime.parse(raw);
  const id = await sha256Hex(raw);

  // The allowlist names people by the address in the From header. The
  // envelope sender is often a bounce address, and forwarding rewrites it.
  const headerBox = mailboxes(email.from ? [email.from] : [])[0];
  const fromBox = headerBox ?? {
    name: '',
    address: oneLine(envelope.from).toLowerCase(),
  };
  const fromHeader = email.headers.find((h) => h.key === 'from')?.value ?? '';
  const auth = readAuth(
    email.headers,
    envelope.from,
    fromMailboxes(fromHeader, headerBox ? headerBox.address : null),
    trust,
    envelope.authenticationResults,
  );
  const toBoxes = mailboxes(email.to);
  const ccBoxes = mailboxes(email.cc);
  const subject = oneLine(email.subject) || '(no subject)';
  const rawDate = oneLine(email.headers.find((h) => h.key === 'date')?.value);
  const parsedDate = email.date ? new Date(email.date) : null;
  const date =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString()
      : receivedAt.toISOString();
  const messageId = oneLine(email.messageId);

  const base = `${receivedAt.toISOString().slice(0, 10)}-${slug(subject)}-${id.slice(0, 8)}`;
  const markdownPath = `${inboxDir}/${base}.md`;
  const emlPath = `${inboxDir}/${base}.eml`;
  const to = toBoxes.length
    ? toBoxes.map((b) => b.address).join(', ')
    : oneLine(envelope.to).toLowerCase();
  const cc = ccBoxes.map((b) => b.address).join(', ');

  const markdown = markdownCopy(
    email,
    {
      from: display(fromBox),
      to: toBoxes.length ? toBoxes.map(display).join(', ') : to,
      cc: ccBoxes.map(display).join(', '),
      date: rawDate || receivedAt.toUTCString(),
      subject,
    },
    emlPath,
    auth,
  );

  return {
    id,
    markdownPath,
    emlPath,
    markdown,
    payload: {
      filename: `${base}.md`,
      subject,
      from: fromBox.address,
      to,
      cc,
      date,
      ...(messageId ? { message_id: messageId } : {}),
      raw_file_path: markdownPath,
      eml_file_path: emlPath,
      attachment_count: email.attachments.filter((a) => !isInline(a)).length,
      // The manifest is final when it is written: every attachment is inside
      // the `.eml` that the same commit adds. Nothing is stored later, so
      // "pending" and "partial" never apply.
      attachment_state: 'ready',
      auth,
    },
  };
}
