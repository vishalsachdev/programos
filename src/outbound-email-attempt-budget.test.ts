/**
 * The outbound email attempt budget.
 *
 * The invariant under test: a delivery is handed to the mail provider at most
 * MAX_OUTBOX_ATTEMPTS times, whatever throws and whenever, and it ends
 * dead-lettered through the usual path (alert and note), or sent.
 *
 * The exhaustive part runs one delivery to its end many times. Each run
 * makes one or two of the queue's own calls fail: every store call the lane
 * makes and the provider call, at every position, before or after the call
 * took effect, as a throw or as the process stopping there, with and without
 * a restart in between. The clock is fake.
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

vi.mock('./delivery-notes.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./delivery-notes.js')>();
  return { ...original, recordDeliveryNote: vi.fn() };
});

vi.mock('./logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return { logger };
});

import Database from 'better-sqlite3';

import { reportDeliveryShortfall } from './delivery-gate.js';
import { recordDeliveryNote } from './delivery-notes.js';
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
import {
  MemoryOutboxStore,
  SqliteOutboxStore,
  type BeginAttemptResult,
  type OutboundEmailOutboxOutcome,
  type OutboxLane,
  type OutboxRow,
  type OutboxStore,
} from './outbound-email-outbox.js';

const EMAIL = {
  to: 'person@example.edu',
  subject: 'Test subject',
  body: 'Test body',
};
const OPTIONS = { sourceGroup: 'webhook-email:test', forceBotReplyTo: true };
const START = Date.parse('2026-01-05T12:00:00.000Z');
const ID = 'budget:0';

type StoreKind = 'memory' | 'sqlite';
function makeInner(kind: StoreKind): OutboxStore {
  return kind === 'memory'
    ? new MemoryOutboxStore()
    : new SqliteOutboxStore({ database: new Database(':memory:') });
}

/** What the provider does when no fault is planned for the call. */
type ProviderMode = 'fails-retryably' | 'throws' | 'accepts';

/**
 * How a planned call fails. `before`/`after`: the call throws, without or
 * with its effect. `crash-before`/`crash-after`: the process stops there;
 * nothing it does afterwards reaches the store or the provider, and a new
 * process starts on the same outbox.
 */
type FaultKind = 'before' | 'after' | 'crash-before' | 'crash-after';
interface Fault {
  /** Position in the run's sequence of lane store calls and provider calls. */
  at: number;
  kind: FaultKind;
  /** A clean restart (stop, start) as soon as the lane is idle after it. */
  restartAfter?: boolean;
}

const READS = new Set(['get', 'nextRetryAt']);

/**
 * One delivery's world: the store behind a wrapper that numbers the lane's
 * calls and makes the planned ones fail, and the provider, numbered in the
 * same sequence.
 */
class Harness implements OutboxStore {
  readonly inner: OutboxStore;
  /** Names of the numbered calls, in order. */
  trace: string[] = [];
  /** Requests that reached the provider. */
  sends = 0;
  /** Attempts the store counted (`beginAttempt` answered `started`). */
  started = 0;
  /** A counted attempt not yet used by a provider call. */
  private ticket = false;
  /** Provider calls made without a counted attempt of their own. */
  uncountedSends = 0;
  restartWanted = false;
  /** The process "stopped": every numbered call fails, numbering pauses. */
  dead = false;
  /** The process stopped right after a write that made the row terminal. */
  crashedAfterTerminalWrite = false;
  /** Set once the row is in the outbox; the lane's work starts there. */
  private queued = false;
  private paused = false;
  private readonly faults: Fault[];

  constructor(
    kind: StoreKind,
    private readonly provider: ProviderMode,
    faults: Fault[],
  ) {
    this.inner = makeInner(kind);
    this.faults = faults;
  }

