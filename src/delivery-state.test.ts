import { createHmac } from 'crypto';
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
  _resetDeliveryStateKeysForTests,
  clearDeliveryState,
  initDeliveryStateKeys,
  isTransportExpired,
  loadDeliveryState,
  resolveDeliveryStateKeys,
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

// Issue 56: the signing key. A dedicated DELIVERY_STATE_SIGNING_KEY signs;
// without it the host falls back, as before, to a channel secret from .env.
// State signed with the fallback still loads after a dedicated key is set.
describe('delivery-state signing keys', () => {
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
  let envDir: string;

  /** The working folder's .env, which is where the fallback secrets live. */
  function writeEnv(lines: Record<string, string>): void {
    fs.writeFileSync(
      path.join(envDir, '.env'),
      Object.entries(lines)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(''),
      { mode: 0o600 },
    );
  }

  /** What the version before this change computed for the same settings. */
  function macAsBefore(payload: string, key: string): string {
    return createHmac('sha256', key)
      .update('nanoclaw-delivery-state-v1\0')
      .update(payload)
      .digest('hex');
  }

  function storedRaw(): { payload: string; mac: string } {
    return JSON.parse(getRouterState(`delivery-state:${JID}`)!);
  }

  beforeEach(() => {
    envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-keys-'));
    vi.spyOn(process, 'cwd').mockReturnValue(envDir);
    vi.stubEnv('DELIVERY_STATE_SIGNING_KEY', '');
    _resetDeliveryStateKeysForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetDeliveryStateKeysForTests();
    fs.rmSync(envDir, { recursive: true, force: true });
  });

  it('falls back in the documented order, exactly as before: WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN, RESEND_API_KEY', () => {
    writeEnv({
      RESEND_API_KEY: 'fake-mail-key',
      TELEGRAM_BOT_TOKEN: 'fake-telegram-token',
      WEBHOOK_SECRET: 'fake-webhook-secret',
    });
    expect(resolveDeliveryStateKeys()).toEqual({
      sign: 'fake-webhook-secret',
      verify: ['fake-webhook-secret'],
      source: 'WEBHOOK_SECRET',
    });
    writeEnv({
      RESEND_API_KEY: 'fake-mail-key',
      TELEGRAM_BOT_TOKEN: 'fake-telegram-token',
    });
    expect(resolveDeliveryStateKeys().source).toBe('TELEGRAM_BOT_TOKEN');
    writeEnv({ RESEND_API_KEY: 'fake-mail-key' });
    expect(resolveDeliveryStateKeys().source).toBe('RESEND_API_KEY');
    writeEnv({});
    expect(resolveDeliveryStateKeys()).toEqual({
      sign: undefined,
      verify: [],
      source: null,
    });
  });

  it('with only a fallback secret, signs with the same MAC as before this change', () => {
    writeEnv({ WEBHOOK_SECRET: 'fake-webhook-secret' });
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    const raw = storedRaw();
    expect(raw.mac).toBe(macAsBefore(raw.payload, 'fake-webhook-secret'));
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state });
  });

  it('reads the dedicated key from .env too, and prefers the process environment', () => {
    writeEnv({
      DELIVERY_STATE_SIGNING_KEY: 'fake-dedicated-from-file',
      WEBHOOK_SECRET: 'fake-webhook-secret',
    });
    expect(resolveDeliveryStateKeys()).toEqual({
      sign: 'fake-dedicated-from-file',
      verify: ['fake-dedicated-from-file', 'fake-webhook-secret'],
      source: 'DELIVERY_STATE_SIGNING_KEY',
    });
    vi.stubEnv('DELIVERY_STATE_SIGNING_KEY', 'fake-dedicated-from-env');
    expect(resolveDeliveryStateKeys().sign).toBe('fake-dedicated-from-env');
  });

  it('state signed with the fallback secret still loads after a dedicated key is set, and new state is signed with the dedicated key', () => {
    writeEnv({ WEBHOOK_SECRET: 'fake-webhook-secret' });
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    const old = storedRaw();

    // The operator adds the dedicated key and restarts.
    writeEnv({
      DELIVERY_STATE_SIGNING_KEY: 'fake-dedicated-key',
      WEBHOOK_SECRET: 'fake-webhook-secret',
    });
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state });

    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    const fresh = storedRaw();
    expect(fresh.mac).toBe(macAsBefore(fresh.payload, 'fake-dedicated-key'));
    expect(fresh.mac).not.toBe(old.mac);
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state });
  });

  it('with a dedicated key, rotating the channel secret does not invalidate saved state', () => {
    writeEnv({
      DELIVERY_STATE_SIGNING_KEY: 'fake-dedicated-key',
      WEBHOOK_SECRET: 'fake-webhook-secret',
    });
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    writeEnv({
      DELIVERY_STATE_SIGNING_KEY: 'fake-dedicated-key',
      WEBHOOK_SECRET: 'fake-webhook-secret-rotated',
    });
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state });
  });

  it('state saved under one key and loaded under another is invalid, and the caller dead-letters it, clears it and retries the message', async () => {
    writeEnv({ WEBHOOK_SECRET: 'fake-webhook-secret' });
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    // The only key is replaced (no dedicated key, the reused secret rotated).
    writeEnv({ WEBHOOK_SECRET: 'fake-webhook-secret-rotated' });
    expect(loadDeliveryState(JID)).toEqual({
      status: 'invalid',
      reason: 'invalid-state-signature',
    });

    // What src/index.ts does with it: processDelivery with the real load and
    // clear functions (index.ts passes exactly these two).
    const { processDelivery } = await import('./delivery-processor.js');
    const auditDeadLetter = vi.fn(() => 'written' as const);
    const alertDeadLetter = vi.fn(async () => undefined);
    const runBusinessAgent = vi.fn();
    const result = await processDelivery(
      {
        chatJid: JID,
        prompt: 'unused',
        previousCursor: '',
        targetTimestamp: '2026-08-10T15:00:00.000Z',
      } as never,
      {
        loadState: loadDeliveryState,
        clearState: clearDeliveryState,
        auditDeadLetter,
        alertDeadLetter,
        runBusinessAgent,
      } as never,
    );
    expect(result).toEqual({ status: 'retry', attempt: 1 });
    expect(auditDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'corrupt-state',
        reason: 'corrupt-state: invalid-state-signature',
      }),
    );
    expect(alertDeadLetter).toHaveBeenCalledTimes(1);
    // The forged or stale state is gone; no reply was sent from it.
    expect(runBusinessAgent).not.toHaveBeenCalled();
    expect(loadDeliveryState(JID)).toEqual({ status: 'none' });
  });

  it('a tampered payload is refused whichever key is tried', () => {
    writeEnv({
      DELIVERY_STATE_SIGNING_KEY: 'fake-dedicated-key',
      WEBHOOK_SECRET: 'fake-webhook-secret',
    });
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    const raw = storedRaw();
    raw.payload = raw.payload.replace('person@example.edu', 'x@example.com');
    setRouterState(`delivery-state:${JID}`, JSON.stringify(raw));
    expect(loadDeliveryState(JID)).toEqual({
      status: 'invalid',
      reason: 'invalid-state-signature',
    });
  });

  it('after initDeliveryStateKeys the settings are read once: an edit of .env takes effect at the restart only', () => {
    writeEnv({ WEBHOOK_SECRET: 'fake-webhook-secret' });
    expect(initDeliveryStateKeys().source).toBe('WEBHOOK_SECRET');
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });

    // Someone edits .env while the host runs. The listener still holds the
    // old secret; so does the state signer.
    writeEnv({ WEBHOOK_SECRET: 'fake-webhook-secret-rotated' });
    vi.stubEnv('DELIVERY_STATE_SIGNING_KEY', 'fake-dedicated-set-later');
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state });
    expect(saveDeliveryState(state)).toEqual({ status: 'saved' });
    const raw = storedRaw();
    expect(raw.mac).toBe(macAsBefore(raw.payload, 'fake-webhook-secret'));

    // The restart.
    expect(initDeliveryStateKeys()).toEqual({
      sign: 'fake-dedicated-set-later',
      verify: ['fake-dedicated-set-later', 'fake-webhook-secret-rotated'],
      source: 'DELIVERY_STATE_SIGNING_KEY',
    });
  });

  it('the host warns at start when a channel secret is reused, naming the setting and never the value', () => {
    const text = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    const main = text.slice(text.indexOf('async function main()'));
    expect(main).toMatch(/const deliveryKeys = initDeliveryStateKeys\(\);/);
    expect(main).toMatch(
      /deliveryKeys\.source !== 'DELIVERY_STATE_SIGNING_KEY'/,
    );
    expect(main).toMatch(
      /Set DELIVERY_STATE_SIGNING_KEY to its own long random value/,
    );
    expect(main).not.toMatch(/deliveryKeys\.(sign|verify)/);
  });
});
