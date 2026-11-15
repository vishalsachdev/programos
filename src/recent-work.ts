import { TIMEZONE } from './config.js';
import { getRecentMessages } from './db.js';
import { localDateYmd } from './timezone.js';
import type { NewMessage } from './types.js';

const MAX_HISTORY_MESSAGES = 6;
const MAX_SNIPPET_CHARS = 220;

function collapseWhitespace(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function snippet(text: string | null | undefined): string {
  const collapsed = collapseWhitespace(text);
  if (collapsed.length <= MAX_SNIPPET_CHARS) return collapsed;
  return `${collapsed.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function directionOf(message: NewMessage): 'outbound' | 'inbound' {
  return message.is_bot_message ? 'outbound' : 'inbound';
}

function auditPointer(timestamp: string): string {
  return `discussions/audit-log/${localDateYmd(TIMEZONE, new Date(timestamp))}.md`;
}

export function buildRecentWorkSection(args: {
  chatJid: string;
  currentMessages: NewMessage[];
  repoRevision?: string | null;
  history?: NewMessage[];
}): string | null {
  if (args.currentMessages.length === 0) return null;

  const beforeTimestamp = args.currentMessages[0].timestamp;
  const history =
    args.history ??
    getRecentMessages(args.chatJid, MAX_HISTORY_MESSAGES, { beforeTimestamp });

  const quotedAnchors = args.currentMessages
    .filter(
      (message) =>
        collapseWhitespace(message.reply_to_message_content).length > 0 &&
        collapseWhitespace(message.reply_to_sender_name).length > 0,
    )
    .map((message) => ({
      replyToId: collapseWhitespace(message.reply_to_message_id) || 'unknown',
      sender: collapseWhitespace(message.reply_to_sender_name) || 'unknown',
      text: snippet(message.reply_to_message_content),
    }));

  if (history.length === 0 && quotedAnchors.length === 0) return null;

  const lines = [
    '<recent_work_index>',
    'Fresh-session recovery index for THIS chat/thread only. Use it before any broad audit-log read. It is a convenience index, not a source of truth.',
    `- Chat/thread: ${xmlEscape(args.chatJid)}`,
    `- KB/allowlist pinned revision now: ${xmlEscape(args.repoRevision ?? 'unavailable')}`,
  ];

  if (quotedAnchors.length > 0) {
    lines.push('- Current message batch quoted anchor(s):');
    for (const anchor of quotedAnchors.slice(0, 3)) {
      lines.push(
        `  - reply_to=${xmlEscape(anchor.replyToId)} from=${xmlEscape(anchor.sender)} text="${xmlEscape(anchor.text)}"`,
      );
    }
  }

  if (history.length > 0) {
    lines.push('- Indexed prior exchange for this chat/thread:');
    for (const message of history) {
      lines.push(
        `  - ${directionOf(message)} id=${xmlEscape(message.id)} at=${xmlEscape(message.timestamp)} sender=${xmlEscape(message.sender_name || message.sender)} audit=${xmlEscape(auditPointer(message.timestamp))} text="${xmlEscape(snippet(message.content))}"`,
      );
    }
  }

  lines.push(
    '- If the current message is a short follow-up ("yes", "that one", etc.), resolve it from the quoted anchor(s) and indexed prior exchange first.',
    '- If this index is insufficient, selectively read the cited audit file(s) and current KB files. Do not read an entire recent day log by default.',
    '- Current KB files outrank this index. Re-read the live file before relying on any policy or factual detail.',
    '</recent_work_index>',
  );

  return lines.join('\n');
}
