import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  channelFromJid,
  makeTtlCachedAllowlist,
  webChatSessionIdFromJid,
} from './channel-utils.js';
import { getRepoReader } from './repo-reader.js';

vi.mock('./repo-reader.js', () => {
  const reader = { refresh: vi.fn(), currentSha: 'abc123' as string | null };
  return { getRepoReader: () => reader };
});

describe('makeTtlCachedAllowlist', () => {
  const reader = getRepoReader() as unknown as {
    refresh: ReturnType<typeof vi.fn>;
    currentSha: string | null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    reader.refresh.mockClear();
    reader.currentSha = 'abc123';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('serves the cached value within the TTL without refetching', () => {
    const load = vi.fn(() => ({ available: true }));
    const cache = makeTtlCachedAllowlist(load, 5 * 60 * 1000);
    expect(load).toHaveBeenCalledTimes(1); // eager initial load
    vi.advanceTimersByTime(4 * 60 * 1000);
    cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    expect(reader.refresh).not.toHaveBeenCalled();
  });

  it('refreshes and reloads once the TTL lapses', () => {
    const load = vi.fn(() => ({ available: true }));
    const cache = makeTtlCachedAllowlist(load, 5 * 60 * 1000);
    vi.advanceTimersByTime(6 * 60 * 1000);
    cache.get();
    expect(reader.refresh).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('peek() never refetches, even past the TTL (reply paths must not block)', () => {
    const load = vi.fn(() => ({ available: true }));
    const cache = makeTtlCachedAllowlist(load, 5 * 60 * 1000);
    vi.advanceTimersByTime(60 * 60 * 1000);
    cache.peek();
    expect(load).toHaveBeenCalledTimes(1);
    expect(reader.refresh).not.toHaveBeenCalled();
  });

  it('cold-start with no pinned SHA retries immediately instead of waiting out the TTL', () => {
    reader.currentSha = null;
    const load = vi.fn(() => ({ available: false }));
    const cache = makeTtlCachedAllowlist(load, 5 * 60 * 1000);
    vi.advanceTimersByTime(6 * 60 * 1000);
    cache.get(); // failed reload: unavailable + no SHA → clock NOT reset
    cache.get(); // so the very next get() retries rather than serving stale
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('survives destructuring (no this-binding)', () => {
    const { get, peek } = makeTtlCachedAllowlist(() => ({ available: true }));
    expect(get()).toEqual({ available: true });
    expect(peek()).toEqual({ available: true });
  });
});

describe('channelFromJid', () => {
  it('maps email JIDs', () => {
    expect(channelFromJid('webhook-email@program')).toBe('email');
    expect(channelFromJid('proactive-email@program')).toBe('email');
  });

  it('maps Telegram JIDs', () => {
    expect(channelFromJid('tg-program@program')).toBe('telegram');
  });

  it('maps the owner-DM Telegram JID', () => {
    expect(channelFromJid('tg-avery@program')).toBe('telegram');
  });

  it('returns unknown for retired Teams/Copilot JIDs', () => {
    // Retired channels. Historical audit
    // entries keep their labels; new JIDs of this shape must not resolve.
    expect(channelFromJid('teams-program@program')).toBe('unknown');
    expect(channelFromJid('teams-wh-program@program')).toBe('unknown');
    expect(channelFromJid('copilot-program@program')).toBe('unknown');
  });

  it('maps the legacy web-chat channel-owner JID', () => {
    expect(channelFromJid('web-chat-program@program')).toBe('web-chat');
  });

  it('maps per-session web-chat JIDs (colon form)', () => {
    // Regression: previously returned 'unknown' because the regex looked for
    // 'web-chat-' (dash) but session JIDs use 'web-chat:' (colon).
    expect(channelFromJid('web-chat:abc123')).toBe('web-chat');
    expect(channelFromJid('web-chat:session-with-dashes')).toBe('web-chat');
  });

  it('returns "unknown" for unrecognised JIDs', () => {
    expect(channelFromJid('something-else@program')).toBe('unknown');
  });
});

describe('webChatSessionIdFromJid', () => {
  it('extracts the session id from a per-session JID', () => {
    expect(webChatSessionIdFromJid('web-chat:abc123')).toBe('abc123');
  });

  it('returns null for the legacy channel-owner JID', () => {
    expect(webChatSessionIdFromJid('web-chat-program@program')).toBeNull();
  });

  it('returns null for non-web-chat JIDs', () => {
    expect(webChatSessionIdFromJid('tg-program@program')).toBeNull();
    expect(webChatSessionIdFromJid('webhook-email@program')).toBeNull();
  });

  it('returns null for an empty session id', () => {
    expect(webChatSessionIdFromJid('web-chat:')).toBeNull();
  });
});
