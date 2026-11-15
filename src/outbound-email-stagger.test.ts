import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('./env.js', () => ({
  readEnvFile: () => ({
    RESEND_API_KEY: 'test-resend-key',
    SEND_FROM_NAME: 'Coordinator',
    SEND_FROM_EMAIL: 'program@example.org',
    OPERATOR_CC_EMAIL: 'avery@example.edu',
  }),
}));

vi.mock('./channels/webhook-allowlist.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('./channels/webhook-allowlist.js')>();
  return {
    ...original,
    loadEmailAllowlistFrom: () => ({
      available: true,
      senders: new Set(['person@example.edu']),
      source: 'test',
    }),
    loadEmailAllowlistFromAsync: async () => ({
      available: true,
      senders: new Set(['person@example.edu']),
      source: 'test',
    }),
  };
});

vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({ refresh: vi.fn(), readFile: vi.fn() }),
}));

vi.mock('./audit-log.js', () => ({ logOutboundEmail: vi.fn() }));

vi.mock('./delivery-gate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./delivery-gate.js')>();
  return {
    ...original,
    reportDeliveryShortfall: vi.fn(),
  };
});

import {
  MAX_OUTBOX_ATTEMPTS,
  getOutboxRetentionMs,
  _nextStaggerDelayMsForTests,
  _resetOutboxRetentionForTests,
  _setOutboxRetentionMsForTests,
  _resetOutboundEmailQueueForTests,
  _resetOutboundQueueTailForTests,
  _resetStaggerConfigForTests,
  _setOutboxStoreForTests,
  _setProviderTimeoutMsForTests,
  _setStaggerMsForTests,
  getStaggerMs,
  sendOutboundEmailResult,
  shutdownOutboundEmailQueue,
  startOutboundEmailQueue,
} from './outbound-email.js';
import { reportDeliveryShortfall } from './delivery-gate.js';
import { getOutboxStore, MemoryOutboxStore } from './outbound-email-outbox.js';

const EMAIL = {
  to: 'person@example.edu',
  subject: 'Test subject',
  body: 'Test body',
};

const OPTIONS = {
  sourceGroup: 'webhook-email:test',
  forceBotReplyTo: true,
  deliveryId: 'delivery-123',
};

