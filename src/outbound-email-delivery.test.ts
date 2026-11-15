import { beforeEach, describe, expect, it, vi } from 'vitest';

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
      senders: new Set(['person@example.edu', 'colleague@example.edu']),
      source: 'test',
    }),
    loadEmailAllowlistFromAsync: async () => ({
      available: true,
      senders: new Set(['person@example.edu', 'colleague@example.edu']),
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
  cancelQueuedOutboundEmail,
  classifyResendFailure,
  peekOutboundEmailResult,
  _resetOutboundEmailQueueForTests,
  _setProviderTimeoutMsForTests,
  _setStaggerMsForTests,
  sendOutboundEmailResult,
} from './outbound-email.js';
import { logOutboundEmail } from './audit-log.js';
import { MemoryOutboxStore } from './outbound-email-outbox.js';
import { _initTestDatabase } from './db.js';
import { findUnconfirmedSends } from './email-delivery-check.js';

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

describe('classified idempotent outbound email', () => {
  beforeEach(() => {
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(50);
    vi.clearAllMocks();
  });

  it('classifies retryable and permanent Resend failures', () => {
    expect(classifyResendFailure(429)).toEqual({ retryable: true });
    expect(classifyResendFailure(503)).toEqual({ retryable: true });
    expect(classifyResendFailure(403)).toEqual({ retryable: false });
    expect(
      classifyResendFailure(409, 'concurrent_idempotent_requests'),
    ).toEqual({ retryable: true });
    expect(classifyResendFailure(409, 'invalid_idempotent_request')).toEqual({
      retryable: false,
    });
  });

  it('sends a stable idempotency key and byte-identical payload on retry', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-123' }),
    });

    const first = await sendOutboundEmailResult(EMAIL, OPTIONS);
    expect(first).toEqual({ status: 'sent', resendId: 'resend-123' });

    // A call with the same deliveryId must be idempotent: it returns the
    // stored result and does not call Resend a second time.
    const second = await sendOutboundEmailResult(EMAIL, OPTIONS);
    expect(second).toEqual({ status: 'sent', resendId: 'resend-123' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(
      'delivery-123',
    );
  });

  it('records an accepted send for next-morning delivery confirmation', async () => {
    _initTestDatabase();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-track-1' }),
    });

    await sendOutboundEmailResult(EMAIL, OPTIONS);

    const thirteenHoursLater = Date.now() + 13 * 60 * 60 * 1000;
    expect(findUnconfirmedSends(thirteenHoursLater)).toEqual([
      expect.objectContaining({
        resendId: 'resend-track-1',
        recipients: ['person@example.edu'],
        subject: EMAIL.subject,
      }),
    ]);
  });

  it('tracks every accepted CC recipient alongside To', async () => {
    _initTestDatabase();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-track-cc' }),
    });

    await sendOutboundEmailResult(
      { ...EMAIL, cc: 'colleague@example.edu' },
      { ...OPTIONS, deliveryId: 'delivery-cc' },
    );

    const thirteenHoursLater = Date.now() + 13 * 60 * 60 * 1000;
    expect(findUnconfirmedSends(thirteenHoursLater)).toEqual([
      expect.objectContaining({
        resendId: 'resend-track-cc',
        recipients: ['colleague@example.edu', 'person@example.edu'],
      }),
    ]);
  });

  it('treats an HTTP success without a Resend ID as a retryable failure', async () => {
    _initTestDatabase();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const result = await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-no-id',
    });

    expect(result).toEqual(
      expect.objectContaining({ status: 'failed', retryable: true }),
    );
    expect(logOutboundEmail).not.toHaveBeenCalled();
    const thirteenHoursLater = Date.now() + 13 * 60 * 60 * 1000;
    expect(findUnconfirmedSends(thirteenHoursLater)).toEqual([]);
  });

  it('uses the same idempotency key and body for distinct sends', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-123' }),
    });

    await sendOutboundEmailResult(EMAIL, OPTIONS);
    await sendOutboundEmailResult(EMAIL, {
      ...OPTIONS,
      deliveryId: 'delivery-124',
    });

    const first = mockFetch.mock.calls[0][1];
    const second = mockFetch.mock.calls[1][1];
    expect(first.headers['Idempotency-Key']).toBe('delivery-123');
    expect(second.headers['Idempotency-Key']).toBe('delivery-124');

    const firstBody = JSON.parse(first.body);
    const secondBody = JSON.parse(second.body);
    delete firstBody.headers['Message-ID'];
    delete secondBody.headers['Message-ID'];
    expect(secondBody).toEqual(firstBody);
  });

  it('peek reports none, pending and done without enqueueing; cancel stops a retrying send', async () => {
    expect(peekOutboundEmailResult('delivery-123')).toEqual({ state: 'none' });

    mockFetch.mockRejectedValue(new Error('socket closed'));
    await expect(
      sendOutboundEmailResult(EMAIL, OPTIONS),
    ).resolves.toMatchObject({
      status: 'failed',
      retryable: true,
    });
    expect(peekOutboundEmailResult('delivery-123')).toEqual({
      state: 'pending',
    });
    const calls = mockFetch.mock.calls.length;

    expect(cancelQueuedOutboundEmail('delivery-123', 'cancelled: closed')).toBe(
      true,
    );
    expect(peekOutboundEmailResult('delivery-123')).toEqual({
      state: 'done',
      result: {
        status: 'failed',
        reason: 'cancelled: closed',
        retryable: false,
      },
    });
    // A later submission of the same id returns the cancelled result, no send.
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-late' }),
    });
    await expect(
      sendOutboundEmailResult(EMAIL, OPTIONS),
    ).resolves.toMatchObject({
      status: 'failed',
      reason: 'cancelled: closed',
    });
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it('cancels a claim abandoned by an earlier process, not one held by this process', async () => {
    const outbox = new MemoryOutboxStore();
    _resetOutboundEmailQueueForTests(outbox);
    mockFetch.mockRejectedValue(new Error('socket closed'));
    await sendOutboundEmailResult(EMAIL, OPTIONS);
    const row = outbox.get('delivery-123')!;

    outbox.set({ ...row, status: 'claimed', claimPid: process.pid });
    expect(cancelQueuedOutboundEmail('delivery-123', 'mine')).toBe(false);

    outbox.set({ ...row, status: 'claimed', claimPid: process.pid + 100000 });
    expect(cancelQueuedOutboundEmail('delivery-123', 'abandoned')).toBe(true);
    expect(outbox.get('delivery-123')).toMatchObject({
      status: 'failed',
      result: { reason: 'abandoned', retryable: false },
    });
  });

  it('does not cancel a send that already finished', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-123' }),
    });
    await sendOutboundEmailResult(EMAIL, OPTIONS);
    expect(peekOutboundEmailResult('delivery-123')).toEqual({
      state: 'done',
      result: { status: 'sent', resendId: 'resend-123' },
    });
    expect(cancelQueuedOutboundEmail('delivery-123', 'too late')).toBe(false);
    expect(cancelQueuedOutboundEmail('never-seen', 'nothing')).toBe(false);
  });

  it('classifies network failures as retryable', async () => {
    mockFetch.mockRejectedValue(new Error('socket closed'));

    await expect(sendOutboundEmailResult(EMAIL, OPTIONS)).resolves.toEqual({
      status: 'failed',
      reason: 'send-exception: socket closed',
      retryable: true,
    });
  });

  it('defers conversational audit until the accepted state is durable', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'resend-123' }),
    });

    await sendOutboundEmailResult(EMAIL, { ...OPTIONS, deferAudit: true });

    expect(logOutboundEmail).not.toHaveBeenCalled();
  });

  it('uses the Resend error code to classify an idempotency conflict', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () =>
        JSON.stringify({
          name: 'invalid_idempotent_request',
          message: 'payload changed',
        }),
    });

    await expect(sendOutboundEmailResult(EMAIL, OPTIONS)).resolves.toEqual({
      status: 'failed',
      reason: 'resend-api-error: HTTP 409 invalid_idempotent_request',
      retryable: false,
    });
  });
});

