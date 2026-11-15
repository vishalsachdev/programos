import fs from 'fs';

import { simpleParser } from 'mailparser';

export interface EmailIdentity {
  subject: string;
  messageId?: string;
  references: string[];
  inReplyTo?: string;
  parseFallback: boolean;
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, '');
}

function extractMessageIds(value: string): string[] {
  const matches = value.match(/<[^>]+>/g);
  if (matches && matches.length > 0) {
    return matches.map(normalizeMessageId).filter(Boolean);
  }

  const normalized = normalizeMessageId(value);
  return normalized ? [normalized] : [];
}

export function extractEmailHeader(
  rawEmail: string,
  headerName: string,
): string | undefined {
  const pattern = new RegExp(`^${headerName}:\\s*(.*)$`, 'im');
  const match = rawEmail.match(pattern);
  if (!match) return undefined;

  const start = match.index ?? 0;
  const firstLine = match[1];
  const afterMatch = rawEmail.slice(start + match[0].length);
  const foldedLines = afterMatch.match(/^(?:\r?\n[ \t].*)+/);

  const value = `${firstLine}${foldedLines?.[0] || ''}`
    .replace(/\r?\n[ \t]+/g, ' ')
    .trim();

  return value || undefined;
}

export function selectEmailThreadId(identity: EmailIdentity): string;
export function selectEmailThreadId(
  rawEmail: string,
  messageId?: string,
  subject?: string,
  from?: string,
): string;
export function selectEmailThreadId(
  rawEmailOrIdentity: string | EmailIdentity,
  messageId?: string,
  subject?: string,
  from?: string,
): string {
  if (typeof rawEmailOrIdentity !== 'string') {
    const identity = rawEmailOrIdentity;
    if (identity.references.length > 0) return identity.references[0];
    if (identity.inReplyTo) return identity.inReplyTo;
    if (identity.messageId) return identity.messageId;

    return `unknown|${identity.subject
      .trim()
      .replace(/^re:\s*/i, '')
      .replace(/\s+/g, ' ')
      .toLowerCase()}`;
  }

  const rawEmail = rawEmailOrIdentity;
  const references = extractEmailHeader(rawEmail, 'References');
  const referenceIds = references ? extractMessageIds(references) : [];
  if (referenceIds.length > 0) return referenceIds[0];

  const inReplyTo = extractEmailHeader(rawEmail, 'In-Reply-To');
  const replyIds = inReplyTo ? extractMessageIds(inReplyTo) : [];
  if (replyIds.length > 0) return replyIds[0];

  if (messageId) {
    const ids = extractMessageIds(messageId);
    if (ids.length > 0) return ids[0];
  }

  const normalizedFrom = from?.trim().toLowerCase() || 'unknown';
  const normalizedSubject =
    subject
      ?.trim()
      .replace(/^re:\s*/i, '')
      .replace(/\s+/g, ' ')
      .toLowerCase() || 'no-subject';
  return `${normalizedFrom}|${normalizedSubject}`;
}

export async function parseEmailIdentity(
  rawFilePath: string | null,
  fallback: { subject?: string; messageId?: string },
): Promise<EmailIdentity> {
  const fallbackIdentity = (): EmailIdentity => ({
    subject: fallback.subject?.trim() || '(no subject)',
    ...(fallback.messageId
      ? { messageId: normalizeMessageId(fallback.messageId) }
      : {}),
    references: [],
    inReplyTo: undefined,
    parseFallback: true,
  });

  if (!rawFilePath || !fs.existsSync(rawFilePath)) {
    return fallbackIdentity();
  }

  try {
    const parsed = await simpleParser(fs.createReadStream(rawFilePath));
    const referenceValues = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [];
    const references = referenceValues
      .flatMap(extractMessageIds)
      .filter(Boolean);
    const messageId = parsed.messageId
      ? normalizeMessageId(parsed.messageId)
      : fallback.messageId
        ? normalizeMessageId(fallback.messageId)
        : undefined;
    const inReplyToIds = parsed.inReplyTo
      ? extractMessageIds(parsed.inReplyTo)
      : [];
    const hasIdentityHeader = Boolean(
      parsed.subject ||
      parsed.messageId ||
      parsed.references ||
      parsed.inReplyTo,
    );

    if (!hasIdentityHeader) return fallbackIdentity();

    return {
      subject:
        parsed.subject?.trim() || fallback.subject?.trim() || '(no subject)',
      ...(messageId ? { messageId } : {}),
      references,
      inReplyTo: inReplyToIds[0],
      parseFallback: false,
    };
  } catch {
    return fallbackIdentity();
  }
}

export function deriveEmailChatJid(input: {
  rawFilePath?: string;
  messageId?: string;
  subject?: string;
  from?: string;
}): string {
  let rawEmail = '';
  if (input.rawFilePath && fs.existsSync(input.rawFilePath)) {
    try {
      rawEmail = fs.readFileSync(input.rawFilePath, 'utf-8');
    } catch {
      rawEmail = '';
    }
  }

  return `webhook-email:${selectEmailThreadId(
    rawEmail,
    input.messageId,
    input.subject,
    input.from,
  )}`;
}
