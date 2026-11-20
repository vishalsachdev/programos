import path from 'path';
import { randomUUID } from 'crypto';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  MAX_MESSAGES_PER_PROMPT,
  MESSAGE_DEBOUNCE_MS,
  POLL_INTERVAL,
  TELEGRAM_OWNER_JID,
  TIMEZONE,
  DATA_DIR,
} from './config.js';
import { assertIdentitySettingsConfigured } from './identity-settings-check.js';
import {
  ensureHostRepo,
  hostRepoPlacementProblem,
  setHostRepoAlerter,
} from './host-repo.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  resolveProxyBindHost,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { readEnvFile } from './env.js';
import { setProviderChangeNotifier } from './model-provider.js';
import { GroupQueue } from './group-queue.js';
import {
  readGroupTemplate,
  resolveGroupFolderPath,
  seedGroupFolder,
} from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages } from './router.js';
import {
  assertGateProfile,
  trustedBodyAddressesFromContext,
  formatGateRefusal,
  type DeliveryGateContext,
  setDeliveryShortfallAlerter,
  warnIfShortReply,
} from './delivery-gate.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startDeliveryCheck } from './email-delivery-check.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { hydrateAllowlistSnapshots } from './allowlist-snapshot.js';
import {
  ackDeferredDeliveryNotes,
  deferDeliveryNoteAck,
  deliveryNotesSection,
} from './delivery-notes.js';
import { prepareWorkingContext } from './working-context.js';
import { logger } from './logger.js';
import {
  flushAuditLog,
  syncKnowledgeBase,
  logCcContextSuppressionOnce,
  logDeadLetterOnce,
  logDeliveryProblem,
  logInbound,
  logOutboundEmailOnce,
  logOutboundOnce,
  logReplySuppressedOnce,
  type AuditWriteResult,
} from './audit-log.js';
import { recordEval } from './eval-tracker.js';
import { parseImageReferences } from './image.js';
import { isDerivedWebChatJid } from './channels/web-chat-session.js';
import {
  resolveChannelDeliveryContext,
  sendImmediate,
} from './channel-delivery.js';
import { getRepoReader } from './repo-reader.js';
import { resolveEmailGateContext } from './email-gate-context.js';
import { buildRecentWorkSection } from './recent-work.js';
import {
  clearDeliveryState,
  loadDeliveryState,
  saveDeliveryState,
} from './delivery-state.js';
import {
  processDelivery,
  type AgentDeliveryResult,
  type ProcessMessagesResult,
  type SentAuditArgs,
} from './delivery-processor.js';
import { stripMarkdown } from './email-format.js';
import {
  adminShortfallAlerter,
  checkAdminAlertConfig,
  createThrowingAdminAlerter,
  sendTestAdminAlerts,
  type ThrowingAdminAlerter,
} from './admin-alert.js';
import {
  shutdownOutboundEmailQueue,
  startOutboundEmailQueue,
} from './outbound-email.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();
let sendDeadLetterAlert: ThrowingAdminAlerter = async (text) => {
  logger.error({ text }, 'Alert channel is not initialized');
  // Never resolve silently: an unsent alert must not look delivered to the
  // shortfall-replay layer, which deletes an alert only on confirmation.
  throw new Error('Alert channel is not initialized');
};

interface ResolvedGroup {
  registeredJid: string;
  group: RegisteredGroup;
}

function resolveRegisteredGroup(chatJid: string): ResolvedGroup | undefined {
  const direct = registeredGroups[chatJid];
  if (direct) {
    return { registeredJid: chatJid, group: direct };
  }

  if (chatJid.startsWith('webhook-email:')) {
    const emailGroup = registeredGroups['webhook-email@program'];
    if (emailGroup) {
      return {
        registeredJid: 'webhook-email@program',
        group: emailGroup,
      };
    }
  }

  if (isDerivedWebChatJid(chatJid)) {
    const webChatGroup = registeredGroups['web-chat-program@program'];
    if (webChatGroup) {
      return {
        registeredJid: 'web-chat-program@program',
        group: webChatGroup,
      };
    }
  }

  return undefined;
}

function getSessionKey(
  registeredJid: string,
  group: RegisteredGroup,
  chatJid: string,
): string {
  if (registeredJid === chatJid) return group.folder;
  return `${group.folder}:${chatJid}`;
}

