/**
 * The lane's wake timer for retryable rows (scheduleLaneRetry).
 *
 * The invariant under test: a lane that holds a retryable row and has no row
 * in flight always has a wake timer pending. The clock is fake, so "the timer
 * fired 1 ms early" is set up exactly, not hoped for under load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const state = {
    available: true,
    senders: new Set(['person@example.edu']),
    source: 'test',
  };
  return {
    ...original,
    loadEmailAllowlistFrom: () => state,
    loadEmailAllowlistFromAsync: async () => state,
  };
});

vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({ refresh: vi.fn(), readFile: vi.fn() }),
}));

vi.mock('./audit-log.js', () => ({ logOutboundEmail: vi.fn() }));

vi.mock('./delivery-gate.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./delivery-gate.js')>();
  return { ...original, reportDeliveryShortfall: vi.fn() };
});

import {
  MAX_OUTBOX_ATTEMPTS,
  _resetOutboundEmailQueueForTests,
  _resetOutboundQueueTailForTests,
  _setProviderTimeoutMsForTests,
  _setStaggerMsForTests,
  retryBackoffMs,
  sendOutboundEmailResult,
  startOutboundEmailQueue,
} from './outbound-email.js';
import Database from 'better-sqlite3';

import {
  MemoryOutboxStore,
  SqliteOutboxStore,
  type OutboxLane,
  type OutboxRow,
  type OutboxStore,
} from './outbound-email-outbox.js';

const EMAIL = {
  to: 'person@example.edu',
  subject: 'Test subject',
  body: 'Test body',
};

const OPTIONS = {
  sourceGroup: 'webhook-email:test',
  forceBotReplyTo: true,
};

const START = Date.parse('2026-01-05T12:00:00.000Z');

/**
 * The in-memory store, recording the clock each lane query was given, and
 * able to let the clock move on by 1 ms after a claim that found nothing. A
 * real clock does that between two statements; a fake one does not unless
 * told to.
 */
class RecordingStore extends MemoryOutboxStore {
  emptyClaimsAt: number[] = [];
  tickAfterEmptyClaim = false;
  failNextRetryRead = false;
  failNextClaim = false;

  override claimNextPending(
    lane: OutboxLane,
    now: number,
    processId: number,
    leaseMs: number,
    maxAgeMs: number,
    excludeDeliveryId?: string,
  ): OutboxRow | undefined {
    if (this.failNextClaim) {
      this.failNextClaim = false;
      throw new Error('claim failed');
    }
    const row = super.claimNextPending(
      lane,
      now,
      processId,
      leaseMs,
      maxAgeMs,
      excludeDeliveryId,
    );
    if (!row && lane === 'transactional') {
      this.emptyClaimsAt.push(now);
      if (this.tickAfterEmptyClaim) vi.setSystemTime(Date.now() + 1);
    }
    return row;
  }

  override nextRetryAt(lane: OutboxLane, now: number): number | undefined {
    if (this.failNextRetryRead) {
      this.failNextRetryRead = false;
      throw new Error('read failed');
    }
    return super.nextRetryAt(lane, now);
  }
}

function failWith500(): void {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 500,
    text: async () => 'boom',
  });
}

function succeed(): void {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'resend-ok' }),
  });
}

/**
 * Make every pending timer fire `ms` early against the clock: the clock goes
 * back while the timers keep their remaining delay.
 */
function makePendingTimersFireEarlyBy(ms: number): void {
  vi.setSystemTime(Date.now() - ms);
}

let store: RecordingStore;

/** One failed attempt on one row; returns when that row is next due. */
async function oneRetryableFailure(deliveryId: string): Promise<number> {
  failWith500();
  const result = await sendOutboundEmailResult(EMAIL, {
    ...OPTIONS,
    deliveryId,
  });
  expect(result).toMatchObject({ status: 'failed', retryable: true });
  await vi.advanceTimersByTimeAsync(0);
  const row = store.get(deliveryId)!;
  expect(row).toMatchObject({ status: 'failed', attempts: 1 });
  return Date.parse(row.nextAttemptAt!);
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  store = new RecordingStore();
  _resetOutboundEmailQueueForTests(store);
  _setStaggerMsForTests(0);
  _setProviderTimeoutMsForTests(50);
  vi.clearAllMocks();
});