  private call<T>(name: string, effect: () => T): T {
    if (!this.queued || this.paused) return effect();
    if (this.dead) throw new Error(`process stopped (${name})`);
    const at = this.trace.push(name) - 1;
    const fault = this.faults.find((f) => f.at === at);
    if (!fault) return effect();
    if (fault.restartAfter) this.restartWanted = true;
    const crash = fault.kind.startsWith('crash');
    if (crash) {
      this.dead = true;
      this.restartWanted = true;
    }
    if (fault.kind === 'after' || fault.kind === 'crash-after') {
      effect();
      if (crash) {
        const row = this.inner.get(ID);
        if (row?.status === 'sent' || row?.status === 'dead-letter') {
          this.crashedAfterTerminalWrite = true;
        }
      }
    }
    throw new Error(`injected ${fault.kind} at ${at} (${name})`);
  }

  /** The provider call, as `fetch`. */
  fetch = (): Promise<unknown> => {
    if (this.dead) throw new Error('process stopped (provider)');
    const at = this.trace.push('provider') - 1;
    const fault = this.faults.find((f) => f.at === at);
    if (fault?.restartAfter) this.restartWanted = true;
    if (fault?.kind.startsWith('crash')) {
      this.dead = true;
      this.restartWanted = true;
    }
    // `before`: the request never left this host. Everything else reached
    // the provider.
    if (fault?.kind === 'before' || fault?.kind === 'crash-before') {
      throw new Error(`injected ${fault.kind} at ${at} (provider)`);
    }
    this.sends++;
    if (this.ticket) this.ticket = false;
    else this.uncountedSends++;
    if (fault) throw new Error(`injected ${fault.kind} at ${at} (provider)`);
    if (this.provider === 'throws') throw new Error('bad payload');
    if (this.provider === 'accepts') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ id: 'resend-ok' }),
      });
    }
    return Promise.resolve({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
  };

  // Numbered: every store call the lane makes for a row.
  get(deliveryId: string): OutboxRow | undefined {
    return this.call('get', () => this.inner.get(deliveryId));
  }
  set(row: OutboxRow): void {
    return this.call('set', () => this.inner.set(row));
  }
  beginAttempt(
    deliveryId: string,
    now: number,
    processId: number,
    leaseMs: number,
    maxAttempts: number,
  ): BeginAttemptResult {
    return this.call('beginAttempt', () => {
      const result = this.inner.beginAttempt(
        deliveryId,
        now,
        processId,
        leaseMs,
        maxAttempts,
      );
      if (result.outcome === 'started') {
        this.started++;
        this.ticket = true;
      }
      return result;
    });
  }
  finalize(
    deliveryId: string,
    result: OutboundEmailOutboxOutcome,
    now: number,
    nextAttemptAt?: number,
  ): OutboxRow | undefined {
    return this.call('finalize', () =>
      this.inner.finalize(deliveryId, result, now, nextAttemptAt),
    );
  }
  claimNextPending(
    lane: OutboxLane,
    now: number,
    processId: number,
    leaseMs: number,
    maxAgeMs: number,
    excludeDeliveryId?: string,
  ): OutboxRow | undefined {
    // Only the row's own lane is numbered; the other lanes are empty.
    if (lane !== 'transactional') return undefined;
    return this.call('claimNextPending', () =>
      this.inner.claimNextPending(
        lane,
        now,
        processId,
        leaseMs,
        maxAgeMs,
        excludeDeliveryId,
      ),
    );
  }
  nextRetryAt(lane: OutboxLane, now: number): number | undefined {
    if (lane !== 'transactional') return undefined;
    return this.call('nextRetryAt', () => this.inner.nextRetryAt(lane, now));
  }

  // Not numbered: submission and process start, which are not the lane.
  insert(row: OutboxRow): void {
    this.inner.insert(row);
    this.queued = true;
  }
  delete(deliveryId: string): void {
    this.inner.delete(deliveryId);
  }
  listPending(lane?: OutboxLane, maxAgeMs?: number): OutboxRow[] {
    return this.inner.listPending(lane, maxAgeMs);
  }
  getPendingCount(lane: OutboxLane, maxAgeMs: number): number {
    return this.inner.getPendingCount(lane, maxAgeMs);
  }
  listAll(): OutboxRow[] {
    return this.inner.listAll();
  }
  clear(): void {
    this.inner.clear();
  }
  resetInFlightClaims(processId?: number): number {
    return this.inner.resetInFlightClaims(processId);
  }
  compact(retentionMs: number, now: number): number {
    return this.inner.compact(retentionMs, now);
  }
  acquireProcessLock(): void {}
  releaseProcessLock(): void {}

  /** Stop numbering while the test itself reads or submits. */
  unnumbered<T>(fn: () => T): T {
    this.paused = true;
    try {
      return fn();
    } finally {
      this.paused = false;
    }
  }
}

