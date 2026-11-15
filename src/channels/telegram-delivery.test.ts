import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_ADMIN_CHAT_ID: '12345',
  }),
}));

vi.mock('../program-repo.js', () => ({
  CHECKOUT_OWNER: { uid: 1000, gid: 1000 },
  checkoutGitOptions: () => ({
    cwd: process.env.PROGRAM_REPO,
    env: process.env,
    timeout: 30_000,
  }),
  getProgramRepoPath: () => '/tmp/program-repo-test',
}));

import { TELEGRAM_OWNER_JID } from '../config.js';
import './telegram.js';
import { getChannelFactory } from './registry.js';

function makeChannel() {
  const channel = getChannelFactory('telegram')?.({
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('telegram channel not registered');
  return channel;
}

describe('telegram delivery outcomes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fails permanently when no Telegram target is known', async () => {
    const channel = makeChannel();

    await expect(
      channel.prepareDelivery('tg:missing', 'hello', 'delivery-1'),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'telegram-target-missing',
      retryable: false,
    });
  });

  it('freezes the owner target and sends every prepared chunk', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ ok: true, result: { message_id: 7 } }),
      })),
    );
    const channel = makeChannel();
    const prepared = await channel.prepareDelivery(
      TELEGRAM_OWNER_JID,
      'x'.repeat(4100),
      'delivery-1',
    );
    expect(prepared.status).toBe('prepared');
    if (prepared.status !== 'prepared') throw new Error('not prepared');

    await expect(channel.deliverPrepared(prepared.delivery)).resolves.toEqual({
      status: 'sent',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('classifies a Telegram API exception as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('down'))),
    );
    const channel = makeChannel();
    const prepared = await channel.prepareDelivery(
      TELEGRAM_OWNER_JID,
      'hello',
      'delivery-1',
    );
    if (prepared.status !== 'prepared') throw new Error('not prepared');

    await expect(channel.deliverPrepared(prepared.delivery)).resolves.toEqual({
      status: 'failed',
      reason: 'telegram-send-failed: down',
      retryable: true,
    });
  });
});
