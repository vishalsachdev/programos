import { createHash } from 'crypto';

import { formatGateRefusal } from './delivery-gate.js';

import type { AuditWriteResult } from './audit-log.js';
import { buildDeliveryRepairPrompt } from './delivery-repair-prompt.js';
import {
  isTransportExpired,
  type DeliveryContext,
  type DeliveryState,
  type LoadDeliveryStateResult,
  type ProviderAcceptedState,
  type RepairRequiredState,
  type SaveDeliveryStateResult,
  type TransportPendingState,
} from './delivery-state.js';
import type {
  DeliveryOutcome,
  PreparedDelivery,
  PrepareDeliveryResult,
} from './types.js';

const MAX_ATTEMPTS = 6;
const SUPPRESSED_CHANNEL = '__suppressed__';

export type ProcessMessagesResult =
  | { status: 'complete' }
  | { status: 'terminal' }
  | { status: 'retry'; attempt: number };

export interface DeliveryRequest {
  chatJid: string;
  prompt: string;
  inboundText: string;
  targetTimestamp: string;
  previousCursor: string;
  targetMessageId?: string;
  context: DeliveryContext;
}

export type AgentDeliveryResult =
  | { status: 'success'; raw: string }
  | { status: 'error'; reason: string };

export interface SentAuditArgs {
  outcomeId: string;
  prepared: PreparedDelivery;
  replyText: string;
  providerId: string;
  inboundText: string;
}

export interface SuppressedAuditArgs {
  outcomeId: string;
  channel: string;
  sender?: string;
  subject?: string;
  reason: string;
}

export interface DeadLetterAuditArgs {
  outcomeId: string;
  channel: string;
  sender?: string;
  subject?: string;
  receivedAt?: string;
  chatJid: string;
  targetMessageId?: string;
  targetTimestamp: string;
  phase: string;
  attempts: number;
  reason: string;
}

export interface DeliveryProcessorDeps {
  /** Host-owned evidence to retain on all newly saved delivery/repair state. */
  trustedBodyAddresses?: string[];
  loadState(jid: string): LoadDeliveryStateResult;
  saveState(state: DeliveryState): SaveDeliveryStateResult;
  clearState(jid: string): void;
  runBusinessAgent(prompt: string): Promise<AgentDeliveryResult>;
  runRepairAgent(prompt: string): Promise<AgentDeliveryResult>;
  validateOutput(
    raw: string,
  ):
    | { ok: true; text: string }
    | { ok: false; reason: string; addresses?: string[] };
  prepareDelivery(
    text: string,
    deliveryId: string,
    context: DeliveryContext,
  ): Promise<PrepareDeliveryResult>;
  deliverPrepared(delivery: PreparedDelivery): Promise<DeliveryOutcome>;
  writeCursor(targetTimestamp: string): void;
  auditSent(args: SentAuditArgs): AuditWriteResult;
  auditSuppressed(args: SuppressedAuditArgs): AuditWriteResult;
  auditCcContext(args: SuppressedAuditArgs): AuditWriteResult;
  auditDeadLetter(args: DeadLetterAuditArgs): AuditWriteResult;
  closeContainer(): void;
  alertDeadLetter(args: DeadLetterAuditArgs): Promise<void>;
  now(): Date;
  newDeliveryId(): string;
}

export function computeOutcomeId(
  chatJid: string,
  targetTimestamp: string,
): string {
  return createHash('sha256')
    .update(`${chatJid}\n${targetTimestamp}`)
    .digest('hex')
    .slice(0, 32);
}

export async function processDelivery(
  request: DeliveryRequest,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  const loaded = deps.loadState(request.chatJid);
  if (loaded.status === 'invalid') {
    return discardCorruptState(request, loaded.reason, deps);
  }

  if (loaded.status === 'valid') {
    const state = loaded.state;
    if (state.phase === 'repair-required') {
      return processRepair(request, state, deps);
    }
    if (state.phase === 'transport-pending') {
      return processTransport(request, state, deps);
    }
    return finalizeAccepted(request, state, deps);
  }

  const agent = await deps.runBusinessAgent(request.prompt);
  if (agent.status === 'error') {
    throw new Error(`business-agent-failed: ${agent.reason}`);
  }
  return processAgentOutput(request, agent.raw, 1, undefined, deps);
}