/**
 * Let the queue run until nothing is in flight and no timer is pending,
 * restarting the process when a fault asked for it. Fails if it does not
 * come to rest (a lane that spins).
 */
async function settle(h: Harness): Promise<void> {
  for (let step = 0; step < 400; step++) {
    await vi.advanceTimersByTimeAsync(0);
    if (h.restartWanted) {
      restart(h);
      continue;
    }
    if (vi.getTimerCount() === 0) return;
    await vi.advanceTimersToNextTimerAsync();
  }
  throw new Error(`the queue did not come to rest: ${h.trace.join(' ')}`);
}

/**
 * A new process on the same outbox: no timers, no lane state. A process
 * whose start fails (the store fails during startup replay) is started
 * again, as a supervisor would.
 */
function restart(h: Harness): void {
  h.restartWanted = false;
  h.dead = false;
  for (let tries = 0; ; tries++) {
    _resetOutboundQueueTailForTests();
    try {
      startOutboundEmailQueue();
      return;
    } catch (err) {
      if (tries > 50) throw err;
      h.dead = false;
    }
  }
}

function submit(h: Harness): void {
  // The submission's own store calls are not the lane's; a failure there
  // reaches the caller before anything is queued.
  h.unnumbered(() => {
    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID }).catch(
      () => {},
    );
  });
}

interface Outcome {
  h: Harness;
  row: OutboxRow;
}

/**
 * One delivery, start to finish: submitted, left to the queue, submitted
 * again by its caller (a caller that got a retryable failure does that),
 * then a process restart and one more submission. A row that a failing
 * store left claimed is taken up again by a new submission or a restart.
 */
async function runDelivery(
  kind: StoreKind,
  provider: ProviderMode,
  faults: Fault[],
): Promise<Outcome> {
  vi.setSystemTime(START);
  const h = new Harness(kind, provider, faults);
  _resetOutboundEmailQueueForTests(h);
  _setStaggerMsForTests(0);
  _setProviderTimeoutMsForTests(50);
  vi.mocked(reportDeliveryShortfall).mockClear();
  vi.mocked(recordDeliveryNote).mockClear();
  mockFetch.mockImplementation(h.fetch);

  submit(h);
  await settle(h);
  expect(h.sends).toBeLessThanOrEqual(MAX_OUTBOX_ATTEMPTS);
  submit(h);
  await settle(h);
  expect(h.sends).toBeLessThanOrEqual(MAX_OUTBOX_ATTEMPTS);
  restart(h);
  await settle(h);
  submit(h);
  await settle(h);

  return { h, row: h.inner.get(ID)! };
}

function describeFaults(faults: Fault[], h: Harness): string {
  return (
    faults
      .map(
        (f) =>
          `${f.kind}@${f.at}(${h.trace[f.at] ?? '-'})${f.restartAfter ? '+restart' : ''}`,
      )
      .join(', ') || 'no fault'
  );
}