function getProcessableChatJids(): string[] {
  const jids = new Set(Object.keys(registeredGroups));
  for (const chat of getAllChats()) {
    if (resolveRegisteredGroup(chat.jid)) {
      jids.add(chat.jid);
    }
  }
  return [...jids];
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

/**
 * Pull every message for a group since its cursor (recovering the cursor from
 * the last bot reply when missing), capped at MAX_MESSAGES_PER_PROMPT.
 */
function getPendingMessages(chatJid: string): NewMessage[] {
  return getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );
}

/**
 * Whether any message satisfies the group's trigger: it matches the trigger
 * pattern AND is either from us or from an allowlisted sender.
 */
function messagesContainTrigger(
  messages: NewMessage[],
  group: RegisteredGroup,
  registeredJid: string,
): boolean {
  const triggerPattern = getTriggerPattern(group.trigger);
  const allowlistCfg = loadSenderAllowlist();
  return messages.some(
    (m) =>
      triggerPattern.test(m.content.trim()) &&
      (m.is_from_me || isTriggerAllowed(registeredJid, m.sender, allowlistCfg)),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder, and copy the CLAUDE.md template into it so agents
  // have identity and instructions from the first run.  (Fixes #1391)
  let template = readGroupTemplate(group.isMain === true);
  if (template !== null) {
    if (ASSISTANT_NAME !== 'Andy') {
      template = template.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
      template = template.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
    }
  }
  if (seedGroupFolder(groupDir, template)) {
    logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
  }

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(
  chatJid: string,
): Promise<ProcessMessagesResult> {
  const resolved = resolveRegisteredGroup(chatJid);
  if (!resolved) return { status: 'complete' };

  const { registeredJid, group } = resolved;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return { status: 'terminal' };
  }

  const isMainGroup = group.isMain === true;
  const missedMessages = getPendingMessages(chatJid);
  const restored = loadDeliveryState(chatJid);

  if (missedMessages.length === 0 && restored.status === 'none') {
    return { status: 'complete' };
  }

  // For non-main groups, check if trigger is required and present
  if (
    !isMainGroup &&
    group.requiresTrigger !== false &&
    restored.status === 'none' &&
    !messagesContainTrigger(missedMessages, group, registeredJid)
  ) {
    return { status: 'complete' };
  }

  const previousCursor = lastAgentTimestamp[chatJid] || '';
  const targetTimestamp =
    restored.status === 'valid'
      ? restored.state.targetTimestamp
      : (missedMessages[missedMessages.length - 1]?.timestamp ??
        previousCursor);
  const messagesAtBoundary = missedMessages.filter(
    (message) => message.timestamp <= targetTimestamp,
  );
  const prompt = formatMessages(messagesAtBoundary, TIMEZONE);
  const targetMessage = messagesAtBoundary[messagesAtBoundary.length - 1];

  logger.info(
    {
      group: group.name,
      messageCount: messagesAtBoundary.length,
      targetTimestamp,
      recoveryPhase:
        restored.status === 'valid' ? restored.state.phase : restored.status,
    },
    'Processing messages',
  );

  await channel.setTyping?.(chatJid, true);
  try {
    const latest = targetMessage ?? missedMessages[missedMessages.length - 1];
    const channelData = resolveChannelDeliveryContext(channel, chatJid, latest);
    const subject =
      channelData !== null &&
      typeof channelData === 'object' &&
      !Array.isArray(channelData) &&
      typeof (channelData as Record<string, unknown>).subject === 'string'
        ? (channelData as Record<string, string>).subject
        : undefined;
    const emailGateContext: DeliveryGateContext | undefined =
      channel.gateProfile.name === 'email'
        ? await resolveEmailGateContext(
            messagesAtBoundary,
            restored.status === 'valid'
              ? restored.state.context.channelData
              : channelData,
            restored.status === 'valid' ? restored.state : undefined,
          )
        : undefined;
    const result = await processDelivery(
      {
        chatJid,
        prompt,
        inboundText: messagesAtBoundary.map((m) => m.content).join(' '),
        targetTimestamp,
        previousCursor,
        targetMessageId: latest?.id,
        context: {
          sender: latest?.sender,
          subject,
          receivedAt: latest?.timestamp,
          messageId: latest?.id,
          channelData,
        },
      },
      {
        loadState: loadDeliveryState,
        trustedBodyAddresses: emailGateContext
          ? trustedBodyAddressesFromContext(emailGateContext)
          : undefined,
        saveState: saveDeliveryState,
        clearState: clearDeliveryState,
        runBusinessAgent: () =>
          runAgentForDelivery(
            group,
            registeredJid,
            prompt,
            chatJid,
            messagesAtBoundary,
            'normal',
          ),
        runRepairAgent: (repairPrompt) =>
          runAgentForDelivery(
            group,
            registeredJid,
            repairPrompt,
            chatJid,
            [],
            'delivery-repair',
          ),
        validateOutput: (raw) => {
          const gate = channel.gateProfile.validate(raw, emailGateContext);
          const textLength = gate.ok ? gate.text.length : 0;
          recordEval(chatJid, raw, textLength);
          if (gate.ok && gate.text) {
            warnIfShortReply(
              gate.text,
              messagesAtBoundary.map((m) => m.content).join(' '),
              `group=${group.name} jid=${chatJid}`,
            );
          }
          return gate;
        },
        prepareDelivery: (text, deliveryId, context) => {
          if (
            context.channelData !== undefined &&
            channel.restoreDeliveryContext &&
            !channel.restoreDeliveryContext(chatJid, context.channelData)
          ) {
            return Promise.resolve({
              status: 'failed' as const,
              reason: 'invalid-restored-channel-context',
              retryable: false as const,
            });
          }
          return channel.prepareDelivery(
            chatJid,
            text,
            deliveryId,
            emailGateContext,
          );
        },
        deliverPrepared: (delivery) => channel.deliverPrepared(delivery),
        writeCursor: (timestamp) => {
          lastAgentTimestamp[chatJid] = timestamp;
          saveState();
        },
        auditSent: auditPreparedSent,
        auditSuppressed: logReplySuppressedOnce,
        auditCcContext: logCcContextSuppressionOnce,
        auditDeadLetter: logDeadLetterOnce,
        closeContainer: () => queue.closeStdin(chatJid),
        alertDeadLetter: async (details) => {
          await sendDeadLetterAlert(
            `⚠️ Coordinator dead-letter: ${details.channel} reply for ${details.sender ?? details.chatJid} ended at ${details.phase} after ${details.attempts} attempt(s): ${details.reason}.`,
          );
        },
        now: () => new Date(),
        newDeliveryId: randomUUID,
      },
    );
    // RC-018: acknowledge the delivery notes this run read only when the
    // reply was durably delivered; any other terminal outcome leaves them
    // for the repair run or the retry.
    if (result.status === 'complete') ackDeferredDeliveryNotes(chatJid);

    if (result.status !== 'retry' && getPendingMessages(chatJid).length > 0) {
      queue.enqueueMessageCheck(chatJid);
    }
    return result;
  } finally {
    await channel.setTyping?.(chatJid, false);
  }
}

async function runAgentForDelivery(
  group: RegisteredGroup,
  registeredJid: string,
  prompt: string,
  chatJid: string,
  currentMessages: NewMessage[],
  agentMode: 'normal' | 'delivery-repair',
): Promise<AgentDeliveryResult> {
  let raw: string | undefined;
  let streamedError: string | undefined;
  const status = await runAgent(
    group,
    registeredJid,
    prompt,
    chatJid,
    currentMessages,
    async (result) => {
      if (result.status === 'error') {
        streamedError = result.error ?? 'agent-stream-error';
      }
      if (result.result !== null && raw === undefined) {
        raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        queue.closeStdin(chatJid);
      }
    },
    agentMode,
  );
  if (status === 'error' || streamedError) {
    return { status: 'error', reason: streamedError ?? 'agent-run-error' };
  }
  if (raw === undefined) {
    return { status: 'error', reason: 'agent-returned-no-result' };
  }
  return { status: 'success', raw };
}

function auditPreparedSent(args: SentAuditArgs): AuditWriteResult {
  const auditResult =
    args.prepared.channel !== 'webhook'
      ? logOutboundOnce(
          args.prepared.jid,
          args.replyText,
          args.outcomeId,
          args.inboundText,
        )
      : (() => {
          const payload = args.prepared.payload as {
            email?: {
              to?: string;
              cc?: string;
              subject?: string;
              body?: string;
            };
            options?: { sourceGroup?: string; ccDroppedNote?: string };
          };
          if (
            !payload?.email?.to ||
            !payload.email.subject ||
            !payload.email.body ||
            !payload.options?.sourceGroup
          ) {
            logger.error(
              { deliveryId: args.prepared.deliveryId },
              'Cannot write email delivery audit: frozen payload is invalid',
            );
            return 'write-failed' as const;
          }
          return logOutboundEmailOnce({
            deliveryId: args.prepared.deliveryId,
            to: payload.email.to,
            cc: payload.email.cc,
            ...(payload.options.ccDroppedNote
              ? { ccDropped: payload.options.ccDroppedNote }
              : {}),
            subject: payload.email.subject,
            sourceGroup: payload.options.sourceGroup,
            resendId: args.providerId,
            body: stripMarkdown(payload.email.body),
          });
        })();

  if (auditResult === 'written') {
    storeMessage({
      id: args.outcomeId,
      chat_jid: args.prepared.jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: args.replyText,
      timestamp: new Date().toISOString(),
      is_from_me: true,
      is_bot_message: true,
    });
  }

  return auditResult;
}

async function runAgent(
  group: RegisteredGroup,
  registeredJid: string,
  prompt: string,
  chatJid: string,
  currentMessages: NewMessage[],
  onOutput?: (output: ContainerOutput) => Promise<void>,
  agentMode: 'normal' | 'delivery-repair' = 'normal',
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionKey = getSessionKey(registeredJid, group, chatJid);
  const sessionId = sessions[sessionKey];

  // Update tasks snapshot for container to read (filtered by group)
  writeTasksSnapshot(group.folder, isMain, getAllTasks());

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(group.folder, isMain, availableGroups);

  // Wrap onOutput to track session ID from streamed results, and (RC-018)
  // whether the run produced a usable result without a streamed error —
  // the same conditions runAgentForDelivery uses to call a run successful.
  let sawUsableResult = false;
  let sawStreamedError = false;
  const wrappedOnOutput = async (output: ContainerOutput) => {
    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }
    if (output.status === 'error') sawStreamedError = true;
    if (output.result !== null && output.result !== undefined) {
      sawUsableResult = true;
    }
    // Take what the agent committed out of its checkout and push it, before
    // the reply is handed on (host-repo.ts; the host runs no git in there).
    if (output.status === 'success') await syncKnowledgeBase();
    if (onOutput) await onOutput(output);
  };

  // Working-context handoff (session-start read path): for the admin main
  // group only, load the private working layer, prune/filter to the decay
  // window, and prepend it clearly labeled as tentative + dated. The write
  // path is agent-driven — the injected block instructs the agent to update
  // /workspace/working-context/<user>.json after substantive exchanges.
  const workingContext =
    agentMode === 'normal' ? prepareWorkingContext(group) : null;
  // RC-018 delivery record: what the host actually did with this group's
  // earlier send_email calls (dropped CCs, refused sends). Prepended so the
  // agent narrates real outcomes; consumed on read.
  // Keyed by this run's chat jid (per-thread email sessions store their
  // sends under the jid) and, for the main group only, the shared folder.
  // Loaded in repair mode too: a repair rewrites the reply the notes are
  // meant to correct.
  const deliveryNotes = deliveryNotesSection([
    chatJid,
    ...(isMain ? [group.folder] : []),
  ]);
  const recentWork =
    agentMode === 'normal' &&
    !sessionId &&
    !isDerivedWebChatJid(chatJid) &&
    registeredJid !== 'web-chat-program@program'
      ? buildRecentWorkSection({
          chatJid,
          currentMessages,
          repoRevision: getRepoReader().currentSha,
        })
      : null;
  const promptWithContext = [
    recentWork,
    workingContext?.section,
    deliveryNotes?.section,
    prompt,
  ]
    .filter((part): part is string => !!part)
    .join('\n\n');

  try {
    // Commit pending audit entries, fetch the origin and refresh the export
    // the container pulls from, so the agent reads the current state.
    await syncKnowledgeBase({ fetchOrigin: true });
    const imageAttachments =
      agentMode === 'normal' ? parseImageReferences(prompt) : [];

    const output = await runContainerAgent(
      group,
      {
        prompt: promptWithContext,
        agentMode,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        imageAttachments:
          imageAttachments.length > 0 ? imageAttachments : undefined,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        // Clear the session under the key it was actually stored at. For
        // derived JIDs (email threads, web-chat) sessionKey is
        // `${group.folder}:${chatJid}`, not group.folder — deleting the
        // latter would miss the broken session and wipe an unrelated one.
        delete sessions[sessionKey];
        deleteSession(sessionKey);
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    // Defer the acknowledgement: only the delivery processor knows whether
    // this reply passes the gate. A null result or streamed error never
    // acks, so the retry sees the notes again.
    if (deliveryNotes && sawUsableResult && !sawStreamedError) {
      deferDeliveryNoteAck(chatJid, deliveryNotes.ids);
    }
    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = getProcessableChatJids();
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const resolved = resolveRegisteredGroup(chatJid);
          if (!resolved) continue;
          const { group } = resolved;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (
            needsTrigger &&
            !messagesContainTrigger(
              groupMessages,
              group,
              resolved.registeredJid,
            )
          ) {
            continue;
          }

          // Freeze one inbound boundary per delivery. Newer messages queue
          // behind it instead of entering an active agent session and moving
          // the cursor past an unconfirmed reply. The debounce window lets a
          // quick burst of messages land in one turn.
          queue.enqueueMessageCheck(chatJid, {
            debounceMs: MESSAGE_DEBOUNCE_MS,
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const chatJid of getProcessableChatJids()) {
    const resolved = resolveRegisteredGroup(chatJid);
    if (!resolved) continue;
    const { group } = resolved;
    const pending = getPendingMessages(chatJid);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  // Before anything starts: a real program repo needs real identity settings.
  assertIdentitySettingsConfigured();

  // The host-owned repository must not sit inside the agent's checkout.
  const hostRepoProblem = hostRepoPlacementProblem();
  if (hostRepoProblem) throw new Error(hostRepoProblem);
  // Create it on the first start after an upgrade (local; no network).
  try {
    ensureHostRepo();
  } catch (err) {
    logger.error(
      { err },
      'Host repo could not be created; audit entries will not be committed. ' +
        'Set PROGRAM_HOST_REPO to a folder the checkout owner can create.',
    );
  }
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    resolveProxyBindHost(),
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // Awaited in full: the git steps are separate processes, each bounded by
    // its own 30s timeout, and exiting early would strand a pull mid-rebase
    // with nobody left to run `rebase --abort`. pm2's kill_timeout caps
    // this; ecosystem.config.cjs sizes it to the worst case (450 s).
    await flushAuditLog();
    proxyServer.close();
    await shutdownOutboundEmailQueue(10000);
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await sendImmediate(channel, chatJid, result.url);
      } else {
        await sendImmediate(
          channel,
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await sendImmediate(channel, chatJid, 'Remote Control session ended.');
      } else {
        await sendImmediate(channel, chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (
      chatJid: string,
      msg: NewMessage,
      deliveryContext?: unknown,
    ) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        resolveRegisteredGroup(chatJid)
      ) {
        const resolved = resolveRegisteredGroup(chatJid)!;
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(resolved.registeredJid, cfg) &&
          !isSenderAllowed(resolved.registeredJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage({
        ...msg,
        ...(deliveryContext !== undefined
          ? { delivery_context: deliveryContext }
          : {}),
      });
      // Audit log: record every inbound message
      logInbound(msg.chat_jid, msg.sender_name || msg.sender, msg.content);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    // G46 startup backstop: a channel with no declared (or unknown) delivery
    // profile must never connect and transmit ungated.
    assertGateProfile(channel.name, channel.gateProfile);
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Owner alert channel for dead-letters and delivery shortfalls.
  const resolveDeadLetterJid = () =>
    process.env.DEAD_LETTER_ALERT_JID ||
    readEnvFile(['DEAD_LETTER_ALERT_JID']).DEAD_LETTER_ALERT_JID ||
    TELEGRAM_OWNER_JID;

  // THROWS on a missing channel or a failed send. Callers that treat this as
  // fire-and-forget catch it themselves; the shortfall-alert replay layer needs
  // the rejection, because a swallowed failure there reads as a confirmed
  // delivery and drops the alert permanently (round-3 review P1).
  // This is the Telegram route. sendDeadLetterAlert follows ADMIN_ALERT_ROUTE
  // (admin-alert.ts) and keeps the same contract: it rejects when no route
  // delivered the alert.
  const sendViaAlertChannel = async (text: string): Promise<void> => {
    const alertJid = resolveDeadLetterJid();
    const alertChannel = findChannel(channels, alertJid);
    if (!alertChannel) {
      logger.error({ alertJid }, 'Alert: no channel owns the alert JID');
      throw new Error(`No channel owns the alert JID ${alertJid}`);
    }
    const outcome = await sendImmediate(alertChannel, alertJid, text);
    if (outcome.status === 'failed') {
      logger.error(
        { alertJid, reason: outcome.reason, retryable: outcome.retryable },
        'Alert delivery failed',
      );
      throw new Error(`Alert delivery failed: ${outcome.reason}`);
    }
  };
  sendDeadLetterAlert = createThrowingAdminAlerter(sendViaAlertChannel);
  checkAdminAlertConfig();

  // G46 delivery completeness: any email fan-out shortfall (intended vs
  // actually-sent recipients) alerts the owner naming the missed recipients —
  // never silent partial success.
  setDeliveryShortfallAlerter(
    adminShortfallAlerter((text, opts) => sendDeadLetterAlert(text, opts)),
  );

  // A failed knowledge-base push, or agent commits the host refused to take,
  // go to the same operator channel (host-repo.ts).
  setHostRepoAlerter((text) => sendDeadLetterAlert(text));

  // Start the durable email outbox queue only AFTER the owner alert channel is
  // wired, so replayed terminal outcomes and retained shortfalls alert the owner.
  startOutboundEmailQueue();

  // First start: ADMIN_ALERT_TEST=1 sends one test alert on each enabled
  // route and logs each result. Process environment only.
  if (process.env.ADMIN_ALERT_TEST === '1') {
    void sendTestAdminAlerts({
      telegram: (text) =>
        sendViaAlertChannel(text).then(
          () => 'sent' as const,
          () => 'failed-transient' as const,
        ),
    });
  }

  /**
   * G46-gated send for non-streaming paths (scheduler forwards, IPC
   * messages): validates against the owning channel's declared profile.
   * Refusal never transmits — it logs and alerts the owner (these paths
   * have no cursor to roll back, so the alert IS the loud failure).
   */
  const sendGated = async (
    jid: string,
    rawText: string,
    context: string,
  ): Promise<void> => {
    const channel = findChannel(channels, jid);
    if (!channel) {
      logger.warn({ jid, context }, 'No channel owns JID, cannot send message');
      return;
    }
    const emailGateContext =
      channel.gateProfile.name === 'email'
        ? await resolveEmailGateContext()
        : undefined;
    const gate = channel.gateProfile.validate(rawText, emailGateContext);
    if (!gate.ok) {
      logger.error(
        {
          jid,
          context,
          channel: channel.name,
          profile: channel.gateProfile.name,
          reason: formatGateRefusal(gate),
          sample: rawText.slice(0, 160),
        },
        'Delivery gate refused send (G46) — message NOT transmitted',
      );
      sendDeadLetterAlert(
        `⚠️ Coordinator delivery gate refused an outbound ${channel.gateProfile.name} message (${context}, ${jid}): ${formatGateRefusal(gate)}. The message was NOT sent — check PM2 logs.`,
      ).catch((err) =>
        logger.error({ err, jid }, 'Gate-refusal alert send failed'),
      );
      return;
    }
    if (gate.text) {
      const outcome = await sendImmediate(
        channel,
        jid,
        gate.text,
        undefined,
        emailGateContext,
      );
      if (outcome.status === 'failed') {
        logger.error(
          { jid, context, reason: outcome.reason },
          'Gated direct send failed',
        );
      }
    }
  };

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: (jid, rawText) => sendGated(jid, rawText, 'scheduler'),
  });
  startIpcWatcher({
    sendMessage: (jid, text) => sendGated(jid, text, 'ipc'),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag) => writeGroupsSnapshot(gf, im, ag),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, tasks);
      }
    },
  });
  startSessionCleanup();
  startDeliveryCheck({
    timezone: TIMEZONE,
    // Late-bound: sendDeadLetterAlert is reassigned once channels connect.
    notify: (text) => sendDeadLetterAlert(text),
    logProblem: logDeliveryProblem,
  });
  // A model provider change (failover or return) goes to the operator.
  // Fire-and-forget: a failed alert must not affect the run that caused it.
  setProviderChangeNotifier((text) => {
    sendDeadLetterAlert(text).catch((err) =>
      logger.error({ err }, 'Model provider change alert send failed'),
    );
  });
  queue.setProcessMessagesFn(processGroupMessages);
  // Surface silent message drops (retries exhausted) to the owner's Telegram DM.
  queue.setDeadLetterFn((groupJid) => {
    sendDeadLetterAlert(
      `⚠️ Coordinator dead-letter: messages for ${groupJid} failed all retries and were dropped WITHOUT a reply. An inbound message went unanswered — check PM2 logs / the audit log.`,
    ).catch((err) =>
      logger.error({ groupJid, err }, 'Dead-letter alert send failed'),
    );
  });
  // RC-018: remember each group's last allowlist snapshot across restarts so
  // the outbox replay below can still detect an allowlist advance.
  hydrateAllowlistSnapshots(path.join(DATA_DIR, 'allowlist-snapshots'));
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