afterEach(() => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  vi.useRealTimers();
});

describe('outbound email lane wake timer', () => {
  it('a wake that fires 1 ms before the row is due still leads to the retry, with no other send and no restart', async () => {
    const due = await oneRetryableFailure('early:0');
    expect(due).toBe(START + retryBackoffMs(1));
    expect(vi.getTimerCount()).toBe(1);

    succeed();
    store.emptyClaimsAt = [];
    store.tickAfterEmptyClaim = true;
    makePendingTimersFireEarlyBy(1);
    await vi.advanceTimersByTimeAsync(retryBackoffMs(1));

    // The wake did come early: its claim ran 1 ms before the row was due and
    // found nothing, and the clock then reached the due time.
    expect(store.emptyClaimsAt).toEqual([due - 1]);
    expect(Date.now()).toBe(due);
    // The invariant: a retryable row and an empty claim leave a timer pending.
    expect(store.get('early:0')!.status).toBe('failed');
    expect(vi.getTimerCount()).toBe(1);

    // No other send in the lane and no restart: only time passes.
    store.tickAfterEmptyClaim = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.get('early:0')).toMatchObject({ status: 'sent', attempts: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1, 2, 7, 250])(
    'after a wake %i ms early with an empty claim, a timer is pending and the retry follows',
    async (earlyMs) => {
      await oneRetryableFailure('early:n');
      succeed();
      store.emptyClaimsAt = [];
      makePendingTimersFireEarlyBy(earlyMs);
      await vi.advanceTimersByTimeAsync(retryBackoffMs(1));

      expect(store.emptyClaimsAt.length).toBeGreaterThanOrEqual(1);
      if (store.get('early:n')!.status !== 'sent') {
        expect(vi.getTimerCount()).toBe(1);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(store.get('early:n')).toMatchObject({
        status: 'sent',
        attempts: 2,
      });
    },
  );

  it('with a stagger longer than the backoff, the row that just failed is still retried', async () => {
    // Production values: the stagger is 30 to 60 s and the first backoffs are
    // 1 to 8 s, so the backoff has always ended when the lane looks again.
    _setStaggerMsForTests(30_000);
    failWith500();
    const first = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'stagger:0',
    });
    expect(first).toMatchObject({ status: 'failed', retryable: true });

    succeed();
    // Past the stagger and its jitter (at most 20%, capped at 5 s).
    await vi.advanceTimersByTimeAsync(36_000);

    expect(store.get('stagger:0')).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('with a stagger longer than the backoff, a row that keeps failing reaches the dead letter by itself', async () => {
    _setStaggerMsForTests(30_000);
    failWith500();
    await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'stagger:dead',
    });

    await vi.advanceTimersByTimeAsync(MAX_OUTBOX_ATTEMPTS * 36_000);

    expect(store.get('stagger:dead')).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
    expect(mockFetch).toHaveBeenCalledTimes(MAX_OUTBOX_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a retryable row with no hold-off time (the exception path) is not left without a timer', async () => {
    // A send that throws is finalized as retryable, with the backoff.
    mockFetch.mockReset();
    const realGet = store.get.bind(store);
    let throwOnce = true;
    vi.spyOn(store, 'set').mockImplementation((row) => {
      if (throwOnce && row.status === 'claimed') {
        throwOnce = false;
        // Leave the row claimed, as a failure after the write would.
        MemoryOutboxStore.prototype.set.call(store, row);
        throw new Error('disk hiccup');
      }
      MemoryOutboxStore.prototype.set.call(store, row);
    });

    const first = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'thrown:0',
    });
    expect(first).toMatchObject({
      status: 'failed',
      retryable: true,
      reason: 'send-queue-exception: disk hiccup',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(realGet('thrown:0')).toMatchObject({ status: 'failed' });
    // A throw is an attempt like any other: it gets the first backoff.
    expect(realGet('thrown:0')).toMatchObject({ attempts: 1 });
    expect(Date.parse(realGet('thrown:0')!.nextAttemptAt!)).toBe(
      START + retryBackoffMs(1),
    );
    expect(vi.getTimerCount()).toBe(1);

    succeed();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(realGet('thrown:0')!.status).toBe('sent');
  });

  it('a failed read of the next retry time does not leave the lane without a timer', async () => {
    failWith500();
    startOutboundEmailQueue();
    store.failNextRetryRead = true;
    await sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: 'read:0' });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.failNextRetryRead).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    succeed();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.get('read:0')!.status).toBe('sent');
  });

  it('a failed claim on a wake does not leave the lane without a timer', async () => {
    await oneRetryableFailure('claim:0');
    succeed();
    store.failNextClaim = true;
    await vi.advanceTimersByTimeAsync(retryBackoffMs(1));
    expect(store.failNextClaim).toBe(false);
    expect(store.get('claim:0')!.status).toBe('failed');
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.get('claim:0')!.status).toBe('sent');
  });

  it('startup replay 1 ms before a row is due sets a timer and retries it', async () => {
    const due = await oneRetryableFailure('replay:0');
    succeed();

    // A new process: no timers, no lane state, the same outbox.
    _resetOutboundQueueTailForTests();
    expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(due - 1);
    store.emptyClaimsAt = [];
    store.tickAfterEmptyClaim = true;
    startOutboundEmailQueue();

    expect(store.emptyClaimsAt).toEqual([due - 1]);
    expect(vi.getTimerCount()).toBe(1);
    store.tickAfterEmptyClaim = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.get('replay:0')).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
  });

  it('a wake with nothing left to retry sets no timer', async () => {
    succeed();
    const sent = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'done:0',
    });
    expect(sent.status).toBe('sent');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// The same hole at the level of the two store queries, for both stores: after
