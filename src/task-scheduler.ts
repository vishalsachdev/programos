import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  SCHEDULER_POLL_INTERVAL,
  TELEGRAM_OWNER_JID,
  TIMEZONE,
} from './config.js';
import { exportEvalReport } from './eval-tracker.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeIpcFile,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  getTaskRunsSince,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { parseActionItemSections } from './behaviour-sensor.js';
import { buildOutreachRecipientRoster } from './outreach-recipient-roster.js';
import { buildExceptionsReport } from './exceptions-report.js';
import { getRepoReader } from './repo-reader.js';
import {
  maskRoutedActionItems,
  OPEN_QUESTIONS_PATH,
} from './routed-approvals.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { ensureDirInTree } from './host-fs-safety.js';
import {
  loadWorkingContextAsync,
  resolveAdminUserKey,
} from './working-context.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { localWeekdayDate } from './timezone.js';
import {
  sendOutboundEmailResult,
  type OutboundEmailResult,
} from './outbound-email.js';
import {
  isApprovedEmailOutreachTask,
  MAX_OUTREACH_BATCH,
  parseOutreachBatch,
} from './send-email-capability.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

/**
 * Where outreach summaries / failure alerts go. The outreach task's own
 * chat_jid is the base email JID (webhook-email@program), which has no reply
 * metadata — messages to it are dropped. Default to the owner's Telegram DM
 * (deterministic delivery), overridable via OUTREACH_SUMMARY_JID.
 */
function outreachSummaryJid(): string {
  return (
    process.env.OUTREACH_SUMMARY_JID ||
    readEnvFile(['OUTREACH_SUMMARY_JID']).OUTREACH_SUMMARY_JID ||
    TELEGRAM_OWNER_JID
  );
}

/**
 * Host-side send step for the approved weekly outreach run (R2): the run
 * composes its batch as structured output; the host validates and sends.
 * Returns the summary that becomes the task's logged result.
 */
