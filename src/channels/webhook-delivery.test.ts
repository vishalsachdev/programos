import { describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
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

describe('webhook delivery outcomes', () => {
  it('fails permanently when reply metadata is missing', async () => {
    const channel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');

    await expect(
      channel.prepareDelivery(
        'webhook-email:missing',
        '<reply>Hello</reply>',
        'delivery-1',
      ),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'email-metadata-missing',
      retryable: false,
    });
  });

  it('rejects a restored payload for the wrong channel', async () => {
    const channel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');

    await expect(
      channel.deliverPrepared({
        channel: 'telegram',
        deliveryId: 'delivery-1',
        jid: 'webhook-email:missing',
        payload: {},
      }),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'invalid-email-delivery',
      retryable: false,
    });
  });

  it('restores validated recipient and threading metadata after restart', async () => {
    const channel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');

    const context = {
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
    expect(
      channel.restoreDeliveryContext?.('webhook-email:thread-1', context),
    ).toBe(true);
    expect(channel.snapshotDeliveryContext?.('webhook-email:thread-1')).toEqual(
      context,
    );

    await expect(
      channel.prepareDelivery('webhook-email:thread-1', 'Hello', 'delivery-1'),
    ).resolves.toMatchObject({
      status: 'prepared',
      delivery: {
        deliveryId: 'delivery-1',
        payload: {
          email: {
            to: 'person@example.edu',
            subject: 'Re: Launch question',
          },
          options: {
            inReplyTo: 'message-1@example.com',
            deferAudit: true,
          },
        },
      },
    });
  });

  it('rejects malformed restored channel metadata', () => {
    const channel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');

    expect(
      channel.restoreDeliveryContext?.('webhook-email:thread-1', {
        type: 'webhook-email-v1',
        from: 'attacker@example.com',
        allowlistSnapshot: { senders: ['attacker@example.com'] },
      }),
    ).toBe(false);
  });

  it('labels CC-as-context suppression for its dedicated audit path', async () => {
    const channel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');

    expect(
      channel.restoreDeliveryContext?.('webhook-email:thread-cc', {
        type: 'webhook-email-v1',
        from: 'person@example.edu',
        subject: 'For context',
        messageId: 'message-cc@example.com',
        kbConflictSnapshot: { files: {} },
        allowlistSnapshot: {
          available: true,
          source: 'test',
          senders: ['person@example.edu'],
        },
        ccContext: {
          ccOnly: true,
          suppressAck: true,
          reason: 'cc-context-no-direct-request',
        },
      }),
    ).toBe(true);

    await expect(
      channel.prepareDelivery(
        'webhook-email:thread-cc',
        'Filed for context',
        'delivery-cc',
      ),
    ).resolves.toMatchObject({
      status: 'suppressed',
      reason: 'cc-context-no-direct-request',
      suppressionKind: 'cc-context',
    });
  });
});

// Catches missing host backstop validation after restart and lost trusted turn evidence.
it('checks body addresses using restored allowlist and host turn evidence', async () => {
  const channel = getChannelFactory('webhook')?.({
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('missing webhook');
  channel.restoreDeliveryContext?.('webhook-email:body', {
    type: 'webhook-email-v1',
    from: 'person@example.edu',
    subject: 'Contact',
    messageId: '',
    kbConflictSnapshot: { files: {} },
    allowlistSnapshot: {
      available: true,
      source: 'test',
      senders: ['person@example.edu'],
    },
  });
  expect(
    await channel.prepareDelivery(
      'webhook-email:body',
      'Contact amorgan@example.edu',
      'bad-body',
    ),
  ).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('amorgan@example.edu'),
  });
  expect(
    await channel.prepareDelivery(
      'webhook-email:body',
      'Contact inbound@example.org',
      'trusted-body',
      {
        allowlist: {
          available: true,
          source: 'test',
          senders: new Set(['person@example.edu']),
        },
        inboundText: ['inbound@example.org'],
      },
    ),
  ).toMatchObject({
    status: 'prepared',
    delivery: {
      payload: {
        options: {
          trustedBodyAddresses: ['inbound@example.org', 'person@example.edu'],
        },
      },
    },
  });
});

// Catches permissive recipient fallback disabling the body-address evidence requirement.
it('fails closed for body addresses when the restored allowlist is unavailable', async () => {
  const channel = getChannelFactory('webhook')?.({
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('missing webhook');
  channel.restoreDeliveryContext?.('webhook-email:missing-allowlist', {
    type: 'webhook-email-v1',
    from: 'person@example.edu',
    subject: 'Contact',
    messageId: '',
    kbConflictSnapshot: { files: {} },
    bodyAddresses: ['inbound@example.org'],
    allowlistSnapshot: { available: false, source: 'test', senders: [] },
  });
  expect(
    await channel.prepareDelivery(
      'webhook-email:missing-allowlist',
      'Contact inbound@example.org',
      'missing-allowlist-body',
    ),
  ).toMatchObject({
    status: 'failed',
    reason: 'email-gate-refused: unverified-email-address: inbound@example.org',
  });
});