// an empty claim, the "what is the lane waiting for" query must still return
// the row, whatever the clock did in between.
describe('a send that throws counts against the attempt budget', () => {
  /**
   * A throw that escapes the send wrapper and reaches the queue's own catch.
   * The wrapper turns a provider error into a retryable failure result, then
   * reports the shortfall from its catch block; a throw from that report is
   * what the queue sees as "the send threw". The dead-letter report, which has
   * another reason, is left alone.
   */
  async function sendThrows(times = Infinity): Promise<void> {
    const gate = await import('./delivery-gate.js');
    let left = times;
    vi.mocked(gate.reportDeliveryShortfall).mockImplementation((a) => {
      if (a.reason.startsWith('send-exception') && left-- > 0) {
        throw new Error('local error');
      }
    });
    mockFetch.mockImplementation(() => {
      throw new Error('bad payload');
    });
  }

  it('a send that throws every time is attempted the budgeted number of times, with backoff between, then dead-letters', async () => {
    await sendThrows();
    const { reportDeliveryShortfall } = await import('./delivery-gate.js');
    const first = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'throw:dead',
    });
    expect(first).toMatchObject({ status: 'failed', retryable: true });
    await vi.advanceTimersByTimeAsync(0);

    const starts: number[] = [START];
    for (let n = 1; n < MAX_OUTBOX_ATTEMPTS; n++) {
      const row = store.get('throw:dead')!;
      expect(row).toMatchObject({ status: 'failed', attempts: n });
      // Held off for the backoff, not retried at the next stagger.
      expect(Date.parse(row.nextAttemptAt!)).toBe(
        Date.now() + retryBackoffMs(n),
      );
      await vi.advanceTimersByTimeAsync(retryBackoffMs(n) - 1);
      expect(store.get('throw:dead')!.attempts).toBe(n);
      await vi.advanceTimersByTimeAsync(1);
      starts.push(Date.now());
    }

    expect(store.get('throw:dead')).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
    expect(store.get('throw:dead')!.result).toMatchObject({
      status: 'failed',
      retryable: false,
      reason: expect.stringContaining('outbox-max-attempts-exceeded'),
    });
    // The delays between attempts are the backoff schedule.
    expect(starts.slice(1).map((t, i) => t - starts[i])).toEqual(
      Array.from({ length: MAX_OUTBOX_ATTEMPTS - 1 }, (_, i) =>
        retryBackoffMs(i + 1),
      ),
    );
    // Same operator alert as the non-throwing path.
    expect(reportDeliveryShortfall).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('outbox-max-attempts-exceeded'),
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
    // No further attempts after the dead letter.
    const calls = mockFetch.mock.calls.length;
    expect(calls).toBe(MAX_OUTBOX_ATTEMPTS);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it('a store read that fails right after the throw on the last attempt still dead-letters, with no sixth send', async () => {
    await sendThrows();
    const realGet = store.get.bind(store);
    let armed = false;
    vi.spyOn(store, 'get').mockImplementation((id: string) => {
      if (armed) {
        armed = false;
        throw new Error('database is locked');
      }
      return realGet(id);
    });
    // The send throws; on the final permitted attempt the queue's catch block
    // then reads the row, and that read fails.
    mockFetch.mockImplementation(() => {
      if (realGet('throw:read')?.attempts === MAX_OUTBOX_ATTEMPTS - 1) {
        armed = true;
      }
      throw new Error('bad payload');
    });
    await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'throw:read',
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 1; n < MAX_OUTBOX_ATTEMPTS; n++) {
      await vi.advanceTimersByTimeAsync(retryBackoffMs(n));
    }
    expect(armed).toBe(false); // the read really did fail
    expect(store.get('throw:read')).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
    const calls = mockFetch.mock.calls.length;
    expect(calls).toBe(MAX_OUTBOX_ATTEMPTS);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockFetch.mock.calls.length).toBe(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a store that cannot record the last throw leaves no sixth send and raises the alert', async () => {
    await sendThrows();
    const { reportDeliveryShortfall } = await import('./delivery-gate.js');
    const realGet = store.get.bind(store);
    const realFinalize = store.finalize.bind(store);
    let failing = false;
    vi.spyOn(store, 'get').mockImplementation((id: string) => {
      if (failing) throw new Error('database is locked');
      return realGet(id);
    });
    vi.spyOn(store, 'finalize').mockImplementation((...a) => {
      if (failing) throw new Error('database is locked');
      return realFinalize(...a);
    });
    mockFetch.mockImplementation(() => {
      if (realGet('throw:store')?.attempts === MAX_OUTBOX_ATTEMPTS - 1) {
        failing = true;
      }
      throw new Error('bad payload');
    });
    await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'throw:store',
    });
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 1; n < MAX_OUTBOX_ATTEMPTS; n++) {
      await vi.advanceTimersByTimeAsync(retryBackoffMs(n));
    }
    expect(mockFetch.mock.calls.length).toBe(MAX_OUTBOX_ATTEMPTS);
    expect(reportDeliveryShortfall).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('dead letter not recorded'),
      }),
    );
    // The store comes back: the row is not sent again.
    failing = false;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(mockFetch.mock.calls.length).toBe(MAX_OUTBOX_ATTEMPTS);
  });

  it('a send that throws once and then succeeds is delivered on the second attempt after the first backoff', async () => {
    await sendThrows(1);
    const first = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'throw:once',
    });
    expect(first).toMatchObject({ status: 'failed', retryable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get('throw:once')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    succeed();

    await vi.advanceTimersByTimeAsync(retryBackoffMs(1) - 1);
    expect(store.get('throw:once')!.status).toBe('failed');
    await vi.advanceTimersByTimeAsync(1);
    expect(store.get('throw:once')).toMatchObject({
      status: 'sent',
      attempts: 2,
    });
  });
});

