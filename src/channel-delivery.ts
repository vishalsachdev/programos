import type { DeliveryGateContext } from './delivery-gate.js';
import { randomUUID } from 'crypto';

import type { Channel, DeliveryOutcome, NewMessage } from './types.js';

export function resolveChannelDeliveryContext(
  channel: Channel,
  jid: string,
  message: NewMessage | undefined,
): unknown {
  // The context stored with this exact inbound message is immutable and
  // restart-safe. A channel's live cache may be empty after restart or may
  // already point at a newer message in the same thread.
  if (message?.delivery_context !== undefined) {
    return message.delivery_context;
  }
  return channel.snapshotDeliveryContext?.(jid);
}

export async function sendImmediate(
  channel: Channel,
  jid: string,
  text: string,
  deliveryId: string = randomUUID(),
  gateContext?: DeliveryGateContext,
): Promise<DeliveryOutcome> {
  const prepared = gateContext
    ? await channel.prepareDelivery(jid, text, deliveryId, gateContext)
    : await channel.prepareDelivery(jid, text, deliveryId);
  if (prepared.status !== 'prepared') return prepared;
  return channel.deliverPrepared(prepared.delivery);
}
