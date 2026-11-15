import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeOutcomeId,
  processDelivery,
  type DeliveryProcessorDeps,
  type DeliveryRequest,
} from './delivery-processor.js';
import type { DeliveryState } from './delivery-state.js';
import type { PreparedDelivery } from './types.js';

const REQUEST: DeliveryRequest = {
  chatJid: 'webhook-email:thread-1',
  prompt: 'From Alice: launch question',
  inboundText: 'launch question',
  targetTimestamp: '2026-08-10T15:00:00.000Z',
  previousCursor: '2026-08-10T14:00:00.000Z',
  targetMessageId: 'message-1',
  context: {
    sender: 'alice@example.edu',
    subject: 'Launch question',
    receivedAt: '2026-08-10T15:00:00.000Z',
    messageId: 'message-1@example.com',
  },
};

const PREPARED: PreparedDelivery = {
  channel: 'webhook',
  deliveryId: 'delivery-1',
  jid: REQUEST.chatJid,
  payload: { to: 'alice@example.edu', body: 'Fixed reply' },
};

describe('processDelivery', () => {
  let stored: DeliveryState | undefined;
  let timeline: string[];
  let deps: DeliveryProcessorDeps;

  beforeEach(() => {
    stored = undefined;
    timeline = [];
    deps = {
      loadState: vi.fn(() =>
        stored
          ? { status: 'valid' as const, state: stored }
          : { status: 'none' as const },
      ),
      saveState: vi.fn((state) => {
        stored = structuredClone(state);
        timeline.push(`save:${state.phase}`);
        return { status: 'saved' as const };
      }),
      clearState: vi.fn(() => {
        stored = undefined;
        timeline.push('clear');
      }),
      runBusinessAgent: vi.fn(async () => ({
        status: 'success' as const,
        raw: '<reply>Fixed reply</reply>',
      })),
      runRepairAgent: vi.fn(async () => ({
        status: 'success' as const,
        raw: '<reply>Fixed reply</reply>',
      })),
      validateOutput: vi.fn((raw) =>
        raw.includes('<reply>')
          ? { ok: true as const, text: 'Fixed reply' }
          : { ok: false as const, reason: 'missing-reply-block' },
      ),
      prepareDelivery: vi.fn(async () => ({
        status: 'prepared' as const,
        delivery: PREPARED,
      })),
      deliverPrepared: vi.fn(async () => ({
        status: 'sent' as const,
        providerId: 'resend-1',
      })),
      writeCursor: vi.fn(() => timeline.push('cursor')),
      auditSent: vi.fn(() => {
        timeline.push('audit:sent');
        return 'written' as const;
      }),
      auditSuppressed: vi.fn(() => {
        timeline.push('audit:suppressed');
        return 'written' as const;
      }),
      auditCcContext: vi.fn(() => {
        timeline.push('audit:cc-context');
        return 'written' as const;
      }),
      auditDeadLetter: vi.fn(() => {
        timeline.push('audit:dead');
        return 'written' as const;
      }),
      closeContainer: vi.fn(() => timeline.push('close')),
      alertDeadLetter: vi.fn(async () => undefined),
      now: () => new Date('2026-08-10T16:00:00.000Z'),
      newDeliveryId: () => 'delivery-1',
    };
  });

  it('persists a refused business reply and closes its container immediately', async () => {
    vi.mocked(deps.runBusinessAgent).mockResolvedValue({
      status: 'success',
      raw: 'The work is complete.',
    });

    const result = await processDelivery(REQUEST, deps);

    expect(deps.runBusinessAgent).toHaveBeenCalledTimes(1);
    expect(deps.closeContainer).toHaveBeenCalledTimes(1);
    expect(stored?.phase).toBe('repair-required');
    expect(result).toEqual({ status: 'retry', attempt: 1 });
    expect(timeline).toEqual(['save:repair-required', 'close']);
  });

  it('uses only the repair agent on a persisted reply refusal', async () => {
    stored = repairState(1);

    await processDelivery(REQUEST, deps);

    expect(deps.runBusinessAgent).not.toHaveBeenCalled();
    expect(deps.runRepairAgent).toHaveBeenCalledTimes(1);
    expect(deps.deliverPrepared).toHaveBeenCalledTimes(1);
  });

  it('persists a frozen envelope before delivery and advances exactly to target', async () => {
    await processDelivery(REQUEST, deps);

    expect(timeline).toEqual([
      'save:transport-pending',
      'save:provider-accepted',
      'audit:sent',
      'cursor',
      'clear',
    ]);
    expect(deps.writeCursor).toHaveBeenCalledWith(REQUEST.targetTimestamp);
    expect(deps.prepareDelivery).toHaveBeenCalledWith(
      'Fixed reply',
      'delivery-1',
      REQUEST.context,
    );
  });

  it('retries a frozen transport without invoking either agent', async () => {
    stored = transportState(2);
    vi.mocked(deps.deliverPrepared).mockResolvedValue({
      status: 'failed',
      reason: 'provider-timeout',
      retryable: true,
    });

    const result = await processDelivery(REQUEST, deps);

    expect(deps.runBusinessAgent).not.toHaveBeenCalled();
    expect(deps.runRepairAgent).not.toHaveBeenCalled();
    expect(deps.prepareDelivery).not.toHaveBeenCalled();
    expect(deps.deliverPrepared).toHaveBeenCalledWith(PREPARED);
    expect(stored).toMatchObject({
      phase: 'transport-pending',
      prepared: PREPARED,
      attempt: 3,
    });
    expect(result).toEqual({ status: 'retry', attempt: 2 });
  });

  it('restores provider acceptance without calling the provider', async () => {
    stored = acceptedState();

    await processDelivery(REQUEST, deps);

    expect(deps.deliverPrepared).not.toHaveBeenCalled();
    expect(deps.auditSent).toHaveBeenCalledTimes(1);
    expect(deps.auditSent).toHaveBeenCalledWith(
      expect.objectContaining({ inboundText: REQUEST.inboundText }),
    );
    expect(deps.writeCursor).toHaveBeenCalledWith(REQUEST.targetTimestamp);
    expect(deps.clearState).toHaveBeenCalledTimes(1);
  });

  it('keeps provider-accepted state when durable audit evidence cannot be written', async () => {
    stored = acceptedState();
    vi.mocked(deps.auditSent).mockReturnValue('write-failed');

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'retry', attempt: 1 });
    expect(stored?.phase).toBe('provider-accepted');
    expect(deps.writeCursor).not.toHaveBeenCalled();
    expect(deps.clearState).not.toHaveBeenCalled();
  });

  it('preserves the CC-context audit type across suppression finalization', async () => {
    vi.mocked(deps.prepareDelivery).mockResolvedValue({
      status: 'suppressed',
      reason: 'cc-context-no-direct-request',
      outcomeId: 'delivery-1',
      suppressionKind: 'cc-context',
    });

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'complete' });
    expect(deps.auditCcContext).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'cc-context-no-direct-request' }),
    );
    expect(deps.auditSuppressed).not.toHaveBeenCalled();
    expect(deps.auditSent).not.toHaveBeenCalled();
    expect(deps.writeCursor).toHaveBeenCalledWith(REQUEST.targetTimestamp);
  });

  it('keeps non-CC suppression in the generic audit path', async () => {
    vi.mocked(deps.prepareDelivery).mockResolvedValue({
      status: 'suppressed',
      reason: 'agent-inbox-no-reply',
      outcomeId: 'delivery-1',
    });

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'complete' });
    expect(deps.auditSuppressed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'agent-inbox-no-reply' }),
    );
    expect(deps.auditCcContext).not.toHaveBeenCalled();
    expect(deps.auditSent).not.toHaveBeenCalled();
  });

  it('dead-letters a permanent preparation failure immediately', async () => {
    vi.mocked(deps.prepareDelivery).mockResolvedValue({
      status: 'failed',
      reason: 'recipient-missing',
      retryable: false,
    });

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'terminal' });
    expect(deps.auditDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'recipient-missing', attempts: 1 }),
    );
    expect(deps.writeCursor).toHaveBeenCalledWith(REQUEST.targetTimestamp);
  });

  it('dead-letters the sixth refused repair across restarts', async () => {
    stored = repairState(5);
    vi.mocked(deps.runRepairAgent).mockResolvedValue({
      status: 'success',
      raw: 'Still malformed.',
    });

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'terminal' });
    expect(deps.auditDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 6, phase: 'repair-required' }),
    );
  });

  it('dead-letters the sixth failed transport across restarts', async () => {
    stored = transportState(6);
    vi.mocked(deps.deliverPrepared).mockResolvedValue({
      status: 'failed',
      reason: 'provider-timeout',
      retryable: true,
    });

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'terminal' });
    expect(deps.auditDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 6, phase: 'transport-pending' }),
    );
  });

  it('does not retry an envelope beyond the provider idempotency window', async () => {
    stored = transportState(2, '2026-08-09T15:59:59.000Z');

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'terminal' });
    expect(deps.deliverPrepared).not.toHaveBeenCalled();
    expect(deps.auditDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unknown-provider-outcome' }),
    );
  });

  it('does not reverse terminal bookkeeping when the owner alert fails', async () => {
    vi.mocked(deps.prepareDelivery).mockResolvedValue({
      status: 'failed',
      reason: 'recipient-missing',
      retryable: false,
    });
    vi.mocked(deps.alertDeadLetter).mockRejectedValue(
      new Error('telegram down'),
    );

    await expect(processDelivery(REQUEST, deps)).resolves.toEqual({
      status: 'terminal',
    });
    expect(timeline.slice(-2)).toEqual(['cursor', 'clear']);
  });

  it('dead-letters only corrupt state and leaves pending messages behind', async () => {
    vi.mocked(deps.loadState).mockReturnValue({
      status: 'invalid',
      reason: 'unsupported-version',
    });

    const result = await processDelivery(REQUEST, deps);

    expect(result).toEqual({ status: 'retry', attempt: 1 });
    expect(deps.runBusinessAgent).not.toHaveBeenCalled();
    expect(deps.runRepairAgent).not.toHaveBeenCalled();
    expect(deps.deliverPrepared).not.toHaveBeenCalled();
    expect(deps.auditDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'corrupt-state: unsupported-version' }),
    );
    expect(deps.auditDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ targetTimestamp: REQUEST.previousCursor }),
    );
    expect(vi.mocked(deps.auditDeadLetter).mock.calls[0][0]).not.toHaveProperty(
      'targetMessageId',
    );
    expect(deps.writeCursor).not.toHaveBeenCalled();
    expect(deps.clearState).toHaveBeenCalledWith(REQUEST.chatJid);
  });

  it('derives stable outcome IDs from only the chat and target boundary', () => {
    expect(computeOutcomeId('chat', 'timestamp')).toMatch(/^[a-f0-9]{32}$/);
    expect(computeOutcomeId('chat', 'timestamp')).toBe(
      computeOutcomeId('chat', 'timestamp'),
    );
    expect(computeOutcomeId('chat', 'newer')).not.toBe(
      computeOutcomeId('chat', 'timestamp'),
    );
  });

  function repairState(attempt: number): DeliveryState {
    return {
      version: 1,
      phase: 'repair-required',
      chatJid: REQUEST.chatJid,
      targetTimestamp: REQUEST.targetTimestamp,
      previousCursor: REQUEST.previousCursor,
      context: REQUEST.context,
      outcomeId: computeOutcomeId(REQUEST.chatJid, REQUEST.targetTimestamp),
      gateReason: 'missing-reply-block',
      rejectedOutput: 'Malformed result',
      attempt,
      createdAt: '2026-08-10T15:01:00.000Z',
    };
  }

  function transportState(
    attempt: number,
    createdAt = '2026-08-10T15:01:00.000Z',
  ): DeliveryState {
    return {
      version: 1,
      phase: 'transport-pending',
      chatJid: REQUEST.chatJid,
      targetTimestamp: REQUEST.targetTimestamp,
      previousCursor: REQUEST.previousCursor,
      context: REQUEST.context,
      outcomeId: computeOutcomeId(REQUEST.chatJid, REQUEST.targetTimestamp),
      prepared: PREPARED,
      replyText: 'Fixed reply',
      attempt,
      createdAt,
    };
  }

  function acceptedState(): DeliveryState {
    return {
      version: 1,
      phase: 'provider-accepted',
      chatJid: REQUEST.chatJid,
      targetTimestamp: REQUEST.targetTimestamp,
      previousCursor: REQUEST.previousCursor,
      context: REQUEST.context,
      outcomeId: computeOutcomeId(REQUEST.chatJid, REQUEST.targetTimestamp),
      prepared: PREPARED,
      replyText: 'Fixed reply',
      attempt: 1,
      providerId: 'resend-1',
      acceptedAt: '2026-08-10T15:02:00.000Z',
    };
  }
});
