import { describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ WEBCHAT_SECRET: 'test-secret' }),
}));

import './web-chat.js';
import { getChannelFactory } from './registry.js';

import {
  deriveWebChatChatJid,
  isDerivedWebChatJid,
  normalizeWebChatSessionId,
} from './web-chat-session.js';

describe('web chat session helpers', () => {
  it('keeps a provided non-empty session id', () => {
    expect(normalizeWebChatSessionId('session-123')).toBe('session-123');
  });

  it('sanitizes unsafe characters from the provided session id', () => {
    expect(normalizeWebChatSessionId(' session:123 /? ')).toBe('session123');
  });

  it('generates a session id when the input is missing', () => {
    expect(normalizeWebChatSessionId('')).toMatch(/^[a-z0-9]{10}$/);
  });

  // Math.random().toString(36).slice(2, 12) is shorter than ten characters
  // for a short fraction; CI failed on it (comment on PR 29).
  it('a generated session id has ten characters whatever Math.random returns', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      for (let i = 0; i < 200; i++)
        expect(normalizeWebChatSessionId(undefined)).toMatch(/^[a-z0-9]{10}$/);
    } finally {
      random.mockRestore();
    }
  });

  it('generated session ids differ', () => {
    const ids = new Set(
      Array.from({ length: 200 }, () => normalizeWebChatSessionId('')),
    );
    expect(ids.size).toBe(200);
  });

  it('derives the chat jid from the session id', () => {
    const chatJid = deriveWebChatChatJid('session-123');
    expect(chatJid).toBe('web-chat:session-123');
    expect(isDerivedWebChatJid(chatJid)).toBe(true);
  });
});

describe('web chat delivery outcomes', () => {
  it('returns a permanent failure when no HTTP request is waiting', async () => {
    const factory = getChannelFactory('web-chat');
    const channel = factory?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    expect(channel).toBeTruthy();

    const prepared = await channel!.prepareDelivery(
      'web-chat:missing',
      'hello',
      'delivery-1',
    );
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') throw new Error('not prepared');

    await expect(channel!.deliverPrepared(prepared.delivery)).resolves.toEqual({
      status: 'failed',
      reason: 'no-pending-web-request',
      retryable: false,
    });
  });
});