/** The invariant, checked on one finished run. */
function check(outcome: Outcome, faults: Fault[]): void {
  const { h, row } = outcome;
  const label = describeFaults(faults, h);
  // 1. The budget.
  expect(h.sends, `sends: ${label}`).toBeLessThanOrEqual(MAX_OUTBOX_ATTEMPTS);
  // 2. Why it holds: no provider call without its own counted attempt.
  expect(h.uncountedSends, `uncounted sends: ${label}`).toBe(0);
  expect(h.started, `counted: ${label}`).toBeLessThanOrEqual(
    MAX_OUTBOX_ATTEMPTS,
  );
  expect(row.attempts ?? 0, `stored count: ${label}`).toBeGreaterThanOrEqual(
    h.sends,
  );
  // 3. The row is finished: sent, or dead-lettered.
  expect(['sent', 'dead-letter'], `end state: ${label}`).toContain(row.status);
  // 4. A dead letter was announced: operator alert and note. They carry the
  //    row's reason, or that reason marked "not recorded" when the store was
  //    failing at the time of the announcement. The one exception is a
  //    process that stopped between writing the dead letter and announcing
  //    it (a gap this suite records, not one it closes).
  if (row.status === 'dead-letter' && !h.crashedAfterTerminalWrite) {
    const reason = (row.result as { reason: string }).reason;
    const announced = (calls: unknown[][]): boolean =>
      calls.some(([arg]) => {
        const said = (arg as { reason: string }).reason;
        return (
          said === reason || said === `${reason}; dead letter not recorded`
        );
      });
    expect(
      announced(vi.mocked(reportDeliveryShortfall).mock.calls),
      `alert: ${label}`,
    ).toBe(true);
    expect(
      announced(vi.mocked(recordDeliveryNote).mock.calls),
      `note: ${label}`,
    ).toBe(true);
  }
}

function kindsFor(name: string): FaultKind[] {
  if (READS.has(name)) return ['before', 'crash-before'];
  return ['before', 'after', 'crash-before', 'crash-after'];
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  vi.clearAllMocks();
});

afterEach(() => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  vi.useRealTimers();
});

const STORES: StoreKind[] = ['memory', 'sqlite'];
const PROVIDERS: ProviderMode[] = ['fails-retryably', 'throws', 'accepts'];

