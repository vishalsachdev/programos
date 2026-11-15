import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { logGateResult } from './audit-log.js';
import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { ensureDirInTree, readFileInTree } from './host-fs-safety.js';
import { logger } from './logger.js';
import { sendOutboundEmail } from './outbound-email.js';
import { isProtectedTaskMutation } from './send-email-capability.js';
import { isWeekendCalendarDate } from './timezone.js';
import { RegisteredGroup } from './types.js';

/**
 * Whether a `once` schedule_value (local time, "YYYY-MM-DDTHH:mm:ss")
 * fires on a Saturday or Sunday. The leading calendar date is already in
 * the operator timezone, so no conversion is needed.
 */
function isWeekendOnceValue(value: string | undefined): boolean {
  const ymd = value?.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  return ymd !== undefined && isWeekendCalendarDate(ymd);
}

/**
 * Next fire time (ISO) for a schedule, or null when the value is invalid for
 * its type (or the type is unrecognized). Shared by the schedule_task and
 * update_task paths so both validate identically.
 *
 * Interval values must be pure digits: parseInt('2026-06-16T10:00:00') is
 * 2026, which would silently turn a date-like value into a 2-second interval.
 */
function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
): string | null {
  if (scheduleType === 'cron') {
    try {
      return CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE })
        .next()
        .toISOString();
    } catch {
      return null;
    }
  }
  if (scheduleType === 'interval') {
    if (!/^\d+$/.test(scheduleValue)) return null;
    const ms = parseInt(scheduleValue, 10);
    return ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
  }
  if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    return isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
  ) => void;
  onTasksChanged: () => void;
}

/**
 * Drain every *.json file from an IPC subdirectory, invoking `handle` on each
 * parsed payload and deleting the file on success. A payload that throws is
 * quarantined to ipc/errors/ rather than retried forever. Shared by the
 * messages and tasks scan loops, which differ only in their handler.
 */