describe.each<[string, () => OutboxStore]>([
  ['memory', () => new MemoryOutboxStore()],
  [
    'sqlite',
    () => new SqliteOutboxStore({ database: new Database(':memory:') }),
  ],
])('claim and nextRetryAt leave no gap (%s store)', (_name, makeStore) => {
  const LANE: OutboxLane = 'bulk';
  const LEASE_MS = 60_000;
  const MAX_AGE_MS = 3_600_000;
  const PID = 4242;
  const RETRYABLE = {
    status: 'failed' as const,
    reason: 'resend-api-error: HTTP 500',
    retryable: true,
  };

  function pendingRow(deliveryId: string): OutboxRow {
    const at = new Date(START).toISOString();
    return {
      deliveryId,
      lane: LANE,
      status: 'pending',
      email: { ...EMAIL },
      sendOptions: { ...OPTIONS },
      intended: [EMAIL.to],
      createdAt: at,
      updatedAt: at,
    };
  }

  /** One row that failed once and is held back until `due`. */
  function storeWithRowDueAt(due: number | undefined): OutboxStore {
    const outbox = makeStore();
    outbox.insert(pendingRow('gap:0'));
    expect(
      outbox.claimNextPending(LANE, START, PID, LEASE_MS, MAX_AGE_MS)
        ?.deliveryId,
    ).toBe('gap:0');
    expect(outbox.finalize('gap:0', RETRYABLE, START, due)).toBeDefined();
    return outbox;
  }

  it('a claim 1 ms early finds nothing, and the row is still reported 1 ms later', () => {
    const due = START + 1_000;
    const outbox = storeWithRowDueAt(due);

    expect(
      outbox.claimNextPending(LANE, due - 1, PID, LEASE_MS, MAX_AGE_MS),
    ).toBeUndefined();
    // Before, at and after the due time: the row is never dropped.
    expect(outbox.nextRetryAt(LANE, due - 1)).toBe(due);
    expect(outbox.nextRetryAt(LANE, due)).toBe(due);
    expect(outbox.nextRetryAt(LANE, due + 30_000)).toBe(due);
    // And the claim does take it once the clock is there.
    expect(
      outbox.claimNextPending(LANE, due, PID, LEASE_MS, MAX_AGE_MS)?.deliveryId,
    ).toBe('gap:0');
    expect(outbox.nextRetryAt(LANE, due)).toBeUndefined();
  });

  it('a due row that the claim excludes is still reported', () => {
    const due = START + 1_000;
    const outbox = storeWithRowDueAt(due);
    const later = due + 30_000;

    expect(
      outbox.claimNextPending(LANE, later, PID, LEASE_MS, MAX_AGE_MS, 'gap:0'),
    ).toBeUndefined();
    expect(outbox.nextRetryAt(LANE, later)).toBe(due);
  });

  it('a retryable row with no hold-off time counts as claimable now', () => {
    const outbox = storeWithRowDueAt(undefined);
    expect(outbox.nextRetryAt(LANE, START + 7)).toBe(START + 7);
  });

  it('reports the earliest row, for its own lane only, and nothing once the row is terminal', () => {
    const outbox = storeWithRowDueAt(START + 4_000);
    outbox.insert(pendingRow('gap:1'));
    outbox.claimNextPending(LANE, START, PID, LEASE_MS, MAX_AGE_MS);
    outbox.finalize('gap:1', RETRYABLE, START, START + 2_000);

    expect(outbox.nextRetryAt(LANE, START)).toBe(START + 2_000);
    expect(outbox.nextRetryAt('transactional', START)).toBeUndefined();

    for (const id of ['gap:0', 'gap:1']) {
      outbox.claimNextPending(LANE, START + 5_000, PID, LEASE_MS, MAX_AGE_MS);
      outbox.finalize(
        id,
        { status: 'sent', resendId: `resend-${id}` },
        START + 5_000,
      );
    }
    expect(outbox.nextRetryAt(LANE, START + 5_000)).toBeUndefined();
  });
});