describe.each(STORES)('attempt budget, %s store', (kind) => {
  describe.each(PROVIDERS)('provider %s', (provider) => {
    it('with no fault: the expected sends, and every one is counted first', async () => {
      const outcome = await runDelivery(kind, provider, []);
      check(outcome, []);
      const { h, row } = outcome;
      if (provider === 'accepts') {
        expect(h.sends).toBe(1);
        expect(row).toMatchObject({ status: 'sent', attempts: 1 });
      } else {
        expect(h.sends).toBe(MAX_OUTBOX_ATTEMPTS);
        expect(row).toMatchObject({
          status: 'dead-letter',
          attempts: MAX_OUTBOX_ATTEMPTS,
        });
      }
      // In the trace, each provider call follows a beginAttempt directly.
      h.trace.forEach((name, i) => {
        if (name === 'provider') expect(h.trace[i - 1]).toBe('beginAttempt');
      });
    });

    it('one failure at each call, at each attempt position, thrown or as a process stop, with and without a restart after it', async () => {
      const baseline = await runDelivery(kind, provider, []);
      const length = baseline.h.trace.length;
      let runs = 0;
      // A few positions past the end too: a fault can lengthen the run.
      for (let at = 0; at < length + 6; at++) {
        const name = baseline.h.trace[at] ?? 'finalize';
        for (const faultKind of kindsFor(name)) {
          for (const restartAfter of [false, true]) {
            if (restartAfter && faultKind.startsWith('crash')) continue;
            const faults: Fault[] = [{ at, kind: faultKind, restartAfter }];
            check(await runDelivery(kind, provider, faults), faults);
            runs++;
          }
        }
      }
      expect(runs).toBeGreaterThan(length);
    });

    it(
      'two failures in sequence, at every pair of calls up to two attempts apart, with and without a restart between them',
      { timeout: 60_000 },
      async () => {
        const baseline = await runDelivery(kind, provider, []);
        const length = baseline.h.trace.length;
        // One attempt is 9 numbered calls (see the baseline trace). The
        // SQLite store costs ten times the memory store per run, and the queue
        // logic above it is the same, so there the pairs are one attempt
        // apart, the first failure is a throw (a process stop at each call is
        // in the test above), and the restart alternates.
        const full = kind === 'memory';
        const window = full ? 18 : 9;
        let runs = 0;
        for (let first = 0; first < length; first++) {
          const firstName = baseline.h.trace[first];
          const firstKinds = kindsFor(firstName).filter(
            (k) => full || !k.startsWith('crash'),
          );
          for (const firstKind of firstKinds) {
            for (
              let second = first + 1;
              second <= Math.min(first + window, length + 6);
              second++
            ) {
              for (const secondKind of ['before', 'after'] as FaultKind[]) {
                const restarts = full
                  ? [false, true]
                  : [(first + second) % 2 === 0];
                for (const restartAfter of restarts) {
                  if (restartAfter && firstKind.startsWith('crash')) continue;
                  const faults: Fault[] = [
                    { at: first, kind: firstKind, restartAfter },
                    { at: second, kind: secondKind },
                  ];
                  check(await runDelivery(kind, provider, faults), faults);
                  runs++;
                }
              }
            }
          }
        }
        expect(runs).toBeGreaterThan(length * window);
      },
    );
  });

  it('a store that fails on every call for a while, starting at any call, and then recovers', async () => {
    const baseline = await runDelivery(kind, 'throws', []);
    for (let from = 0; from < baseline.h.trace.length; from++) {
      for (const span of [3, 9, 27]) {
        const faults: Fault[] = Array.from({ length: span }, (_, i) => ({
          at: from + i,
          kind: 'before' as FaultKind,
        }));
        check(await runDelivery(kind, 'throws', faults), faults);
      }
    }
  });

  it('the process stops during every send: the budgeted number of sends, then the dead letter with no further send', async () => {
    // Each provider call is the last thing its process does.
    const baseline = await runDelivery(kind, 'fails-retryably', []);
    const faults: Fault[] = [];
    const outcome = await (async () => {
      // Plan a stop at every provider call of the faulted run. The positions
      // shift as stops are added, so add them one at a time.
      let current = baseline;
      for (let n = 0; n < MAX_OUTBOX_ATTEMPTS + 2; n++) {
        const next = current.h.trace.findIndex(
          (name, i) => name === 'provider' && !faults.some((f) => f.at === i),
        );
        if (next < 0) break;
        faults.push({ at: next, kind: 'crash-after' });
        current = await runDelivery(kind, 'fails-retryably', faults);
      }
      return current;
    })();
    check(outcome, faults);
    expect(outcome.h.sends).toBe(MAX_OUTBOX_ATTEMPTS);
    expect(outcome.row).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
    expect((outcome.row.result as { reason: string }).reason).toBe(
      'outbox-max-attempts-exceeded: no attempt left',
    );
  });
});

