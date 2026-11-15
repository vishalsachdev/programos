import { describe, expect, it, vi } from 'vitest';

import {
  resolveChannelDeliveryContext,
  sendImmediate,
} from './channel-delivery.js';

describe('sendImmediate', () => {
  it('prepares and delivers one message with the supplied delivery id', async () => {
    const delivery = {
      channel: 'test',
      deliveryId: 'delivery-1',
      jid: 'test:1',
      payload: { text: 'hello' },
    };
    const channel = {
      prepareDelivery: vi.fn(async () => ({
        status: 'prepared' as const,
        delivery,
      })),
      deliverPrepared: vi.fn(async () => ({
        status: 'sent' as const,
        providerId: 'provider-1',
      })),
    };

    await expect(
      sendImmediate(channel as never, 'test:1', 'hello', 'delivery-1'),
    ).resolves.toEqual({ status: 'sent', providerId: 'provider-1' });
    expect(channel.prepareDelivery).toHaveBeenCalledWith(
      'test:1',
      'hello',
      'delivery-1',
    );
    expect(channel.deliverPrepared).toHaveBeenCalledWith(delivery);
  });

  it('returns a preparation failure without calling delivery', async () => {
    const channel = {
      prepareDelivery: vi.fn(async () => ({
        status: 'failed' as const,
        reason: 'no-target',
        retryable: false as const,
      })),
      deliverPrepared: vi.fn(),
    };

    await expect(
      sendImmediate(channel as never, 'test:1', 'hello', 'delivery-1'),
    ).resolves.toEqual({
      status: 'failed',
      reason: 'no-target',
      retryable: false,
    });
    expect(channel.deliverPrepared).not.toHaveBeenCalled();
  });

  it('returns policy suppression without calling delivery', async () => {
    const channel = {
      prepareDelivery: vi.fn(async () => ({
        status: 'suppressed' as const,
        reason: 'context-only',
        outcomeId: 'delivery-1',
      })),
      deliverPrepared: vi.fn(),
    };

    await expect(
      sendImmediate(channel as never, 'test:1', 'hello', 'delivery-1'),
    ).resolves.toEqual({
      status: 'suppressed',
      reason: 'context-only',
      outcomeId: 'delivery-1',
    });
    expect(channel.deliverPrepared).not.toHaveBeenCalled();
  });
});

describe('resolveChannelDeliveryContext', () => {
  it('prefers message-bound context over mutable live channel state', () => {
    const persisted = { type: 'webhook-email-v1', messageId: 'original' };
    const channel = {
      snapshotDeliveryContext: () => ({
        type: 'webhook-email-v1',
        messageId: 'newer-thread-message',
      }),
    };
    expect(
      resolveChannelDeliveryContext(
        channel as never,
        'webhook-email:thread-1',
        { delivery_context: persisted } as never,
      ),
    ).toEqual(persisted);
  });
});