describe('outbound email stagger queue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(100);
    _setProviderTimeoutMsForTests(50);
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-123' }),
    });
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('defaults to 30 seconds when the env var is unset', () => {
    _resetStaggerConfigForTests();
    delete process.env.OUTBOUND_EMAIL_STAGGER_MS;
    expect(getStaggerMs()).toBe(30_000);
  });

  it('rejects non-digit and out-of-range values', () => {
    _resetStaggerConfigForTests();
    const cases = [
      { raw: '0', expected: 30_000 },
      { raw: 'abc', expected: 30_000 },
      { raw: ' 35000 ', expected: 30_000 },
      { raw: '0x7530', expected: 30_000 },
      { raw: '29999', expected: 30_000 },
      { raw: '60001', expected: 30_000 },
      { raw: '30000', expected: 30_000 },
      { raw: '60000', expected: 60_000 },
    ];
    for (const { raw, expected } of cases) {
      delete process.env.OUTBOUND_EMAIL_STAGGER_MS;
      process.env.OUTBOUND_EMAIL_STAGGER_MS = raw;
      expect(getStaggerMs(), `raw=${raw}`).toBe(expected);
    }
  });

  it('serializes concurrent sends with the configured inter-send delay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    // These fake timers run with shouldAdvanceTime, so real elapsed time also
    // moves the clock. With a 100 ms stagger the "not yet" probe sat 1 ms from
    // the boundary and failed under parallel-suite load (~1 run in 8); a 5 s
    // stagger keeps the same assertions a full second away from it.
    _setStaggerMsForTests(5_000);

    const p1 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-1',
    });
    const p2 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await p1).toEqual({ status: 'sent', resendId: 'resend-123' });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(await p2).toEqual({ status: 'sent', resendId: 'resend-123' });
  });

  it('does not report a queued send as a shortfall', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });

    const p1 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-1',
    });
    const p2 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(await p1).toEqual({
      status: 'failed',
      reason: 'resend-api-error: HTTP 500',
      retryable: true,
    });
    expect(reportDeliveryShortfall).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(await p2).toEqual({
      status: 'failed',
      reason: 'resend-api-error: HTTP 500',
      retryable: true,
    });
    // Only the actual failures are reported, never the queue delay itself.
    expect(reportDeliveryShortfall).toHaveBeenCalledTimes(2);
  });

  it('provider timeout unblocks a hung send and lets the queue advance', async () => {
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(50);
    // Never-resolving fetch, but it receives the signal.
    mockFetch.mockImplementation(
      () =>
        new Promise(() => {
          /* hang */
        }),
    );

    const p1 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-hung-1',
    });
    const p2 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-hung-2',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

    await vi.advanceTimersByTimeAsync(50);
    const r1 = await p1;
    expect(r1).toEqual({
      status: 'failed',
      reason: 'send-exception: provider-deadline-exceeded',
      retryable: true,
    });
    expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(reportDeliveryShortfall).toHaveBeenCalledTimes(1);

    // The queue advanced and the second send was attempted.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const r2 = await p2;
    expect(r2).toEqual({
      status: 'failed',
      reason: 'send-exception: provider-deadline-exceeded',
      retryable: true,
    });
    expect(reportDeliveryShortfall).toHaveBeenCalledTimes(2);
  });

  it('replays pending work after a restart without loss or duplicates', async () => {
    _setStaggerMsForTests(1000);
    _setProviderTimeoutMsForTests(50);
    const batchId = 'restart-batch:1';

    const p1 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      lane: 'bulk',
      batchId,
      position: 0,
      deliveryId: `${batchId}:0`,
    });
    const p2 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      lane: 'bulk',
      batchId,
      position: 1,
      deliveryId: `${batchId}:1`,
    });

    await vi.advanceTimersByTimeAsync(0);
    await p1;
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Simulate a process restart: the outbox still exists, but the in-memory
    // queue state is gone. Starting the queue should replay the pending item.
    _resetOutboundQueueTailForTests();
    startOutboundEmailQueue();

    await vi.advanceTimersByTimeAsync(0);
    await p2;
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const outbox = getOutboxStore();
    expect(outbox.get(`${batchId}:0`)?.status).toBe('sent');
    expect(outbox.get(`${batchId}:1`)?.status).toBe('sent');
  });

  // Round 3 review, P1: a graceful shutdown must never be a terminal delivery
  // disposition. The end-to-end proof (real process, real signal, real SQLite,
  // exactly-once replay) is in outbound-email-restart.test.ts; this is the
  // in-process contract that goes with it.
  it('shutdown leaves unsent work pending and reports no shortfall for it', async () => {
    _setStaggerMsForTests(1_000);
    _setProviderTimeoutMsForTests(50);
    const batchId = 'shutdown-batch:1';

    const p1 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      lane: 'bulk',
      batchId,
      position: 0,
      deliveryId: `${batchId}:0`,
    });
    const p2 = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      lane: 'bulk',
      batchId,
      position: 1,
      deliveryId: `${batchId}:1`,
    });

    await vi.advanceTimersByTimeAsync(0);
    await p1;
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Shutdown while the second send is still waiting in the stagger gap.
    const shutdown = shutdownOutboundEmailQueue(50);
    await vi.advanceTimersByTimeAsync(50);
    await shutdown;

    // The waiting caller gets a RETRYABLE result — the row is not lost, it is
    // deferred to the next process.
    await expect(p2).resolves.toEqual({
      status: 'failed',
      reason: 'outbox-deferred-restart',
      retryable: true,
    });

    const outbox = getOutboxStore();
    expect(outbox.get(`${batchId}:0`)?.status).toBe('sent');
    expect(outbox.get(`${batchId}:1`)?.status).toBe('pending');
    expect(outbox.get(`${batchId}:1`)?.claimPid).toBeUndefined();

    // A deferred row is not a delivery shortfall: nothing was missed yet.
    const reasons = vi
      .mocked(reportDeliveryShortfall)
      .mock.calls.map((c) => c[0].reason);
    expect(reasons).not.toContain('outbox-shutdown');
    expect(reasons).toEqual([]);

    // And the dead process does not send it again.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a retryable failure backs off, keeps the row claimable, and lets later work through', async () => {
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(50);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });

    const first = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'retry-first',
    });
    expect(first).toEqual({
      status: 'failed',
      reason: 'resend-api-error: HTTP 500',
      retryable: true,
    });

    const outbox = getOutboxStore();
    await vi.advanceTimersByTimeAsync(0);

    // The lane must not leave the row it just finished with claimed by itself.
    const row = outbox.get('retry-first')!;
    expect(row.status).toBe('failed');
    expect(row.claimPid).toBeUndefined();
    expect(row.attempts).toBe(1);

    // Later work in the same lane still goes out.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-later' }),
    });
    const later = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'retry-later',
    });
    expect(later).toEqual({ status: 'sent', resendId: 'resend-later' });
  });

  it('dead-letters a row once the retry budget is exhausted', async () => {
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(50);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });

    await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'budget:0',
    });

    // Let every backoff elapse; the queue retries on its own timer.
    await vi.advanceTimersByTimeAsync(120_000);

    const row = getOutboxStore().get('budget:0')!;
    expect(row.status).toBe('dead-letter');
    expect(row.attempts).toBe(MAX_OUTBOX_ATTEMPTS);
    expect(mockFetch).toHaveBeenCalledTimes(MAX_OUTBOX_ATTEMPTS);
    const reasons = vi
      .mocked(reportDeliveryShortfall)
      .mock.calls.map((c) => c[0].reason);
    expect(reasons.at(-1)).toContain('outbox-max-attempts-exceeded');
  });

  it('compacts terminal rows during the process lifetime, not only at startup', async () => {
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(50);
    _setOutboxRetentionMsForTests(50);

    await sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: 'old:0' });
    await vi.advanceTimersByTimeAsync(0);
    expect(getOutboxStore().get('old:0')?.status).toBe('sent');

    // Age the finished row past the retention window without restarting.
    await vi.advanceTimersByTimeAsync(200);
    await sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: 'new:0' });
    await vi.advanceTimersByTimeAsync(0);

    expect(getOutboxStore().get('old:0')).toBeUndefined();
    expect(getOutboxStore().get('new:0')?.status).toBe('sent');
  });

  it('bounds the retention window configured by env', () => {
    _resetOutboxRetentionForTests();
    const cases = [
      { raw: undefined, expected: 24 * 60 * 60 * 1000 },
      { raw: '0', expected: 24 * 60 * 60 * 1000 },
      { raw: 'abc', expected: 24 * 60 * 60 * 1000 },
      { raw: '1000', expected: 24 * 60 * 60 * 1000 }, // below the floor
      { raw: String(31 * 24 * 60 * 60 * 1000), expected: 24 * 60 * 60 * 1000 },
      { raw: String(60 * 60 * 1000), expected: 60 * 60 * 1000 },
    ];
    for (const { raw, expected } of cases) {
      delete process.env.OUTBOUND_EMAIL_OUTBOX_RETENTION_MS;
      if (raw !== undefined) {
        process.env.OUTBOUND_EMAIL_OUTBOX_RETENTION_MS = raw;
      }
      expect(getOutboxRetentionMs(), `raw=${raw}`).toBe(expected);
    }
    delete process.env.OUTBOUND_EMAIL_OUTBOX_RETENTION_MS;
  });

  it('keeps bulk and transactional lanes independent', async () => {
    _setStaggerMsForTests(100);
    _setProviderTimeoutMsForTests(50);

    const bulk = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      lane: 'bulk',
      deliveryId: 'lane-bulk:0',
    });

    await vi.advanceTimersByTimeAsync(0);
    await bulk; // bulk sends, then its lane sleeps for the stagger
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Transactional should complete without waiting for the bulk stagger.
    const tx = sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      lane: 'transactional',
      deliveryId: 'lane-tx:0',
    });
    await vi.advanceTimersByTimeAsync(0);
    await tx;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('bounds delay jitter between 0 and 20% of base (capped at 5s)', () => {
    _setStaggerMsForTests(100);
    const randomSpy = vi.spyOn(Math, 'random');

    randomSpy.mockReturnValue(0);
    expect(_nextStaggerDelayMsForTests()).toBe(100);

    randomSpy.mockReturnValue(0.999999);
    expect(_nextStaggerDelayMsForTests()).toBe(120); // 100 + 20% of 100

    _setStaggerMsForTests(60_000);
    randomSpy.mockReturnValue(0.999999);
    expect(_nextStaggerDelayMsForTests()).toBe(65_000); // 60,000 + 5,000 cap

    randomSpy.mockReturnValue(0);
    expect(_nextStaggerDelayMsForTests()).toBe(60_000);
  });

  it('observes bulk queue depth and age guards', async () => {
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(50);

    // Fill the bulk lane to its configured 25-item depth.
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i++) {
      promises.push(
        sendOutboundEmailResult(EMAIL, {
          ...OPTIONS,
          lane: 'bulk',
          deliveryId: `depth:${i}`,
        }),
      );
    }

    // Only the first 25 are accepted; the 26th is refused.
    const overflow = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      lane: 'bulk',
      deliveryId: 'depth:overflow',
    });
    expect(overflow).toEqual({
      status: 'failed',
      reason: 'outbox-max-depth-exceeded',
      retryable: false,
    });
    expect(reportDeliveryShortfall).toHaveBeenCalled();

    // Drain the queue.
    for (const p of promises) await p;
  });
});