describe('the attempt is counted before the send', () => {
  let store: MemoryOutboxStore;

  beforeEach(() => {
    store = new MemoryOutboxStore();
    _resetOutboundEmailQueueForTests(store);
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(50);
  });

  function sendAlwaysThrows(): void {
    mockFetch.mockImplementation(() => {
      throw new Error('bad payload');
    });
  }

  /** Through every backoff, and a while longer; well inside the queue age. */
  async function runToEnd(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
    for (let n = 1; n <= MAX_OUTBOX_ATTEMPTS; n++) {
      await vi.advanceTimersByTimeAsync(retryBackoffMs(n));
    }
    await vi.advanceTimersByTimeAsync(30_000);
  }

  it('the stored count already includes the attempt while the provider call is in progress', async () => {
    const seen: number[] = [];
    mockFetch.mockImplementation(() => {
      seen.push(store.get(ID)!.attempts ?? 0);
      return Promise.resolve({ ok: false, status: 500, text: async () => '' });
    });
    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID });
    await runToEnd();
    expect(seen).toEqual(
      Array.from({ length: MAX_OUTBOX_ATTEMPTS }, (_, i) => i + 1),
    );
  });

  it('when the count cannot be written, nothing is sent in that pass, and the delivery goes out once the store is back', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-ok' }),
    });
    const realBegin = store.beginAttempt.bind(store);
    let failing = true;
    vi.spyOn(store, 'beginAttempt').mockImplementation((...a) => {
      if (failing) throw new Error('database is locked');
      return realBegin(...a);
    });
    const first = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: ID,
    });
    expect(first).toMatchObject({ status: 'failed', retryable: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(store.get(ID)!.status).toBe('failed');
    expect(store.get(ID)!.attempts ?? 0).toBe(0);

    failing = false;
    await vi.advanceTimersByTimeAsync(retryBackoffMs(1));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(store.get(ID)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('PR 52 review finding: a store read that fails in the error handler on the last attempt leaves no sixth send', async () => {
    sendAlwaysThrows();
    const realGet = store.get.bind(store);
    let armed = false;
    let failed = 0;
    vi.spyOn(store, 'get').mockImplementation((id: string) => {
      if (armed) {
        armed = false;
        failed++;
        throw new Error('database is locked');
      }
      return realGet(id);
    });
    mockFetch.mockImplementation(() => {
      if (realGet(ID)?.attempts === MAX_OUTBOX_ATTEMPTS) armed = true;
      throw new Error('bad payload');
    });
    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID });
    await runToEnd();
    expect(failed).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(MAX_OUTBOX_ATTEMPTS);
    expect(realGet(ID)).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
  });

  it('PR 63 review finding: an outcome the store could not record, then a new submission whose outcome it does record, leaves no sixth send', async () => {
    // First pass: the send throws and the write of its outcome fails, so the
    // row stays claimed. The caller submits the delivery again; from then on
    // the store works. Before, the first attempt was held in memory and
    // dropped at the next successful write: six sends, five on record.
    sendAlwaysThrows();
    const realFinalize = store.finalize.bind(store);
    let failures = 1;
    vi.spyOn(store, 'finalize').mockImplementation((...a) => {
      if (failures-- > 0) throw new Error('database is locked');
      return realFinalize(...a);
    });
    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(store.get(ID)).toMatchObject({ status: 'claimed', attempts: 1 });

    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID });
    await runToEnd();
    expect(mockFetch).toHaveBeenCalledTimes(MAX_OUTBOX_ATTEMPTS);
    expect(store.get(ID)).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
    expect(reportDeliveryShortfall).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('outbox-max-attempts-exceeded'),
      }),
    );
  });

  it('the same, across a restart: the count is in the store, not in the process', async () => {
    sendAlwaysThrows();
    const realFinalize = store.finalize.bind(store);
    let failing = true;
    vi.spyOn(store, 'finalize').mockImplementation((...a) => {
      if (failing) throw new Error('database is locked');
      return realFinalize(...a);
    });
    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID });
    await vi.advanceTimersByTimeAsync(0);
    // Two sends whose outcomes were never recorded.
    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID });
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(store.get(ID)).toMatchObject({ status: 'claimed', attempts: 2 });

    // The host restarts while the store is still failing, then it recovers.
    _resetOutboundQueueTailForTests();
    startOutboundEmailQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    failing = false;
    _resetOutboundQueueTailForTests();
    startOutboundEmailQueue();
    await runToEnd();
    expect(mockFetch).toHaveBeenCalledTimes(MAX_OUTBOX_ATTEMPTS);
    expect(store.get(ID)).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
  });

  it('when the last dead letter cannot be written: an alert, no further send, and the dead letter is written at the next start', async () => {
    sendAlwaysThrows();
    const realFinalize = store.finalize.bind(store);
    let failing = false;
    vi.spyOn(store, 'finalize').mockImplementation((...a) => {
      if (failing) throw new Error('database is locked');
      return realFinalize(...a);
    });
    mockFetch.mockImplementation(() => {
      if (store.get(ID)?.attempts === MAX_OUTBOX_ATTEMPTS) failing = true;
      throw new Error('bad payload');
    });
    void sendOutboundEmailResult(EMAIL, { ...OPTIONS, deliveryId: ID });
    await runToEnd();
    expect(mockFetch).toHaveBeenCalledTimes(MAX_OUTBOX_ATTEMPTS);
    expect(store.get(ID)).toMatchObject({
      status: 'claimed',
      attempts: MAX_OUTBOX_ATTEMPTS,
    });
    expect(reportDeliveryShortfall).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('dead letter not recorded'),
      }),
    );

    failing = false;
    _resetOutboundQueueTailForTests();
    startOutboundEmailQueue();
    await runToEnd();
    expect(mockFetch).toHaveBeenCalledTimes(MAX_OUTBOX_ATTEMPTS);
    expect(store.get(ID)).toMatchObject({
      status: 'dead-letter',
      attempts: MAX_OUTBOX_ATTEMPTS,
      result: { reason: 'outbox-max-attempts-exceeded: no attempt left' },
    });
    expect(recordDeliveryNote).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: ID,
        reason: 'outbox-max-attempts-exceeded: no attempt left',
      }),
    );
  });
});