async function processRepair(
  request: DeliveryRequest,
  state: RepairRequiredState,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  const agent = await deps.runRepairAgent(buildDeliveryRepairPrompt(state));
  if (agent.status === 'error') {
    throw new Error(`repair-agent-failed: ${agent.reason}`);
  }
  return processAgentOutput(request, agent.raw, state.attempt + 1, state, deps);
}

async function processAgentOutput(
  request: DeliveryRequest,
  raw: string,
  attempt: number,
  prior: RepairRequiredState | undefined,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  const targetTimestamp = prior?.targetTimestamp ?? request.targetTimestamp;
  const outcomeId =
    prior?.outcomeId ?? computeOutcomeId(request.chatJid, targetTimestamp);
  const context = prior?.context ?? request.context;
  const previousCursor = prior?.previousCursor ?? request.previousCursor;
  // A legacy repair remains the same one saved item across retries. Fresh
  // state always carries the field, including an explicitly empty list.
  const bodyEvidence =
    prior && !Object.hasOwn(prior, 'trustedBodyAddresses')
      ? {}
      : {
          trustedBodyAddresses:
            prior?.trustedBodyAddresses ?? deps.trustedBodyAddresses ?? [],
        };
  const gate = deps.validateOutput(raw);

  if (!gate.ok) {
    if (attempt >= MAX_ATTEMPTS) {
      return terminalize(
        request,
        {
          outcomeId,
          targetTimestamp,
          context,
          phase: 'repair-required',
          attempts: attempt,
          reason: formatGateRefusal(gate),
        },
        deps,
      );
    }
    const state: RepairRequiredState = {
      ...bodyEvidence,
      version: 1,
      phase: 'repair-required',
      chatJid: request.chatJid,
      targetTimestamp,
      previousCursor,
      context,
      outcomeId,
      gateReason: formatGateRefusal(gate),
      rejectedOutput: raw,
      attempt,
      createdAt: prior?.createdAt ?? deps.now().toISOString(),
    };
    if (deps.saveState(state).status !== 'saved') {
      return terminalize(
        request,
        {
          outcomeId,
          targetTimestamp,
          context,
          phase: 'repair-required',
          attempts: attempt,
          reason: 'delivery-state-save-failed',
        },
        deps,
      );
    }
    deps.closeContainer();
    return { status: 'retry', attempt };
  }

  if (!gate.text) {
    return persistSuppression(
      request,
      {
        outcomeId,
        targetTimestamp,
        previousCursor,
        context,
        reason: 'empty-agent-reply',
        replyText: '',
        attempt,
      },
      deps,
    );
  }

  const deliveryId = deps.newDeliveryId();
  const prepared = await deps.prepareDelivery(gate.text, deliveryId, context);
  if (prepared.status === 'suppressed') {
    return persistSuppression(
      request,
      {
        outcomeId,
        targetTimestamp,
        previousCursor,
        context,
        reason: prepared.reason,
        suppressionKind: prepared.suppressionKind,
        replyText: gate.text,
        attempt,
      },
      deps,
    );
  }
  if (prepared.status === 'failed') {
    return terminalize(
      request,
      {
        outcomeId,
        targetTimestamp,
        context,
        phase: 'prepare-delivery',
        attempts: attempt,
        reason: prepared.reason,
      },
      deps,
    );
  }

  const state: TransportPendingState = {
    ...bodyEvidence,
    version: 1,
    phase: 'transport-pending',
    chatJid: request.chatJid,
    targetTimestamp,
    previousCursor,
    context,
    outcomeId,
    prepared: prepared.delivery,
    replyText: gate.text,
    attempt: 1,
    createdAt: deps.now().toISOString(),
  };
  if (deps.saveState(state).status !== 'saved') {
    return terminalize(
      request,
      {
        outcomeId,
        targetTimestamp,
        context,
        phase: 'transport-pending',
        attempts: 0,
        reason: 'delivery-state-save-failed',
      },
      deps,
    );
  }
  return processTransport(request, state, deps);
}

