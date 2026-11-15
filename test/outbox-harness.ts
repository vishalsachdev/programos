/**
 * Fresh-process harness for the durable outbound-email outbox (issue #37).
 *
 * Round 3 review (REVIEW-round3-pr47.md) rejected in-process restart
 * simulations: the only honest proof of restart/lock/alert durability is a
 * real OS process, a real SQLite file, and a real signal. This harness is the
 * child process those tests spawn. It is deliberately NOT under src/ — it is
 * test scaffolding, never shipped in dist/.
 *
 * Contract with the test: every machine-readable line is prefixed `HARNESS:`
 * followed by JSON. Provider calls are appended (one JSON object per line) to
 * $HARNESS_LOG so call counts survive the process that made them.
 *
 * Usage: node --import tsx test/outbox-harness.ts <mode>
 * cwd MUST be a scratch directory: config.ts derives STORE_DIR from cwd.
 */
import fs from 'fs';

const mode = process.argv[2];
const providerLog = process.env.HARNESS_LOG ?? 'provider-calls.jsonl';
const fetchMode = process.env.HARNESS_FETCH ?? 'ok';

function emit(event: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(`HARNESS:${JSON.stringify({ event, ...data })}\n`);
}

let providerCalls = 0;
globalThis.fetch = (async (
  _url: unknown,
  init: { headers: Record<string, string> },
) => {
  providerCalls++;
  const key = init?.headers?.['Idempotency-Key'];
  fs.appendFileSync(
    providerLog,
    `${JSON.stringify({ pid: process.pid, key, at: Date.now() })}\n`,
  );
  if (fetchMode === 'fail500') {
    return { ok: false, status: 500, text: async () => 'boom' };
  }
  if (fetchMode === 'fail500-first' && key?.endsWith(':0')) {
    return { ok: false, status: 500, text: async () => 'boom' };
  }
  return { ok: true, status: 200, json: async () => ({ id: `resend-${key}` }) };
}) as unknown as typeof fetch;

const {
  initDatabase,
  getPendingDeliveryShortfalls,
  storePendingDeliveryShortfall,
} = await import('../src/db.js');
const {
  sendOutboundEmailResult,
  shutdownOutboundEmailQueue,
  startOutboundEmailQueue,
  _setStaggerMsForTests,
  _setProviderTimeoutMsForTests,
} = await import('../src/outbound-email.js');
const { getOutboxStore } = await import('../src/outbound-email-outbox.js');
const { setDeliveryShortfallAlerter } = await import('../src/delivery-gate.js');

const EMAIL = {
  to: 'person@example.edu',
  subject: 'Harness subject',
  body: 'Harness body.',
};

const ALLOWLIST_STATE = {
  available: true,
  senders: new Set(['person@example.edu']),
  source: 'harness',
};

function sendOptions(batchId: string, position: number) {
  return {
    sourceGroup: 'harness',
    forceBotReplyTo: true,
    deferAudit: true,
    lane: 'bulk' as const,
    batchId,
    position,
    deliveryId: `${batchId}:${position}`,
    allowlistState: ALLOWLIST_STATE,
  };
}

function dumpRows(): void {
  const rows = getOutboxStore()
    .listAll()
    .map((r) => ({
      deliveryId: r.deliveryId,
      status: r.status,
      retryable: r.result?.status === 'failed' ? r.result.retryable : undefined,
      reason: r.result?.status === 'failed' ? r.result.reason : undefined,
      claimPid: r.claimPid,
      attempts: r.attempts,
    }))
    .sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
  emit('rows', { rows, providerCalls });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait for a moment when no row is claimed, so a dump taken after a drain
 * timeout reflects idle state rather than an instant mid-attempt. A row that
 * stays claimed forever (the round-3 stall) simply exhausts this wait and shows
 * up as claimed in the dump.
 */
async function waitForNoClaims(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      !getOutboxStore()
        .listAll()
        .some((r) => r.status === 'claimed')
    )
      return;
    await sleep(25);
  }
}

async function waitForDrain(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outbox = getOutboxStore();
    const pending = [
      ...outbox.listPending('bulk'),
      ...outbox.listPending('transactional'),
    ];
    const claimed = outbox.listAll().filter((r) => r.status === 'claimed');
    if (pending.length === 0 && claimed.length === 0) return;
    await sleep(50);
  }
}

const staggerMs = Number(process.env.HARNESS_STAGGER_MS ?? '2000');
const providerTimeoutMs = Number(
  process.env.HARNESS_PROVIDER_TIMEOUT_MS ?? '2000',
);
const batchId = process.env.HARNESS_BATCH ?? 'harness-batch';
const count = Number(process.env.HARNESS_COUNT ?? '2');

switch (mode) {
  case 'init-only': {
    initDatabase();
    emit('initialized');
    process.exit(0);
    break;
  }

  case 'seed-hold': {
    // Enqueue `count` rows, send the first, then sit in the stagger gap until
    // SIGTERM triggers the graceful shutdown path.
    initDatabase();
    _setStaggerMsForTests(staggerMs);
    _setProviderTimeoutMsForTests(providerTimeoutMs);

    process.on('SIGTERM', () => {
      void (async () => {
        await shutdownOutboundEmailQueue(300);
        dumpRows();
        emit('shutdown-complete');
        process.exit(0);
      })();
    });

    for (let i = 0; i < count; i++) {
      void sendOutboundEmailResult(EMAIL, sendOptions(batchId, i)).then(
        (result) => emit('send-result', { position: i, result }),
        (err) => emit('send-error', { position: i, err: String(err) }),
      );
    }
    emit('seeded');
    await sleep(60_000);
    emit('timeout');
    process.exit(3);
    break;
  }

  case 'replay': {
    initDatabase();
    _setStaggerMsForTests(staggerMs);
    _setProviderTimeoutMsForTests(providerTimeoutMs);
    startOutboundEmailQueue();
    emit('started');
    await waitForDrain(Number(process.env.HARNESS_DRAIN_MS ?? '8000'));
    await waitForNoClaims(3_000);
    dumpRows();
    emit('done');
    process.exit(0);
    break;
  }

  case 'lock-hold': {
    initDatabase();
    _setStaggerMsForTests(staggerMs);
    startOutboundEmailQueue();
    emit('locked');
    await sleep(60_000);
    process.exit(3);
    break;
  }

  case 'lock-try': {
    initDatabase();
    try {
      startOutboundEmailQueue();
      emit('lock-acquired');
      process.exit(0);
    } catch (err) {
      emit('lock-refused', { message: String(err) });
      process.exit(4);
    }
    break;
  }

  case 'alert-hang': {
    // Persist a shortfall, then register an alerter that never resolves and
    // exit: the alert must survive to the next process.
    initDatabase();
    storePendingDeliveryShortfall({
      channel: 'email',
      context: 'harness: hung alert',
      intended: ['person@example.edu'],
      sent: [],
      missed: ['person@example.edu'],
      reason: 'harness-shortfall',
    });
    emit('persisted', { count: getPendingDeliveryShortfalls().length });
    setDeliveryShortfallAlerter(
      () =>
        new Promise<void>(() => {
          /* never resolves — process dies mid-flight */
        }),
    );
    await sleep(150);
    emit('count-during-flight', {
      count: getPendingDeliveryShortfalls().length,
    });
    process.exit(0);
    break;
  }

  case 'alert-count': {
    initDatabase();
    emit('count', { count: getPendingDeliveryShortfalls().length });
    process.exit(0);
    break;
  }

  default:
    emit('unknown-mode', { mode });
    process.exit(2);
}
