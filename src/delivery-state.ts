import { createHmac, timingSafeEqual } from 'crypto';

import { CONTAINER_MAX_OUTPUT_SIZE } from './config.js';
import { deleteRouterState, getRouterState, setRouterState } from './db.js';
import { readEnvFile } from './env.js';
import type { PreparedDelivery } from './types.js';

const STATE_VERSION = 1 as const;
const STATE_KEY_PREFIX = 'delivery-state:';
const TRANSPORT_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNATURE_VERSION = 1;

export interface DeliveryContext {
  sender?: string;
  subject?: string;
  receivedAt?: string;
  messageId?: string;
  channelData?: unknown;
}

interface DeliveryStateBase {
  version: typeof STATE_VERSION;
  chatJid: string;
  targetTimestamp: string;
  previousCursor: string;
  context: DeliveryContext;
  outcomeId: string;
  /** Missing only on pre-body-gate state; [] is current evidence, not legacy. */
  trustedBodyAddresses?: string[];
}

export interface RepairRequiredState extends DeliveryStateBase {
  phase: 'repair-required';
  gateReason: string;
  rejectedOutput: string;
  attempt: number;
  createdAt: string;
}

export interface TransportPendingState extends DeliveryStateBase {
  phase: 'transport-pending';
  prepared: PreparedDelivery;
  replyText: string;
  attempt: number;
  createdAt: string;
}

export interface ProviderAcceptedState extends DeliveryStateBase {
  phase: 'provider-accepted';
  prepared: PreparedDelivery;
  replyText: string;
  attempt: number;
  providerId: string;
  acceptedAt: string;
}

export type DeliveryState =
  | RepairRequiredState
  | TransportPendingState
  | ProviderAcceptedState;

export type LoadDeliveryStateResult =
  | { status: 'none' }
  | { status: 'valid'; state: DeliveryState }
  | { status: 'invalid'; reason: string };

export type SaveDeliveryStateResult =
  | { status: 'saved' }
  | { status: 'invalid'; reason: string };

function stateKey(jid: string): string {
  return `${STATE_KEY_PREFIX}${jid}`;
}

function signingKey(): string | undefined {
  const env = readEnvFile([
    'WEBHOOK_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'RESEND_API_KEY',
  ]);
  return (
    process.env.DELIVERY_STATE_SIGNING_KEY ||
    env.WEBHOOK_SECRET ||
    env.TELEGRAM_BOT_TOKEN ||
    env.RESEND_API_KEY
  );
}

function macFor(payload: string, key: string): string {
  return createHmac('sha256', key)
    .update('nanoclaw-delivery-state-v1\0')
    .update(payload)
    .digest('hex');
}

