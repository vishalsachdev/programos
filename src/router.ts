import { extractReplyBlocks, stripInternalTags } from './delivery-gate.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime, localWeekdayDate } from './timezone.js';

// The delivery-integrity gate (G46) lives in delivery-gate.ts — ONE shared
// module for signature lists and per-channel profiles. Re-export the gate
// surface so existing imports (index.ts, tests) keep working.
export {
  extractReplyBlocks,
  gateEmailOutbound,
  hasReplyTagRemnants,
  looksLikeEmailScaffolding,
  stripInternalTags,
  type EmailGateResult,
} from './delivery-gate.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  now: Date = new Date(),
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  // current_date is weekday-qualified so the agent never derives a weekday
  // from a bare date (or a date from a weekday) — see timezone.ts.
  const header = `<context timezone="${escapeXml(timezone)}" current_date="${escapeXml(localWeekdayDate(timezone, now))}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function formatOutbound(rawText: string): string {
  const extracted = extractReplyBlocks(rawText);
  if (extracted !== null) return extracted;
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