describe.each(STORES)('beginAttempt (%s store)', (kind) => {
  const PID = 4242;
  const LEASE_MS = 60_000;
  const RETRYABLE = {
    status: 'failed' as const,
    reason: 'resend-api-error: HTTP 500',
    retryable: true,
  };

  function storeWithRow(): OutboxStore {
    const outbox = makeInner(kind);
    const at = new Date(START).toISOString();
    outbox.insert({
      deliveryId: ID,
      lane: 'bulk',
      status: 'pending',
      email: { ...EMAIL },
      sendOptions: { ...OPTIONS },
      intended: [EMAIL.to],
      createdAt: at,
      updatedAt: at,
    });
    return outbox;
  }

  it('counts and claims in one step, up to the budget and never past it', () => {
    const outbox = storeWithRow();
    for (let n = 1; n <= 3; n++) {
      const begin = outbox.beginAttempt(ID, START, PID, LEASE_MS, 3);
      expect(begin.outcome).toBe('started');
      expect(begin.row).toMatchObject({ status: 'claimed', attempts: n });
      expect(outbox.get(ID)).toMatchObject({
        status: 'claimed',
        attempts: n,
        claimPid: PID,
      });
      // Finalize records the outcome and leaves the count alone.
      expect(
        outbox.finalize(ID, RETRYABLE, START, START + 1_000),
      ).toMatchObject({ status: 'failed', attempts: n });
    }
    const spent = outbox.beginAttempt(ID, START, PID, LEASE_MS, 3);
    expect(spent.outcome).toBe('spent');
    // Claimed, so the caller can dead-letter it; the count did not move.
    expect(outbox.get(ID)).toMatchObject({ status: 'claimed', attempts: 3 });
    expect(outbox.beginAttempt(ID, START, PID, LEASE_MS, 3).outcome).toBe(
      'spent',
    );
    expect(outbox.get(ID)!.attempts).toBe(3);
  });

  it('counts a row that is already claimed, and one returned to pending by a restart', () => {
    const outbox = storeWithRow();
    expect(
      outbox.claimNextPending('bulk', START, PID, LEASE_MS, 3_600_000),
    ).toMatchObject({ deliveryId: ID, status: 'claimed' });
    expect(outbox.beginAttempt(ID, START, PID, LEASE_MS, 5).row).toMatchObject({
      attempts: 1,
    });
    // The process stops mid-send; the next one resets the claim.
    expect(outbox.resetInFlightClaims()).toBe(1);
    expect(outbox.get(ID)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(outbox.beginAttempt(ID, START, PID, LEASE_MS, 5).row).toMatchObject({
      attempts: 2,
    });
  });

  it('does not touch a finished or a missing row', () => {
    const outbox = storeWithRow();
    outbox.beginAttempt(ID, START, PID, LEASE_MS, 5);
    outbox.finalize(ID, { status: 'sent', resendId: 'r1' }, START);
    const done = outbox.beginAttempt(ID, START, PID, LEASE_MS, 5);
    expect(done.outcome).toBe('not-sendable');
    expect(done.row).toMatchObject({ status: 'sent', attempts: 1 });
    expect(outbox.get(ID)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(outbox.beginAttempt('absent', START, PID, LEASE_MS, 5)).toEqual({
      outcome: 'not-sendable',
      row: undefined,
    });
  });
});