function unwrapSignedState(
  serialized: string,
): { ok: true; payload: string } | { ok: false; reason: string } {
  const key = signingKey();
  if (!key) return { ok: true, payload: serialized };
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(serialized);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (
    !isRecord(wrapper) ||
    wrapper.signatureVersion !== SIGNATURE_VERSION ||
    typeof wrapper.payload !== 'string' ||
    typeof wrapper.mac !== 'string'
  ) {
    return { ok: false, reason: 'missing-state-signature' };
  }
  const expected = Buffer.from(macFor(wrapper.payload, key), 'hex');
  const actual = Buffer.from(wrapper.mac, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'invalid-state-signature' };
  }
  return { ok: true, payload: wrapper.payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isAttempt(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function isContext(value: unknown): value is DeliveryContext {
  if (!isRecord(value)) return false;
  return (
    ['sender', 'subject', 'messageId'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value.receivedAt === undefined || isIsoDate(value.receivedAt)) &&
    (value.channelData === undefined || value.channelData !== null)
  );
}

function isPreparedDelivery(value: unknown): value is PreparedDelivery {
  return (
    isRecord(value) &&
    isNonEmptyString(value.channel) &&
    isNonEmptyString(value.deliveryId) &&
    isNonEmptyString(value.jid) &&
    Object.prototype.hasOwnProperty.call(value, 'payload') &&
    value.payload !== undefined
  );
}

function validateState(
  value: unknown,
  expectedJid?: string,
): { ok: true; state: DeliveryState } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'invalid-state' };
  if (value.version !== STATE_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (expectedJid !== undefined && value.chatJid !== expectedJid) {
    return { ok: false, reason: 'chat-jid-mismatch' };
  }
  if (
    !isNonEmptyString(value.chatJid) ||
    !isIsoDate(value.targetTimestamp) ||
    typeof value.previousCursor !== 'string' ||
    !isContext(value.context) ||
    !isNonEmptyString(value.outcomeId) ||
    (Object.hasOwn(value, 'trustedBodyAddresses') &&
      (!Array.isArray(value.trustedBodyAddresses) ||
        !value.trustedBodyAddresses.every(
          (address) => typeof address === 'string',
        )))
  ) {
    return { ok: false, reason: 'invalid-common-fields' };
  }

  if (value.phase === 'repair-required') {
    if (
      !isNonEmptyString(value.gateReason) ||
      typeof value.rejectedOutput !== 'string' ||
      !isAttempt(value.attempt) ||
      !isIsoDate(value.createdAt)
    ) {
      return { ok: false, reason: 'invalid-repair-state' };
    }
    return { ok: true, state: value as unknown as RepairRequiredState };
  }

  if (value.phase === 'transport-pending') {
    if (
      !isPreparedDelivery(value.prepared) ||
      value.prepared.jid !== value.chatJid ||
      typeof value.replyText !== 'string' ||
      !isAttempt(value.attempt) ||
      !isIsoDate(value.createdAt)
    ) {
      return { ok: false, reason: 'invalid-transport-state' };
    }
    return { ok: true, state: value as unknown as TransportPendingState };
  }

  if (value.phase === 'provider-accepted') {
    if (
      !isPreparedDelivery(value.prepared) ||
      value.prepared.jid !== value.chatJid ||
      typeof value.replyText !== 'string' ||
      !isAttempt(value.attempt) ||
      !isNonEmptyString(value.providerId) ||
      !isIsoDate(value.acceptedAt)
    ) {
      return { ok: false, reason: 'invalid-provider-state' };
    }
    return { ok: true, state: value as unknown as ProviderAcceptedState };
  }

  return { ok: false, reason: 'unsupported-phase' };
}

export function loadDeliveryState(jid: string): LoadDeliveryStateResult {
  const serialized = getRouterState(stateKey(jid));
  if (serialized === undefined) return { status: 'none' };
  if (Buffer.byteLength(serialized, 'utf8') > CONTAINER_MAX_OUTPUT_SIZE) {
    return { status: 'invalid', reason: 'state-too-large' };
  }
  const unwrapped = unwrapSignedState(serialized);
  if (!unwrapped.ok) {
    return { status: 'invalid', reason: unwrapped.reason };
  }
  try {
    const result = validateState(JSON.parse(unwrapped.payload), jid);
    return result.ok
      ? { status: 'valid', state: result.state }
      : { status: 'invalid', reason: result.reason };
  } catch {
    return { status: 'invalid', reason: 'malformed-json' };
  }
}

export function saveDeliveryState(
  state: DeliveryState,
): SaveDeliveryStateResult {
  const result = validateState(state, state.chatJid);
  if (!result.ok) return { status: 'invalid', reason: result.reason };

  let serialized: string;
  try {
    serialized = JSON.stringify(result.state);
  } catch {
    return { status: 'invalid', reason: 'unserializable-state' };
  }
  if (Buffer.byteLength(serialized, 'utf8') > CONTAINER_MAX_OUTPUT_SIZE) {
    return { status: 'invalid', reason: 'state-too-large' };
  }
  const key = signingKey();
  const stored = key
    ? JSON.stringify({
        signatureVersion: SIGNATURE_VERSION,
        payload: serialized,
        mac: macFor(serialized, key),
      })
    : serialized;
  if (Buffer.byteLength(stored, 'utf8') > CONTAINER_MAX_OUTPUT_SIZE) {
    return { status: 'invalid', reason: 'state-too-large' };
  }
  setRouterState(stateKey(state.chatJid), stored);
  return { status: 'saved' };
}

export function clearDeliveryState(jid: string): void {
  deleteRouterState(stateKey(jid));
}

export function isTransportExpired(
  state: DeliveryState,
  now = new Date(),
): boolean {
  if (state.phase !== 'transport-pending') return false;
  return now.getTime() - Date.parse(state.createdAt) >= TRANSPORT_TTL_MS;
}
