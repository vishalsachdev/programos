const WEB_CHAT_SESSION_PREFIX = 'web-chat:';

export function normalizeWebChatSessionId(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64);
    if (normalized) return normalized;
  }
  return Math.random().toString(36).slice(2, 12);
}

export function deriveWebChatChatJid(sessionId: string): string {
  return `${WEB_CHAT_SESSION_PREFIX}${sessionId}`;
}

export function isDerivedWebChatJid(chatJid: string): boolean {
  return chatJid.startsWith(WEB_CHAT_SESSION_PREFIX);
}
