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
} from './auth.js';

/** SMTP envelope values, as the mail platform reports them. */
export interface Envelope {
  from: string;
  to: string;
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
  const fromBox = mailboxes(email.from ? [email.from] : [])[0] ?? {
    name: '',
    address: oneLine(envelope.from).toLowerCase(),
  };
  const fromHeader = email.headers.find((h) => h.key === 'from')?.value ?? '';
  const auth = readAuth(
    email.headers,
    envelope.from,
    // Distinct addresses in the header text, so a group or a second address
    // the parser drops still counts. The same address as display name and
    // as mailbox ("a@example.edu" <a@example.edu>) is one.
    new Set(
      (fromHeader.match(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g) ?? []).map((a) =>
        a.toLowerCase(),
      ),
    ).size,
    trust,
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