async function processTransport(
  request: DeliveryRequest,
  state: TransportPendingState,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  if (isTransportExpired(state, deps.now())) {
    return terminalize(
      request,
      terminalFromState(state, 'unknown-provider-outcome'),
      deps,
    );
  }

  const outcome = await deps.deliverPrepared(state.prepared);
  if (outcome.status === 'sent') {
    const accepted: ProviderAcceptedState = {
      ...(Object.hasOwn(state, 'trustedBodyAddresses')
        ? { trustedBodyAddresses: state.trustedBodyAddresses }
        : {}),
      version: 1,
      phase: 'provider-accepted',
      chatJid: state.chatJid,
      targetTimestamp: state.targetTimestamp,
      previousCursor: state.previousCursor,
      context: state.context,
      outcomeId: state.outcomeId,
      prepared: state.prepared,
      replyText: state.replyText,
      attempt: state.attempt,
      providerId: outcome.providerId ?? state.prepared.deliveryId,
      acceptedAt: deps.now().toISOString(),
    };
    if (deps.saveState(accepted).status !== 'saved') {
      return { status: 'retry', attempt: state.attempt };
    }
    return finalizeAccepted(request, accepted, deps);
  }

  if (outcome.status === 'suppressed') {
    return persistSuppression(
      request,
      {
        outcomeId: state.outcomeId,
        targetTimestamp: state.targetTimestamp,
        previousCursor: state.previousCursor,
        context: state.context,
        reason: outcome.reason,
        replyText: state.replyText,
        attempt: state.attempt,
      },
      deps,
    );
  }

  if (!outcome.retryable || state.attempt >= MAX_ATTEMPTS) {
    return terminalize(request, terminalFromState(state, outcome.reason), deps);
  }

  const next: TransportPendingState = {
    ...state,
    attempt: state.attempt + 1,
  };
  if (deps.saveState(next).status !== 'saved') {
    return terminalize(
      request,
      terminalFromState(state, 'delivery-state-save-failed'),
      deps,
    );
  }
  return { status: 'retry', attempt: state.attempt };
}

interface SuppressionPending {
  outcomeId: string;
  targetTimestamp: string;
  previousCursor: string;
  context: DeliveryContext;
  reason: string;
  suppressionKind?: 'cc-context';
  replyText: string;
  attempt: number;
}

async function persistSuppression(
  request: DeliveryRequest,
  pending: SuppressionPending,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  const accepted: ProviderAcceptedState = {
    trustedBodyAddresses: deps.trustedBodyAddresses ?? [],
    version: 1,
    phase: 'provider-accepted',
    chatJid: request.chatJid,
    targetTimestamp: pending.targetTimestamp,
    previousCursor: pending.previousCursor,
    context: pending.context,
    outcomeId: pending.outcomeId,
    prepared: {
      channel: SUPPRESSED_CHANNEL,
      deliveryId: deps.newDeliveryId(),
      jid: request.chatJid,
      payload: {
        reason: pending.reason,
        ...(pending.suppressionKind
          ? { suppressionKind: pending.suppressionKind }
          : {}),
      },
    },
    replyText: pending.replyText,
    attempt: pending.attempt,
    providerId: 'suppressed',
    acceptedAt: deps.now().toISOString(),
  };
  if (deps.saveState(accepted).status !== 'saved') {
    return { status: 'retry', attempt: pending.attempt };
  }
  return finalizeAccepted(request, accepted, deps);
}

