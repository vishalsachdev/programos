import { describe, expect, it, vi } from 'vitest';

// The email reply path prepares a delivery only when a mail provider is
// usable. With OUTBOUND_MAIL_PROVIDER=smtp no API key is needed; with the
// default provider and no key the reply is refused, as before.

const mocks = vi.hoisted(() => ({
  env: {} as Record<string, string>,
}));

vi.mock('../env.js', () => ({
  readEnvFile: (keys?: string[]) =>
    keys
      ? Object.fromEntries(
          keys.filter((k) => mocks.env[k]).map((k) => [k, mocks.env[k]]),
        )
      : { ...mocks.env },
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

vi.mock('../repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: vi.fn(),
    readFile: vi.fn(() => null),
    readFileAsync: vi.fn(async () => null),
    readFileBuffer: vi.fn(() => null),
  }),
}));

import './webhook.js';
import { getChannelFactory } from './registry.js';

const CONTEXT = {
  type: 'webhook-email-v1',
  from: 'person@example.edu',
  subject: 'Launch question',
  messageId: 'message-1@example.com',
  kbConflictSnapshot: { files: {} },
  allowlistSnapshot: {
    available: true,
    source: 'test',
    senders: ['person@example.edu'],
  },
};

function channelWith(env: Record<string, string>) {
  mocks.env = { WEBHOOK_SECRET: 'test-secret', ...env };
  const channel = getChannelFactory('webhook')?.({
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('webhook channel not registered');
  expect(
    channel.restoreDeliveryContext?.('webhook-email:thread-1', CONTEXT),
  ).toBe(true);
  return channel;
}

describe('webhook reply path and the outbound mail provider', () => {
  it('SMTP provider: prepares the reply with no API key, with the same threading metadata', async () => {
    const channel = channelWith({ OUTBOUND_MAIL_PROVIDER: 'smtp' });

    await expect(
      channel.prepareDelivery('webhook-email:thread-1', 'Hello', 'delivery-1'),
    ).resolves.toMatchObject({
      status: 'prepared',
      delivery: {
        deliveryId: 'delivery-1',
        payload: {
          email: { to: 'person@example.edu', subject: 'Re: Launch question' },
          options: { inReplyTo: 'message-1@example.com', deferAudit: true },
        },
      },
    });
  });

  it('default provider with no API key: the reply is refused, as before', async () => {
    const channel = channelWith({});

    await expect(
      channel.prepareDelivery('webhook-email:thread-1', 'Hello', 'delivery-2'),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'resend-api-key-missing',
      retryable: false,
    });
  });

  it('an unknown provider name with no API key is refused the same way', async () => {
    const channel = channelWith({ OUTBOUND_MAIL_PROVIDER: 'sendmail' });

    await expect(
      channel.prepareDelivery('webhook-email:thread-1', 'Hello', 'delivery-3'),
    ).resolves.toMatchObject({ status: 'failed', retryable: false });
  });
});
