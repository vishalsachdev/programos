import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Weekend once-task backstop: the container-side schedule_task tool gates
// weekend fire dates behind an explicit confirm_date and sets
// weekendConfirmed on the IPC payload. The host backstop catches payloads
// that arrive without it (stale cached runner) — the task is created
// PAUSED, which surfaces it in the weekly exceptions digest instead of
// silently firing on a mis-derived weekend date or silently dropping.

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
  };
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    onTasksChanged: () => {},
  };
});

describe('weekend once-task backstop (schedule_task)', () => {
  it('creates a weekday once task active', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-weekday',
        prompt: 'weekday task',
        schedule_type: 'once',
        schedule_value: '2026-06-15T10:00:00', // Monday
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-weekday')?.status).toBe('active');
  });

  it('creates an unconfirmed weekend once task paused', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-weekend',
        prompt: 'weekend task',
        schedule_type: 'once',
        schedule_value: '2026-06-13T10:00:00', // Saturday
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-weekend')?.status).toBe('paused');
  });

  it('creates a confirmed weekend once task active', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-weekend-ok',
        prompt: 'confirmed weekend task',
        schedule_type: 'once',
        schedule_value: '2026-06-13T10:00:00', // Saturday
        weekendConfirmed: true,
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-weekend-ok')?.status).toBe('active');
  });

  it('does not pause weekend cron tasks (day-of-week is explicit)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-weekend-cron',
        prompt: 'saturday cron',
        schedule_type: 'cron',
        schedule_value: '0 9 * * 6',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-weekend-cron')?.status).toBe('active');
  });

  it('rejects a date-like interval value on create (no lax parseInt)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-bad-interval',
        prompt: 'date-like interval',
        schedule_type: 'interval',
        schedule_value: '2026-06-16T10:00:00', // parseInt would yield 2026ms
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-bad-interval')).toBeUndefined();
  });

  it('rejects an unrecognized schedule_type on create', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        taskId: 'task-bad-type',
        prompt: 'bad type',
        schedule_type: 'daily',
        schedule_value: '10',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-bad-type')).toBeUndefined();
  });
});

describe('weekend once-task backstop (update_task)', () => {
  beforeEach(() => {
    createTask({
      id: 'task-existing',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'existing',
      script: null,
      schedule_type: 'once',
      schedule_value: '2026-06-15T10:00:00',
      context_mode: 'isolated',
      next_run: '2026-06-15T15:00:00.000Z',
      status: 'active',
      created_at: '2026-06-12T00:00:00.000Z',
    });
  });

  it('recomputes next_run when a once schedule_value is updated', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-existing',
        schedule_value: '2026-06-16T10:00:00', // Tuesday
      },
      'other-group',
      false,
      deps,
    );
    const task = getTaskById('task-existing');
    expect(task?.schedule_value).toBe('2026-06-16T10:00:00');
    expect(task?.next_run).not.toBe('2026-06-15T15:00:00.000Z');
    expect(new Date(task!.next_run!).getTime()).toBe(
      new Date('2026-06-16T10:00:00').getTime(),
    );
  });

  it('pauses on unconfirmed weekend retarget', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-existing',
        schedule_value: '2026-06-14T10:00:00', // Sunday
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-existing')?.status).toBe('paused');
  });

  it('keeps a confirmed weekend retarget active', async () => {
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-existing',
        schedule_value: '2026-06-14T10:00:00', // Sunday
        weekendConfirmed: true,
      },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-existing')?.status).toBe('active');
  });
});

describe('codex P2 regressions', () => {
  it('does not pause a weekend task on a prompt-only update restating schedule_type', async () => {
    createTask({
      id: 'task-weekend-intentional',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'deliberate saturday task',
      script: null,
      schedule_type: 'once',
      schedule_value: '2026-06-13T10:00:00', // Saturday, already confirmed
      context_mode: 'isolated',
      next_run: '2026-06-13T15:00:00.000Z',
      status: 'active',
      created_at: '2026-06-12T00:00:00.000Z',
    });
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-weekend-intentional',
        prompt: 'new prompt',
        schedule_type: 'once', // redundant restatement, no new date
      },
      'other-group',
      false,
      deps,
    );
    const task = getTaskById('task-weekend-intentional');
    expect(task?.prompt).toBe('new prompt');
    expect(task?.status).toBe('active');
  });

  it('rejects a date-like schedule_value on an interval task', async () => {
    createTask({
      id: 'task-interval',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'interval task',
      script: null,
      schedule_type: 'interval',
      schedule_value: '3600000',
      context_mode: 'isolated',
      next_run: '2026-06-12T15:00:00.000Z',
      status: 'active',
      created_at: '2026-06-12T00:00:00.000Z',
    });
    await processTaskIpc(
      {
        type: 'update_task',
        taskId: 'task-interval',
        schedule_value: '2026-06-16T10:00:00', // would parseInt to 2026ms
      },
      'other-group',
      false,
      deps,
    );
    const task = getTaskById('task-interval');
    expect(task?.schedule_value).toBe('3600000'); // update rejected
    expect(task?.next_run).toBe('2026-06-12T15:00:00.000Z');
  });
});