async function finalizeAccepted(
  request: DeliveryRequest,
  state: ProviderAcceptedState,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  const suppressionArgs = {
    outcomeId: state.outcomeId,
    channel: channelLabel(request.chatJid),
    sender: state.context.sender,
    subject: state.context.subject,
    reason: suppressionReason(state.prepared),
  };
  const auditResult =
    state.prepared.channel === SUPPRESSED_CHANNEL
      ? suppressionKind(state.prepared) === 'cc-context'
        ? deps.auditCcContext(suppressionArgs)
        : deps.auditSuppressed(suppressionArgs)
      : deps.auditSent({
          outcomeId: state.outcomeId,
          prepared: state.prepared,
          replyText: state.replyText,
          providerId: state.providerId,
          inboundText: request.inboundText,
        });
  if (auditResult === 'write-failed') {
    return { status: 'retry', attempt: state.attempt };
  }
  deps.writeCursor(state.targetTimestamp);
  deps.clearState(request.chatJid);
  return { status: 'complete' };
}

async function discardCorruptState(
  request: DeliveryRequest,
  loadReason: string,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  const reason = `corrupt-state: ${loadReason}`;
  const auditArgs: DeadLetterAuditArgs = {
    outcomeId: computeOutcomeId(
      request.chatJid,
      `${request.previousCursor}\n${reason}`,
    ),
    channel: channelLabel(request.chatJid),
    chatJid: request.chatJid,
    targetTimestamp: request.previousCursor || request.targetTimestamp,
    phase: 'corrupt-state',
    attempts: 0,
    reason,
  };
  if (deps.auditDeadLetter(auditArgs) === 'write-failed') {
    return { status: 'retry', attempt: 1 };
  }
  deps.clearState(request.chatJid);
  try {
    await deps.alertDeadLetter(auditArgs);
  } catch {
    // The durable audit exists and pending messages remain queued.
  }
  return { status: 'retry', attempt: 1 };
}

interface TerminalPending {
  outcomeId: string;
  targetTimestamp: string;
  context: DeliveryContext;
  phase: string;
  attempts: number;
  reason: string;
}

async function terminalize(
  request: DeliveryRequest,
  pending: TerminalPending,
  deps: DeliveryProcessorDeps,
): Promise<ProcessMessagesResult> {
  const auditArgs: DeadLetterAuditArgs = {
    outcomeId: pending.outcomeId,
    channel: channelLabel(request.chatJid),
    sender: pending.context.sender,
    subject: pending.context.subject,
    receivedAt: pending.context.receivedAt,
    chatJid: request.chatJid,
    targetMessageId: request.targetMessageId ?? pending.context.messageId,
    targetTimestamp: pending.targetTimestamp,
    phase: pending.phase,
    attempts: pending.attempts,
    reason: pending.reason,
  };
  if (deps.auditDeadLetter(auditArgs) === 'write-failed') {
    return { status: 'retry', attempt: Math.max(1, pending.attempts) };
  }
  deps.writeCursor(pending.targetTimestamp);
  deps.clearState(request.chatJid);
  try {
    await deps.alertDeadLetter(auditArgs);
  } catch {
    // Alerting is best-effort after durable audit + cursor bookkeeping.
  }
  return { status: 'terminal' };
}

function terminalFromState(
  state: TransportPendingState,
  reason: string,
): TerminalPending {
  return {
    outcomeId: state.outcomeId,
    targetTimestamp: state.targetTimestamp,
    context: state.context,
    phase: state.phase,
    attempts: state.attempt,
    reason,
  };
}

function suppressionReason(delivery: PreparedDelivery): string {
  if (
    delivery.payload &&
    typeof delivery.payload === 'object' &&
    typeof (delivery.payload as { reason?: unknown }).reason === 'string'
  ) {
    return (delivery.payload as { reason: string }).reason;
  }
  return 'reply-suppressed';
}

function suppressionKind(delivery: PreparedDelivery): 'cc-context' | undefined {
  if (
    delivery.payload &&
    typeof delivery.payload === 'object' &&
    (delivery.payload as { suppressionKind?: unknown }).suppressionKind ===
      'cc-context'
  ) {
    return 'cc-context';
  }
  return undefined;
}

function channelLabel(jid: string): string {
  if (jid.startsWith('webhook-email:')) return 'email';
  if (jid.startsWith('tg-') || jid.startsWith('telegram:')) return 'telegram';
  if (jid.startsWith('web-chat:')) return 'web-chat';
  return 'unknown';
}