// Catches bypassing the body gate at the host send choke point.
it('refuses an invented body address before contacting the provider', async () => {
  mockFetch.mockClear();
  const result = await sendOutboundEmailResult(
    { ...EMAIL, body: 'Contact amorgan@example.edu' },
    { ...OPTIONS, deliveryId: 'body-refusal' },
  );
  expect(result).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('amorgan@example.edu'),
    retryable: false,
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

// Catches dropping host-owned inbound trust between reply preparation and the provider backstop.
it('sends an address supplied by the inbound message through the host backstop', async () => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'trusted-body-send' }),
  });
  const result = await sendOutboundEmailResult(
    { ...EMAIL, body: 'Contact inbound-only@example.org' },
    {
      ...OPTIONS,
      deliveryId: 'trusted-body-send',
      trustedBodyAddresses: ['inbound-only@example.org'],
    },
  );
  expect(result).toEqual({ status: 'sent', resendId: 'trusted-body-send' });
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).text).toBe(
    'Contact inbound-only@example.org',
  );
});
// Catches recipient permissive mode inadvertently admitting unverified body claims.
it('fails closed for body addresses even under permissive recipient fallback', async () => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  mockFetch.mockClear();
  const result = await sendOutboundEmailResult(
    { ...EMAIL, body: 'person@example.edu' },
    {
      ...OPTIONS,
      deliveryId: 'unavailable-body',
      allowlistState: {
        available: false,
        source: 'test',
        senders: new Set<string>(),
      },
      allowlistFallbackMode: 'permissive',
    },
  );
  expect(result).toMatchObject({
    status: 'failed',
    reason:
      'body-refused-by-delivery-gate: unverified-email-address: person@example.edu',
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

// R1-1: catches proposed unauthorized CC recipients laundering invented body contacts.
it('refuses invented CC body contact before dropping CC and sending to the allowed stakeholder', async () => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'must-not-send' }),
  });
  const result = await sendOutboundEmailResult(
    {
      ...EMAIL,
      cc: 'invented@example.org',
      body: 'Contact invented@example.org',
    },
    { ...OPTIONS, deliveryId: 'r1-cc-laundering' },
  );
  expect(result).toMatchObject({
    status: 'failed',
    reason:
      'body-refused-by-delivery-gate: unverified-email-address: invented@example.org',
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

// R1-2: catches quote exemption hiding invented contacts before stripMarkdown makes them ordinary text.
it('refuses invented quoted body contact before the formatter sends it as ordinary text', async () => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'must-not-send-quote' }),
  });
  const result = await sendOutboundEmailResult(
    { ...EMAIL, body: '> Contact invented@example.org' },
    { ...OPTIONS, deliveryId: 'r1-quote-laundering' },
  );
  expect(result).toMatchObject({
    status: 'failed',
    reason:
      'body-refused-by-delivery-gate: unverified-email-address: invented@example.org',
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

// R1-5: catches a scheduled reminder refusing allowlisted contacts before its formatter removes emphasis.
it('sends a Monday reminder with underscore emphasis around an allowlisted contact', async () => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'reminder-format' }),
  });
  const result = await sendOutboundEmailResult(
    { ...EMAIL, body: 'Monday reminder: contact __colleague@example.edu__' },
    { ...OPTIONS, deliveryId: 'r1-emphasized-reminder' },
  );
  expect(result).toEqual({ status: 'sent', resendId: 'reminder-format' });
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).text).toBe(
    'Monday reminder: contact colleague@example.edu',
  );
});

