import { ChildProcess } from 'child_process';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { writeFileInTree } from './host-fs-safety.js';
import { logger } from './logger.js';
import type { ProcessMessagesResult } from './delivery-processor.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn:
    | ((groupJid: string) => Promise<boolean | ProcessMessagesResult>)
    | null = null;
  private deadLetterFn: ((groupJid: string) => void) | null = null;
  private shuttingDown = false;
  /** Per-group inbound debounce timers (fixed window from the first message). */
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(
    fn: (groupJid: string) => Promise<boolean | ProcessMessagesResult>,
  ): void {
    this.processMessagesFn = fn;
  }

  /**
   * Invoked when a group's messages are dropped after exhausting MAX_RETRIES.
   * Used to surface an otherwise-silent failure (e.g. Telegram alert to the
   * owner) — "logging is not alerting".
   */
  setDeadLetterFn(fn: (groupJid: string) => void): void {
    this.deadLetterFn = fn;
  }

  /**
   * `debounceMs` (fresh inbound messages only): wait a fixed window from the
   * first message before starting the run, so a quick burst ("…", "also…")
   * becomes one turn. The run reads every pending message from the DB, so
   * messages arriving inside the window join it. The window is not extended
   * by later messages, so the added delay is bounded. Drains, retries and
   * recovery call without it and run at once (also ending any open window).
   */
  enqueueMessageCheck(
    groupJid: string,
    opts: { debounceMs?: number } = {},
  ): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (opts.debounceMs && opts.debounceMs > 0 && !state.active) {
      if (this.debounceTimers.has(groupJid)) return; // joins the open window
      this.debounceTimers.set(
        groupJid,
        setTimeout(() => {
          this.debounceTimers.delete(groupJid);
          this.enqueueMessageCheck(groupJid);
        }, opts.debounceMs),
      );
      logger.debug(
        { groupJid, ms: opts.debounceMs },
        'Inbound debounce window opened',
      );
      return;
    }
    const pendingWindow = this.debounceTimers.get(groupJid);
    if (pendingWindow && !opts.debounceMs) {
      clearTimeout(pendingWindow);
      this.debounceTimers.delete(groupJid);
    }

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer)
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    try {
      // writeFileInTree publishes atomically (temp + rename) and never
      // follows a link the container planted under its IPC directory.
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      writeFileInTree(
        path.join(DATA_DIR, 'ipc', state.groupFolder),
        path.join('input', filename),
        JSON.stringify({ type: 'message', text }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    try {
      writeFileInTree(
        path.join(DATA_DIR, 'ipc', state.groupFolder),
        path.join('input', '_close'),
        '',
      );
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const result = await this.processMessagesFn(groupJid);
        if (result === true) {
          state.retryCount = 0;
        } else if (result === false) {
          this.scheduleRetry(groupJid, state);
        } else if (result.status === 'retry') {
          state.retryCount = 0;
          this.schedulePersistedRetry(groupJid, result.attempt);
        } else {
          state.retryCount = 0;
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      // Surface the silent drop. Guarded so an alert failure never throws into
      // the retry path.
      try {
        this.deadLetterFn?.(groupJid);
      } catch (err) {
        logger.error({ groupJid, err }, 'Dead-letter handler threw');
      }
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private schedulePersistedRetry(groupJid: string, attempt: number): void {
    const safeAttempt = Math.max(1, Math.floor(attempt));
    const delayMs = BASE_RETRY_MS * Math.pow(2, safeAttempt - 1);
    logger.info(
      { groupJid, attempt: safeAttempt, delayMs },
      'Scheduling persisted delivery retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();

    const deadline = Date.now() + _gracePeriodMs;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const activeContainers: string[] = [];
    for (const [, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    if (activeContainers.length > 0) {
      logger.info(
        { activeCount: this.activeCount, detachedContainers: activeContainers },
        'GroupQueue shutdown grace period expired; leaving active containers running',
      );
      return;
    }

    logger.info('GroupQueue shutdown completed with no active containers');
  }
}