export async function processOutreachResult(
  task: ScheduledTask,
  result: string | null,
  sendMessage: (jid: string, text: string) => Promise<void>,
  expectedRecipients?: string[] | null,
): Promise<string> {
  // A failed summary delivery must not error a run whose emails already went
  // out — log it; the digest's task_run_logs row still records the outcome.
  const notify = async (text: string) => {
    try {
      await sendMessage(outreachSummaryJid(), text);
    } catch (err) {
      logger.error(
        { err, taskId: task.id, summaryJid: outreachSummaryJid() },
        'Outreach summary delivery failed',
      );
    }
  };

  if (!result) {
    const msg = 'Outreach run produced no output — no emails sent.';
    logger.error({ taskId: task.id }, msg);
    await notify(`⚠️ ${msg}`);
    return msg;
  }
  const batch = parseOutreachBatch(result);
  if (!batch) {
    // Fail loud (the 04-13 lesson): a malformed batch must not no-op quietly.
    const msg =
      'Outreach batch unparseable — no emails sent. See task run log.';
    logger.error({ taskId: task.id, resultPreview: result.slice(0, 200) }, msg);
    await notify(`⚠️ ${msg}`);
    return `${msg}\n\nRaw output (truncated):\n${result.slice(0, 500)}`;
  }

  if (expectedRecipients === null) {
    const msg =
      'Outreach recipient roster unavailable — no emails sent. Check the repo mirror and roster inputs.';
    logger.error({ taskId: task.id }, msg);
    await notify(`⚠️ ${msg}`);
    return msg;
  }

  if (expectedRecipients) {
    if (expectedRecipients.length > MAX_OUTREACH_BATCH) {
      const msg = `Outreach audience has ${expectedRecipients.length} recipients, above the ${MAX_OUTREACH_BATCH}-email safety cap — no emails sent.`;
      logger.error({ taskId: task.id, expectedRecipients }, msg);
      await notify(`⚠️ ${msg}`);
      return msg;
    }
    const normalizedExpected = expectedRecipients.map((email) =>
      email.trim().toLowerCase(),
    );
    const expected = new Set(normalizedExpected);
    if (expected.size !== normalizedExpected.length) {
      const msg =
        'Outreach host recipient roster is invalid (duplicate email) — no emails sent.';
      logger.error({ taskId: task.id, expectedRecipients }, msg);
      await notify(`⚠️ ${msg}`);
      return msg;
    }

    const copied = batch.emails
      .map((email) => email.cc?.trim())
      .filter((cc): cc is string => Boolean(cc));
    if (copied.length > 0) {
      const msg = `Outreach copied recipients are not permitted — no emails sent. CC: ${copied.join('; ')}`;
      logger.error({ taskId: task.id, copied }, msg);
      await notify(`⚠️ ${msg}`);
      return msg;
    }

    const actualList = batch.emails.map((email) =>
      email.to.trim().toLowerCase(),
    );
    const actual = new Set(actualList);
    const missing = [...expected].filter((email) => !actual.has(email));
    const unexpected = [...actual].filter((email) => !expected.has(email));
    const duplicates = actualList.filter(
      (email, index) => actualList.indexOf(email) !== index,
    );

    if (missing.length > 0 || unexpected.length > 0 || duplicates.length > 0) {
      const details = [
        ...(missing.length > 0 ? [`Missing: ${missing.join('; ')}`] : []),
        ...(unexpected.length > 0
          ? [`Unexpected: ${unexpected.join('; ')}`]
          : []),
        ...(duplicates.length > 0
          ? [`Duplicated: ${[...new Set(duplicates)].join('; ')}`]
          : []),
      ];
      const msg = `Outreach audience mismatch — no emails sent. ${details.join(' ')}`;
      logger.error({ taskId: task.id, missing, unexpected, duplicates }, msg);
      await notify(`⚠️ ${msg}`);
      return msg;
    }
  }

  const capped = batch.emails.slice(0, MAX_OUTREACH_BATCH);
  const overCap = batch.emails.length - capped.length;
  if (overCap > 0) {
    logger.warn(
      { taskId: task.id, overCap },
      'Outreach batch exceeded cap; excess dropped',
    );
  }

  const batchId = `outreach:${task.id}:${task.next_run || Date.now()}`;

  let sent = 0;
  const failedRecipients: string[] = [];
  for (let i = 0; i < capped.length; i++) {
    const email = capped[i];
    const result: OutboundEmailResult = await sendOutboundEmailResult(email, {
      sourceGroup: task.group_folder,
      forceBotReplyTo: true,
      lane: 'bulk',
      batchId,
      position: i,
      deliveryId: `${batchId}:${i}`,
    });
    if (result.status === 'sent') sent++;
    else failedRecipients.push(email.to);
  }
  const failed = failedRecipients.length;

  // G46 delivery completeness: a partial batch is never summarized as a bare
  // count — the missed recipients are NAMED so the shortfall is unmissable
  // (sendOutboundEmail also fires the owner shortfall alert per recipient).
  const summary = [
    `${failed > 0 ? '⚠️ ' : ''}Outreach: ${sent} sent, ${failed} blocked/failed${overCap > 0 ? `, ${overCap} over the ${MAX_OUTREACH_BATCH}-email cap` : ''}.`,
    ...(failed > 0 ? [`NOT delivered to: ${failedRecipients.join('; ')}`] : []),
    batch.summary,
  ].join('\n');
  await notify(summary);
  return summary;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  ensureDirInTree(groupDir);

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  writeTasksSnapshot(task.group_folder, isMain, getAllTasks());

  // Write eval report to IPC so quality-review/knowledge-builder tasks can read it.
  // Only generate for main group (to avoid leaking cross-group eval data) and only
  // for tasks that actually need it (avoids blocking the event loop on every task).
  const needsEvalReport =
    isMain &&
    typeof task.prompt === 'string' &&
    /quality.review|knowledge.builder|eval.report/i.test(task.prompt);

  if (needsEvalReport) {
    try {
      const since = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const report = exportEvalReport(since);
      writeIpcFile(task.group_folder, 'eval_report.md', report);
    } catch (err) {
      logger.debug(
        { err, group: task.group_folder },
        'Eval report write skipped',
      );
    }
  }

  // Exceptions digest: the report needs host-only data (task_run_logs, the
  // read mirror), so the host computes it and the task's container script
  // just reads the JSON — same pre-write pattern as eval_report.md above.
  const needsExceptionsReport =
    isMain &&
    typeof task.prompt === 'string' &&
    /exceptions.digest/i.test(task.prompt);

  if (needsExceptionsReport) {
    try {
      const since = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const workingContextEntries = await loadWorkingContextAsync(
        resolveAdminUserKey(),
      );
      const report = buildExceptionsReport({
        reader: getRepoReader(),
        taskRuns: getTaskRunsSince(since),
        pausedTasks: getAllTasks()
          .filter((t) => t.status === 'paused')
          .map((t) => ({ id: t.id, promptPreview: t.prompt.slice(0, 80) })),
        timeZone: TIMEZONE,
        alwaysWake: process.env.EXCEPTIONS_DIGEST_ALWAYS === '1',
        // Handoff register (G42-adjacent): pending handoffs live in the
        // private WORKING layer, which the report never reads itself — it
        // stays pure/testable, the caller does the I/O. Admin key only,
        // matching resolveWorkingContextUser's privacy gate; a missing,
        // corrupt, or badly-keyed store loads as [] rather than throwing.
        workingContextEntries,
      });
      // Single line, never pretty-printed: the agent-runner parses only the
      // LAST stdout line of the task script as JSON, and the recommended
      // script is `cat` on this file — a multi-line write would make the
      // parser see "}" and silently skip the digest.
      writeIpcFile(
        task.group_folder,
        'exceptions_report.json',
        JSON.stringify(report) + '\n',
      );
    } catch (err) {
      logger.warn(
        { err, group: task.group_folder },
        'Exceptions report write failed',
      );
    }
  }

  // Action-item alert: pin per-recipient open counts to the SAME deterministic
  // per-owner index the behaviour sensor uses, so the composed alert states
  // exact counts instead of hand-tallying ACTION_ITEMS.md (which drifts and
  // misstates an owner's count). Host computes;
  // the composer reads /workspace/ipc/action_item_counts.json and must use the
  // count verbatim per owner rather than recounting. Not gated on isMain: the
  // alert runs in the program-email group, and per-owner open counts are not
  // cross-group-sensitive.
  // Fire for the approved outreach task (immutable host-owned id — the task
  // whose composed batch the host actually sends) OR any task whose prompt
  // invokes the action-item nudge by phrasing. Gating on a single
  // prompt phrase ("...alert") would miss the documented "Run weekly action
  // item review" wording / the paused review task and silently fall back to
  // hand-counting.
  // Only the non-main email task whose id is pinned in host configuration can
  // enter the privileged outreach path. Keep this single decision authoritative
  // for roster generation, composition, and host-side delivery.
  const isApprovedOutreach = !isMain && isApprovedEmailOutreachTask(task.id);
  const needsActionItemCounts =
    isApprovedOutreach ||
    (typeof task.prompt === 'string' &&
      /action.?items?[\s\S]{0,40}(alert|review|nudge|check-?in)/i.test(
        task.prompt,
      ));

  let expectedOutreachRecipients: string[] | null | undefined =
    isApprovedOutreach ? null : undefined;
  if (needsActionItemCounts) {
    try {
      getRepoReader().refresh();
      const rawActionItems = getRepoReader().readFile(
        'discussions/ACTION_ITEMS.md',
      );
      // Routed approvals: an item waiting on an approver is not counted for
      // its owner while the Routed Approvals entry is open.
      // The counts and roster read a masked copy; the KB file
      // is unchanged.
      const masked = rawActionItems
        ? maskRoutedActionItems(
            rawActionItems,
            getRepoReader().readFile(OPEN_QUESTIONS_PATH),
          )
        : null;
      const md = masked?.markdown ?? null;
      const counts = md
        ? Object.fromEntries(
            parseActionItemSections(md).map((s) => [s.owner, s.openCount]),
          )
        : {};
      writeIpcFile(
        task.group_folder,
        'action_item_counts.json',
        JSON.stringify({
          note: 'Authoritative per-owner OPEN action-item counts (unchecked "- [ ]" lines), computed deterministically by the host. Use these verbatim; do not recount ACTION_ITEMS.md.',
          counts,
          excludedRoutedItems: masked?.skipped ?? [],
          excludedRoutedItemsNote:
            'These open items wait on an approver (OPEN_QUESTIONS.md, Routed Approvals). They are not in the counts. Do not list them in any nudge.',
        }) + '\n',
      );

      if (isApprovedOutreach) {
        const allowlist = getRepoReader().readFile(
          'program/EMAIL_ALLOWLIST.md',
        );
        if (!md || !allowlist) {
          throw new Error(
            'ACTION_ITEMS.md or EMAIL_ALLOWLIST.md unavailable for outreach roster',
          );
        }
        const roster = buildOutreachRecipientRoster(md, allowlist);
        expectedOutreachRecipients = roster.recipients.map(
          (recipient) => recipient.email,
        );
        writeIpcFile(
          task.group_folder,
          'action_item_recipients.json',
          JSON.stringify({
            note: 'Authoritative Monday outreach audience. Compose exactly one email for every recipient and no one else. Use delivery=digest for Avery and delivery=nudge for owners.',
            ...roster,
          }) + '\n',
        );
      }
    } catch (err) {
      logger.warn(
        { err, group: task.group_folder },
        'Action-item outreach artifact write failed',
      );
    }
  }

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;
  // Approved-outreach detection is keyed to the immutable, host-owned task id
  // from .env (EMAIL_OUTREACH_TASK_ID) — never to task shape, which agents
  // can write via IPC. The run composes its batch; the HOST sends afterwards
  // (processOutreachResult). No send capability exists inside the container.
  const taskPrompt = isApprovedOutreach
    ? [
        'Run the weekly Monday action-item alert using the email-outreach skill and its compose-batch contract.',
        'Treat /workspace/ipc/action_item_recipients.json as the sole authoritative audience. Compose exactly one email for every recipient in that file and no one else.',
        'Treat /workspace/ipc/action_item_counts.json as the authoritative open-item counts. Use delivery=digest for Avery and delivery=nudge for owners.',
        'Do not use any fixed recipient list or audience restriction from the saved scheduled-task prompt; the live host-computed roster replaces it.',
        "For each owner nudge, include the top three open items and the total open count. In Avery's digest, summarize open counts by owner and who was nudged.",
        "Never list an item named in excludedRoutedItems (in action_item_counts.json): it waits on an approver and is not the owner's to act on.",
        'Write dates in full. Your final output must be exactly one JSON object: {"emails": [...], "summary": "..."}, with nothing before or after it.',
      ].join('\n\n')
    : task.prompt;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        // Weekday-qualified date so the task agent never derives weekdays
        // from memory (message-triggered runs get the same via formatMessages).
        prompt: `Current date: ${localWeekdayDate(TIMEZONE)} (timezone: ${TIMEZONE}).\n\n${taskPrompt}`,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        // A prior prompt-injected run could have tampered the group's cached
        // runner source (it persists, mtime-gated). Never let the outreach
        // composer run execute a stale cache.
        forceRunnerRefresh: isApprovedOutreach,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user (sendMessage handles formatting). The
          // approved outreach run's raw output is the email batch JSON — it
          // is processed host-side after the run, not forwarded.
          if (!isApprovedOutreach) {
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  if (isApprovedOutreach && !error) {
    try {
      result = await processOutreachResult(
        task,
        result,
        deps.sendMessage,
        expectedOutreachRecipients,
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      logger.error({ taskId: task.id, error }, 'Outreach send step failed');
    }
  } else if (isApprovedOutreach && error) {
    // A crashed outreach container must not fail silently until next week.
    try {
      await deps.sendMessage(
        outreachSummaryJid(),
        `⚠️ Outreach run failed (container error): ${error}`,
      );
    } catch (err) {
      logger.error(
        { err, taskId: task.id },
        'Outreach failure notification could not be delivered',
      );
    }
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
