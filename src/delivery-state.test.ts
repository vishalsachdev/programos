import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getRouterState,
  setRouterState,
} from './db.js';
import {
  clearDeliveryState,
  isTransportExpired,
  loadDeliveryState,
  saveDeliveryState,
  type DeliveryState,
} from './delivery-state.js';

const JID = 'webhook-email:thread-1';
const CONTEXT = {
  sender: 'person@example.edu',
  subject: 'Launch question',
  receivedAt: '2026-08-10T15:00:00.000Z',
  messageId: 'message-1@example.com',
};
const PREPARED = {
  channel: 'webhook',
  deliveryId: 'delivery-1',
  jid: JID,
  payload: { to: 'person@example.edu', body: 'Hello' },
};

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-state-'));
  dbPath = path.join(testDir, 'messages.db');
  _initTestDatabase(dbPath);
});

afterEach(() => {
  _closeDatabase();
  fs.rmSync(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('delivery state persistence', () => {
  it.each<DeliveryState>([
    {
      version: 1,
      phase: 'repair-required',
      chatJid: JID,
      targetTimestamp: '2026-08-10T15:00:00.000Z',
      previousCursor: '',
      context: CONTEXT,
      outcomeId: 'outcome-1',
      gateReason: 'missing-reply-block',
      rejectedOutput: 'Already processed.',
      attempt: 1,
      createdAt: '2026-08-10T15:01:00.000Z',
    },
    {
      version: 1,
      phase: 'transport-pending',
      chatJid: JID,
      targetTimestamp: '2026-08-10T15:00:00.000Z',
      previousCursor: '',
      context: CONTEXT,
      outcomeId: 'outcome-1',
      prepared: PREPARED,
      replyText: 'Hello',
      attempt: 2,
      createdAt: '2026-08-10T15:01:00.000Z',
    },
    {
      version: 1,
      phase: 'provider-accepted',
      chatJid: JID,
      targetTimestamp: '2026-08-10T15:00:00.000Z',
      previousCursor: '',
      context: CONTEXT,
      outcomeId: 'outcome-1',
      prepared: PREPARED,
      replyText: 'Hello',
      attempt: 2,
      providerId: 'resend-1',
      acceptedAt: '2026-08-10T15:02:00.000Z',
    },
  ])('round-trips $phase across a database reload', (state) => {
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state });

    _initTestDatabase(dbPath);
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state });
  });

  it('returns none and clears a stored state', () => {
    expect(loadDeliveryState(JID)).toEqual({ status: 'none' });
    expect(
      saveDeliveryState({
        version: 1,
        phase: 'transport-pending',
        chatJid: JID,
        targetTimestamp: '2026-08-10T15:00:00.000Z',
        previousCursor: '',
        context: CONTEXT,
        outcomeId: 'outcome-1',
        prepared: PREPARED,
        replyText: 'Hello',
        attempt: 1,
        createdAt: '2026-08-10T15:01:00.000Z',
      }),
    ).toEqual({ status: 'saved' });
    clearDeliveryState(JID);
    expect(loadDeliveryState(JID)).toEqual({ status: 'none' });
  });

  it('fails closed on an unsupported version', () => {
    setRouterState(
      `delivery-state:${JID}`,
      JSON.stringify({ version: 99, phase: 'transport-pending' }),
    );

    expect(loadDeliveryState(JID)).toEqual({
      status: 'invalid',
      reason: 'unsupported-version',
    });
  });

  it('fails closed when the stored jid does not match the lookup jid', () => {
    setRouterState(
      `delivery-state:${JID}`,
      JSON.stringify({
        version: 1,
        phase: 'transport-pending',
        chatJid: 'webhook-email:other',
      }),
    );

    expect(loadDeliveryState(JID)).toEqual({
      status: 'invalid',
      reason: 'chat-jid-mismatch',
    });
  });

  it('fails closed on an unknown phase', () => {
    setRouterState(
      `delivery-state:${JID}`,
      JSON.stringify({
        version: 1,
        phase: 'teleported',
        chatJid: JID,
        targetTimestamp: '2026-08-10T15:00:00.000Z',
        previousCursor: '',
        context: CONTEXT,
        outcomeId: 'outcome-1',
      }),
    );

    expect(loadDeliveryState(JID)).toEqual({
      status: 'invalid',
      reason: 'unsupported-phase',
    });
  });

  it('rejects an oversized serialized state', () => {
    const result = saveDeliveryState({
      version: 1,
      phase: 'repair-required',
      chatJid: JID,
      targetTimestamp: '2026-08-10T15:00:00.000Z',
      previousCursor: '',
      context: CONTEXT,
      outcomeId: 'outcome-1',
      gateReason: 'missing-reply-block',
      rejectedOutput: 'x'.repeat(10 * 1024 * 1024 + 1),
      attempt: 1,
      createdAt: '2026-08-10T15:01:00.000Z',
    });

    expect(result).toEqual({ status: 'invalid', reason: 'state-too-large' });
    expect(loadDeliveryState(JID)).toEqual({ status: 'none' });
  });

  it('detects the 24-hour provider idempotency boundary', () => {
    const state: DeliveryState = {
      version: 1,
      phase: 'transport-pending',
      chatJid: JID,
      targetTimestamp: '2026-08-10T15:00:00.000Z',
      previousCursor: '',
      context: CONTEXT,
      outcomeId: 'outcome-1',
      prepared: PREPARED,
      replyText: 'Hello',
      attempt: 1,
      createdAt: '2026-08-10T15:00:00.000Z',
    };

    expect(isTransportExpired(state, new Date('2026-08-11T14:59:59Z'))).toBe(
      false,
    );
    expect(isTransportExpired(state, new Date('2026-08-11T15:00:00Z'))).toBe(
      true,
    );
  });

  it('rejects a host-state payload altered after it was signed', () => {
    vi.stubEnv('DELIVERY_STATE_SIGNING_KEY', 'test-host-only-key');
    const state: DeliveryState = {
      version: 1,
      phase: 'transport-pending',
      chatJid: JID,
      targetTimestamp: '2026-08-10T15:00:00.000Z',
      previousCursor: '',
      context: CONTEXT,
      outcomeId: 'outcome-1',
      prepared: PREPARED,
      replyText: 'Hello',
      attempt: 1,
      createdAt: '2026-08-10T15:01:00.000Z',
    };
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    const raw = JSON.parse(getRouterState(`delivery-state:${JID}`)!);
    raw.payload = raw.payload.replace(
      'person@example.edu',
      'attacker@example.com',
    );
    setRouterState(`delivery-state:${JID}`, JSON.stringify(raw));

    expect(loadDeliveryState(JID)).toEqual({
      status: 'invalid',
      reason: 'invalid-state-signature',
    });
  });
});
