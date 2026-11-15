/**
 * Shared channel utilities.
 */
import { getRepoReader, RepoReader } from './repo-reader.js';

/**
 * Lazy TTL-cached allowlist served from the pinned read-mirror SHA
 * (RepoReader). RepoReader owns last-good semantics at the SHA level — a
 * failed fetch keeps serving the previous commit. One implementation for
 * every channel: the reload-clock rule below is subtle enough that the
 * webhook/telegram copies had to be fixed in lockstep.
 *
 * `get()` may run a synchronous git fetch (up to 30s) when the TTL has
 * lapsed — inbound/admission paths only. Reply paths must use `peek()`:
 * agent turns routinely exceed the 5-minute TTL, so by send time `get()`
 * would block every channel + /health. Staleness is
 * bounded by the agent turn — the sender cleared this same list on the
 * way in.
 */
export function makeTtlCachedAllowlist<T extends { available: boolean }>(
  load: (reader: RepoReader) => T,
  ttlMs = 5 * 60 * 1000,
): { get(): T; peek(): T } {
  let value = load(getRepoReader());
  let loadedAt = Date.now();
  return {
    get() {
      if (Date.now() - loadedAt <= ttlMs) return value;
      getRepoReader().refresh(); // cheap fetch; serves last-good on failure
      value = load(getRepoReader());
      // Only reset the reload clock when the read had a chance of being
      // good — cold-start with no pinned SHA retries immediately instead of
      // waiting out the TTL.
      if (value.available || getRepoReader().currentSha !== null) {
        loadedAt = Date.now();
      }
      return value;
    },
    peek() {
      return value;
    },
  };
}

/**
 * Detect channel label from JID string.
 * Used by audit-log, eval-tracker, and any module that needs
 * to map a JID to a human-readable channel name.
 */
export function channelFromJid(jid: string): string {
  if (jid.includes('webhook-email')) return 'email';
  if (jid.includes('proactive-email')) return 'email';
  if (jid.includes('tg-')) return 'telegram';
  // Web chat: legacy channel-owner JID `web-chat-program@program` and per-session
  // JIDs `web-chat:<sessionId>` (see channels/web-chat-session.ts).
  if (jid.startsWith('web-chat:') || jid.includes('web-chat-'))
    return 'web-chat';
  return 'unknown';
}

/**
 * Extract the per-session ID from a web-chat session JID.
 * Returns null for the legacy channel-owner JID or any non-session form.
 */
export function webChatSessionIdFromJid(jid: string): string | null {
  if (!jid.startsWith('web-chat:')) return null;
  const id = jid.slice('web-chat:'.length);
  return id || null;
}
