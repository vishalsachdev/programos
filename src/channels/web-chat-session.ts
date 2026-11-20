import { randomBytes } from 'crypto';

const WEB_CHAT_SESSION_PREFIX = 'web-chat:';
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Ten characters of a-z0-9 from the system's random source. The earlier
 * Math.random().toString(36).slice(2, 12) could come out shorter than ten
 * (a short fraction), and Math.random is predictable.
 */
function generatedSessionId(): string {
  let id = '';
  while (id.length < 10) {
    for (const byte of randomBytes(16)) {
      // 252 = 7 * 36: bytes above it are dropped so each character is even.
      if (byte < 252 && id.length < 10) id += SESSION_ID_ALPHABET[byte % 36];
    }
  }
  return id;
}

export function normalizeWebChatSessionId(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64);
    if (normalized) return normalized;
  }
  return generatedSessionId();
}

export function deriveWebChatChatJid(sessionId: string): string {
  return `${WEB_CHAT_SESSION_PREFIX}${sessionId}`;
}

export function isDerivedWebChatJid(chatJid: string): boolean {
  return chatJid.startsWith(WEB_CHAT_SESSION_PREFIX);
}