export async function drainIpcDir(
  dir: string,
  ipcBaseDir: string,
  sourceGroup: string,
  label: string,
  handle: (data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  // data/ipc/<group> is agent-writable: refuse a linked subdirectory, and
  // read each message without following a link or blocking on a FIFO.
  const groupRoot = path.join(ipcBaseDir, sourceGroup);
  const relDir = path.relative(groupRoot, dir);
  try {
    if (!fs.existsSync(dir)) return;
    ensureDirInTree(groupRoot, relDir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const raw = readFileInTree(groupRoot, path.join(relDir, file));
        if (raw === null) continue; // consumed meanwhile
        const data = JSON.parse(raw);
        await handle(data);
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.error(
          { file, sourceGroup, err },
          `Error processing IPC ${label}`,
        );
        const errorDir = path.join(ipcBaseDir, 'errors');
        fs.mkdirSync(errorDir, { recursive: true });
        fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
      }
    }
  } catch (err) {
    logger.error({ err, sourceGroup }, `Error reading IPC ${label} directory`);
  }
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      await drainIpcDir(
        messagesDir,
        ipcBaseDir,
        sourceGroup,
        'message',
        async (data) => {
          if (data.type === 'message' && data.chatJid && data.text) {
            const chatJid = data.chatJid as string;
            // Authorization: verify this group can send to this chatJid
            const targetGroup = registeredGroups[chatJid];
            if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
              await deps.sendMessage(chatJid, data.text as string);
              logger.info({ chatJid, sourceGroup }, 'IPC message sent');
            } else {
              logger.warn(
                { chatJid, sourceGroup },
                'Unauthorized IPC message attempt blocked',
              );
            }
          }
        },
      );

      // Process tasks from this group's IPC directory
      await drainIpcDir(
        tasksDir,
        ipcBaseDir,
        sourceGroup,
        'task',
        // Pass source group identity to processTaskIpc for authorization
        (data) =>
          processTaskIpc(
            data as Parameters<typeof processTaskIpc>[0],
            sourceGroup,
            isMain,
            deps,
          ),
      );
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    weekendConfirmed?: boolean;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For send_email
    to?: string;
    cc?: string;
    subject?: string;
    body?: string;
    reply_to?: string;
    // For log_gate_result (G51)
    gate?: string;
    status?: string;
    exit_code?: number;
    entry_heading?: string;
    result?: unknown;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        // The approved email-outreach task id cannot be squatted by agents:
        // a task created under that id would inherit the send_email grant.
        if (isProtectedTaskMutation(data.taskId, isMain)) {
          logger.warn(
            { sourceGroup, taskId: data.taskId },
            'Blocked schedule_task on the approved email-outreach task id',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        const nextRun = computeNextRun(scheduleType, data.schedule_value);
        if (nextRun === null) {
          logger.warn(
            { scheduleType, scheduleValue: data.schedule_value },
            'Invalid schedule value for schedule_task',
          );
          break;
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        // Weekend backstop: the container schedule_task tool gates weekend
        // once-dates behind confirm_date and sets weekendConfirmed. A payload
        // arriving without it (stale cached runner) is created PAUSED — it
        // shows up in list_tasks and the weekly exceptions digest instead of
        // firing on a likely mis-derived date or being silently dropped.
        let status: 'active' | 'paused' = 'active';
        if (
          scheduleType === 'once' &&
          data.weekendConfirmed !== true &&
          isWeekendOnceValue(data.schedule_value)
        ) {
          status = 'paused';
          logger.warn(
            { taskId, sourceGroup, scheduleValue: data.schedule_value },
            'Unconfirmed weekend once-task created paused',
          );
        }
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status,
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        if (isProtectedTaskMutation(data.taskId, isMain)) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Blocked resume of the approved email-outreach task (host/main only)',
          );
          break;
        }
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        // Cancel-then-recreate is the id-squatting path to an email grant.
        if (isProtectedTaskMutation(data.taskId, isMain)) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Blocked cancel of the approved email-outreach task (host/main only)',
          );
          break;
        }
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }
        // The approved outreach task's prompt/schedule are host-owned: an
        // agent edit would run arbitrary instructions WITH the email grant.
        if (isProtectedTaskMutation(data.taskId, isMain)) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Blocked update of the approved email-outreach task (host/main only)',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          const nextRun = computeNextRun(
            updatedTask.schedule_type,
            updatedTask.schedule_value,
          );
          if (nextRun === null) {
            logger.warn(
              {
                taskId: data.taskId,
                type: updatedTask.schedule_type,
                value: updatedTask.schedule_value,
              },
              'Invalid schedule value in task update',
            );
            break;
          }
          updates.next_run = nextRun;
          // Weekend backstop (once only): an unconfirmed retarget onto a
          // weekend date pauses the task for review. Only when the fire date
          // itself changed — a prompt edit that redundantly restates
          // schedule_type must not pause an intentional (already-confirmed)
          // weekend task.
          if (
            updatedTask.schedule_type === 'once' &&
            data.schedule_value !== undefined &&
            data.weekendConfirmed !== true &&
            isWeekendOnceValue(updatedTask.schedule_value)
          ) {
            updates.status = 'paused';
            logger.warn(
              { taskId: data.taskId, value: updatedTask.schedule_value },
              'Unconfirmed weekend once-retarget — task paused',
            );
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(sourceGroup, true, availableGroups);
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'send_email': {
      // Main group only. Scheduled outreach does NOT send through IPC: the
      // approved task composes its batch as structured output and the HOST
      // sends after the run (task-scheduler.ts → outbound-email.ts). The
      // group IPC dir is shared across concurrent containers of a group, so
      // no in-container grant can be attributed safely.
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized send_email attempt blocked — non-main group',
        );
        break;
      }

      if (!data.to || !data.subject || !data.body) {
        logger.warn(
          {
            sourceGroup,
            to: data.to,
            subject: !!data.subject,
            body: !!data.body,
          },
          'send_email missing required fields',
        );
        break;
      }

      await sendOutboundEmail(
        {
          to: data.to,
          cc: data.cc,
          subject: data.subject,
          body: data.body,
          reply_to: data.reply_to,
        },
        { sourceGroup, forceBotReplyTo: false },
      );
      break;
    }

    case 'log_gate_result':
      // G51 phase 1: container agents report each KB-gate script run
      // (kb-conflict-check ingestion cross-check, kb-entry-gate) so the
      // JSON verdict lands durably in the host-side audit log. Any group
      // may log its own gate runs — this is an append-only record
      // attributed to the verified sourceGroup, not a privilege.
      if (typeof data.gate === 'string' && typeof data.status === 'string') {
        logGateResult({
          sourceGroup,
          gate: data.gate,
          script: data.script || undefined,
          status: data.status,
          exitCode:
            typeof data.exit_code === 'number' ? data.exit_code : undefined,
          entryHeading: data.entry_heading,
          result: data.result,
        });
        logger.info(
          { sourceGroup, gate: data.gate, status: data.status },
          'Gate result logged via IPC',
        );
      } else {
        logger.warn(
          { sourceGroup, data },
          'Invalid log_gate_result payload — gate and status are required',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
