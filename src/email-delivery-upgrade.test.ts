import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  processDelivery,
  type DeliveryProcessorDeps,
} from './delivery-processor.js';
import type { DeliveryState } from './delivery-state.js';
import type { PreparedDelivery } from './types.js';
import { resolveEmailGateContext } from './email-gate-context.js';
import { getChannelFactory } from './channels/registry.js';
import { logger } from './logger.js';
import { MemoryOutboxStore } from './outbound-email-outbox.js';
import {
  _resetOutboundEmailQueueForTests,
  _setStaggerMsForTests,
  sendOutboundEmailResult,
} from './outbound-email.js';
import './channels/webhook.js';

vi.mock('./env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
    SEND_FROM_EMAIL: 'program@example.org',
  }),
}));
vi.mock('./program-repo.js', () => ({
  CHECKOUT_OWNER: { uid: 1000, gid: 1000 },
  checkoutGitOptions: () => ({}),
  getProgramRepoPath: () => '/tmp/missing-upgrade-repo',
}));
vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: vi.fn(),
    readFile: () => '| Person | person@example.edu |',
    readFileAsync: async () => '| Person | person@example.edu |',
  }),
}));
vi.mock('./audit-log.js', () => ({ logOutboundEmail: vi.fn() }));
vi.mock('./delivery-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery-gate.js')>()),
  reportDeliveryShortfall: vi.fn(),
}));

const fetchMock = vi.fn();
const warn = vi.spyOn(logger, 'warn');
let outbox: MemoryOutboxStore;
const jid = 'webhook-email:upgrade';
const originalContext = {
  type: 'webhook-email-v1',
  from: 'person@example.edu',
  subject: 'Contact',
  messageId: '',
  kbConflictSnapshot: { files: {} },
  allowlistSnapshot: {
    available: true,
    source: 'admitted',
    senders: ['person@example.edu'],
  },
  // Pre-upgrade evidence is not versioned; it cannot safely be reconstructed from a mutable file.
  bodyAddresses: ['true-inbound@example.org'],
};

beforeEach(() => {
  outbox = new MemoryOutboxStore();
  _resetOutboundEmailQueueForTests(outbox);
  _setStaggerMsForTests(0);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'accepted-after-upgrade' }),
  });
  warn.mockClear();
});