// R2-1: reproduces an invented contact immediately after a Markdown URL reaching the provider.
it('refuses the invented address attached to a Markdown link before sending', async () => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'must-not-send' }),
  });
  const result = await sendOutboundEmailResult(
    { ...EMAIL, body: '[Source](https://example.org)invented@example.org' },
    { ...OPTIONS, deliveryId: 'r2-markdown-adjacent' },
  );
  expect(result).toMatchObject({
    status: 'failed',
    retryable: false,
    reason: expect.stringContaining('invented@example.org'),
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

// R2-5: reproduces a scheduled reminder permanently refusing a quoted, allowlisted contact.
it('sends a reminder quoting an allowlisted address with single quotes', async () => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'quoted-reminder' }),
  });
  const result = await sendOutboundEmailResult(
    { ...EMAIL, body: "Contact 'colleague@example.edu'" },
    { ...OPTIONS, deliveryId: 'r2-quoted-reminder' },
  );
  expect(result).toEqual({ status: 'sent', resendId: 'quoted-reminder' });
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).text).toBe(
    "Contact 'colleague@example.edu'",
  );
});

// R3-1: reproduces underscore normalization sending a different address than the one the allowlist trusts.
it.each(['person_@example.edu', '_person@example.edu'])(
  'refuses the exact unverified outgoing identity %s',
  async (address) => {
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'must-not-send' }),
    });
    const result = await sendOutboundEmailResult(
      { ...EMAIL, body: `Contact ${address}` },
      {
        ...OPTIONS,
        deliveryId: `r3-unknown-${address}`,
        trustedBodyAddresses: [],
      },
    );
    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      reason: `body-refused-by-delivery-gate: unverified-email-address: ${address}`,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  },
);

// R3-1: a genuinely allowlisted underscore address must keep its identity all the way to the provider.
it.each(['person_@example.edu', '_person@example.edu'])(
  'sends an allowlisted outgoing underscore identity %s unchanged',
  async (address) => {
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'underscore-approved' }),
    });
    const result = await sendOutboundEmailResult(
      { ...EMAIL, to: address, body: `Contact ${address}` },
      {
        ...OPTIONS,
        deliveryId: `r3-known-${address}`,
        trustedBodyAddresses: [],
        allowlistState: {
          available: true,
          source: 'test',
          senders: new Set([address]),
        },
      },
    );
    expect(result).toEqual({ status: 'sent', resendId: 'underscore-approved' });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).text).toBe(
      `Contact ${address}`,
    );
  },
);

// R4-1: reproduces the reviewer's tag-wrapped reply reaching the provider under the shorter mailbox's allowlist entry.
it.each([
  "o'person@example.edu",
  'fake/person@example.edu',
  'fake!person@example.edu',
])(
  'refuses the complete mailbox %s at the actual provider send path',
  async (address) => {
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'must-not-send' }),
    });
    const result = await sendOutboundEmailResult(
      { ...EMAIL, body: `<reply>Contact ${address}</reply>` },
      {
        ...OPTIONS,
        deliveryId: `r4-atext-${address}`,
        trustedBodyAddresses: [],
      },
    );
    expect(result).toMatchObject({
      status: 'failed',
      retryable: false,
      reason: expect.stringContaining(address),
    });
    expect(mockFetch).not.toHaveBeenCalled();
  },
);
