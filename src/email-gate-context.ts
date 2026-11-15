import { DEFAULT_BOT_EMAIL } from './config.js';
import type { DeliveryGateContext } from './delivery-gate.js';
import { readEnvFile } from './env.js';
import { getRepoReader } from './repo-reader.js';
import { loadEmailAllowlistFromAsync } from './channels/webhook-allowlist.js';
import type { NewMessage } from './types.js';
import type { DeliveryState } from './delivery-state.js';

/** Host-owned context for both ordinary replies and immediate email sends. */
export async function resolveEmailGateContext(
  messages: NewMessage[] = [],
  channelData?: unknown,
  savedState?: DeliveryState,
): Promise<DeliveryGateContext> {
  const data = channelData ?? messages[messages.length - 1]?.delivery_context;
  const snapshot =
    data && typeof data === 'object' && 'allowlistSnapshot' in data
      ? data.allowlistSnapshot
      : undefined;
  const allowlist =
    snapshot &&
    typeof snapshot === 'object' &&
    'available' in snapshot &&
    typeof snapshot.available === 'boolean' &&
    'source' in snapshot &&
    typeof snapshot.source === 'string' &&
    'senders' in snapshot &&
    Array.isArray(snapshot.senders) &&
    snapshot.senders.every((a) => typeof a === 'string')
      ? {
          available: snapshot.available,
          source: snapshot.source,
          senders: new Set<string>(snapshot.senders),
        }
      : await loadEmailAllowlistFromAsync(getRepoReader());
  const savedInbound =
    data &&
    typeof data === 'object' &&
    'bodyEvidenceVersion' in data &&
    data.bodyEvidenceVersion === 1 &&
    'bodyAddresses' in data &&
    Array.isArray(data.bodyAddresses)
      ? data.bodyAddresses.filter((a): a is string => typeof a === 'string')
      : [];
  const savedSender =
    data &&
    typeof data === 'object' &&
    'from' in data &&
    typeof data.from === 'string'
      ? [data.from]
      : [];
  return {
    allowlist,
    ...(savedState?.phase === 'repair-required' &&
    !Object.hasOwn(savedState, 'trustedBodyAddresses')
      ? { legacySavedDeliveryId: savedState.outcomeId }
      : {}),
    sendFromEmail:
      readEnvFile(['SEND_FROM_EMAIL']).SEND_FROM_EMAIL || DEFAULT_BOT_EMAIL,
    trustedBodyAddresses: [
      ...(savedState?.trustedBodyAddresses ?? []),
      ...savedInbound,
      ...messages.flatMap((message) => {
        const data = message.delivery_context;
        const addresses =
          data &&
          typeof data === 'object' &&
          'bodyEvidenceVersion' in data &&
          data.bodyEvidenceVersion === 1 &&
          'bodyAddresses' in data &&
          Array.isArray(data.bodyAddresses)
            ? data.bodyAddresses.filter(
                (a): a is string => typeof a === 'string',
              )
            : [];
        return addresses;
      }),
    ],
    inboundText: [...savedSender, ...messages.map((message) => message.sender)],
  };
}