function channelFor(context: unknown = originalContext) {
  const channel = getChannelFactory('webhook')?.({
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('missing webhook');
  expect(channel.restoreDeliveryContext?.(jid, context)).toBe(true);
  return channel;
}

// R2-3: replays the actual coordinator and provider after a pre-upgrade temporary failure or saved repair.
describe('saved email recovery across body-gate upgrade', () => {
  it.each(['transport-pending', 'repair-required'] as const)(
    'delivers a legacy %s item without permanently losing its inbound contact',
    async (phase) => {
      await replay(phase, false);
    },
  );

  // Lead B: an explicitly empty evidence list is current policy, not an upgrade exemption.
  it.each(['transport-pending', 'repair-required'] as const)(
    'still checks a %s item whose evidence field is present but empty',
    async (phase) => {
      await replay(phase, true);
    },
  );
});

async function replay(
  phase: 'transport-pending' | 'repair-required',
  hasEvidenceField: boolean,
) {
  const channel = channelFor();
  const now = new Date().toISOString();
  const deliveryId = 'saved-before-upgrade';
  const body = 'Confirmed true-inbound@example.org';
  const email = { to: originalContext.from, subject: 'Re: Contact', body };
  const options = {
    sourceGroup: jid,
    forceBotReplyTo: true,
    deferAudit: true,
    allowlistState: originalContext.allowlistSnapshot,
    ...(hasEvidenceField ? { trustedBodyAddresses: [] } : {}),
  };
  const prepared: PreparedDelivery = {
    channel: 'webhook',
    deliveryId,
    jid,
    payload: { email, options },
  };
  const base = {
    version: 1 as const,
    chatJid: jid,
    targetTimestamp: now,
    previousCursor: '',
    context: { channelData: originalContext, sender: originalContext.from },
    outcomeId: 'saved-repair-before-upgrade',
    attempt: 2,
    createdAt: now,
    ...(hasEvidenceField ? { trustedBodyAddresses: [] } : {}),
  };
  let stored: DeliveryState | undefined =
    phase === 'transport-pending'
      ? { ...base, phase, prepared, replyText: body }
      : {
          ...base,
          phase,
          gateReason: 'missing-reply-block',
          rejectedOutput: body,
        };
  if (phase === 'transport-pending') {
    // This durable row survived a temporary provider failure and process restart.
    outbox.insert({
      deliveryId,
      lane: 'transactional',
      status: 'failed',
      attempts: 1,
      result: {
        status: 'failed',
        retryable: true,
        reason: 'resend-api-error: HTTP 503',
      },
      email,
      sendOptions: options,
      intended: [email.to],
      createdAt: now,
      updatedAt: now,
    });
  }
  const gateContext = await resolveEmailGateContext(
    [],
    originalContext,
    stored,
  );
  const deps: DeliveryProcessorDeps = {
    loadState: () =>
      stored ? { status: 'valid', state: stored } : { status: 'none' },
    saveState: (state) => {
      stored = structuredClone(state);
      return { status: 'saved' };
    },
    clearState: vi.fn(() => {
      stored = undefined;
    }),
    runBusinessAgent: vi.fn(async () => ({
      status: 'success' as const,
      raw: '<reply>must not rerun business work</reply>',
    })),
    runRepairAgent: vi.fn(async () => ({
      status: 'success' as const,
      raw: `<reply>${body}</reply>`,
    })),
    validateOutput: (raw) => channel.gateProfile.validate(raw, gateContext),
    prepareDelivery: (text, id, context) => {
      channel.restoreDeliveryContext?.(jid, context.channelData);
      return channel.prepareDelivery(jid, text, id, gateContext);
    },
    deliverPrepared: (delivery) => channel.deliverPrepared(delivery),
    writeCursor: vi.fn(),
    auditSent: vi.fn(() => 'written' as const),
    auditSuppressed: () => 'written',
    auditCcContext: () => 'written',
    auditDeadLetter: vi.fn(() => 'written' as const),
    closeContainer: vi.fn(),
    alertDeadLetter: vi.fn(async () => undefined),
    now: () => new Date(now),
    newDeliveryId: () => 'resumed-repair-delivery',
  };
  const result = await processDelivery(
    {
      chatJid: jid,
      prompt: 'Original question',
      inboundText: 'Original question',
      targetTimestamp: now,
      previousCursor: '',
      context: base.context,
    },
    deps,
  );
  expect(deps.runBusinessAgent).not.toHaveBeenCalled();
  if (!hasEvidenceField) {
    expect(result).toEqual({ status: 'complete' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toBe(body);
    expect(deps.auditDeadLetter).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(
        ([fields]) =>
          fields &&
          typeof fields === 'object' &&
          'deliveryId' in fields &&
          fields.deliveryId ===
            (phase === 'transport-pending' ? deliveryId : base.outcomeId),
      ),
    ).toBe(true);
    // The exemption belongs only to this saved item; the next fresh send remains strict.
    expect(
      await sendOutboundEmailResult(
        { ...email, body: 'Fresh invented@example.org' },
        {
          sourceGroup: jid,
          forceBotReplyTo: true,
          deliveryId: 'fresh-after-upgrade',
        },
      ),
    ).toMatchObject({ status: 'failed', retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  } else {
    expect(result.status).toBe(
      phase === 'repair-required' ? 'retry' : 'terminal',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(
        ([fields]) =>
          fields && typeof fields === 'object' && 'deliveryId' in fields,
      ),
    ).toBe(false);
  }
}

// R2-3: host-generated dropped-CC disclosure is checked separately from agent-authored contact claims.
it('delivers an address-free reply with host-added dropped-CC disclosure without trusting that contact in the agent body', async () => {
  const context = {
    ...originalContext,
    bodyEvidenceVersion: 1,
    bodyAddresses: [],
    ccContext: {
      ccOnly: false,
      suppressAck: false,
      reason: 'direct',
      botInTo: true,
      realTo: 'person@example.edu, program@example.org',
      realCc: 'dropped@example.org',
    },
  };
  const channel = channelFor(context);
  const gateContext = await resolveEmailGateContext([], context);
  const prepared = await channel.prepareDelivery(
    jid,
    'Thanks, confirmed.',
    'host-disclosure',
    gateContext,
  );
  expect(prepared.status).toBe('prepared');
  if (prepared.status !== 'prepared') throw new Error('missing prepared reply');
  expect(await channel.deliverPrepared(prepared.delivery)).toMatchObject({
    status: 'sent',
  });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain(
    'not copied to dropped@example.org',
  );
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).cc).toBeUndefined();
  expect(
    await channel.prepareDelivery(
      jid,
      'Contact dropped@example.org',
      'invented-body',
      gateContext,
    ),
  ).toMatchObject({ status: 'failed' });
  expect(fetchMock).toHaveBeenCalledOnce();
});
