import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import { parseOutreachBatch } from './send-email-capability.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  processOutreachResult,
  startSchedulerLoop,
} from './task-scheduler.js';
import { ScheduledTask } from './types.js';
import { RegisteredGroup } from './types.js';

const containerRunnerMocks = vi.hoisted(() => ({
  runContainerAgent: vi.fn(),
  writeIpcFile: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent: containerRunnerMocks.runContainerAgent,
  writeIpcFile: containerRunnerMocks.writeIpcFile,
  writeTasksSnapshot: containerRunnerMocks.writeTasksSnapshot,
}));

const outboundEmailMocks = vi.hoisted(() => ({
  sendOutboundEmailResult: vi.fn(),
}));

vi.mock('./outbound-email.js', () => ({
  sendOutboundEmailResult: outboundEmailMocks.sendOutboundEmailResult,
}));

const repoReaderMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => repoReaderMocks,
}));

const OUTREACH_ACTION_ITEMS = `
## Avery Morgan
- [ ] Review the weekly digest

## Lin
- [ ] Finish ELC 550 modules
`;

const OUTREACH_ALLOWLIST = `
## Authorized Senders (Program operating team)
| Name | Email | Title | Access | Role / domain (gatekeeping) |
|------|-------|-------|--------|------------------------------|
| Avery Morgan | avery@example.edu | Director | read-write | **coordinator-cohort: founding** |
| Lin Chen | lchen12@example.edu | Faculty | read-write | **coordinator-cohort: faculty-expansion** |
`;

const EMAIL_GROUP: RegisteredGroup = {
  name: 'Program Email',
  folder: 'program-email',
  trigger: 'always',
  added_at: '2026-03-25T00:00:00.000Z',
};

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    delete process.env.EMAIL_OUTREACH_TASK_ID;
    containerRunnerMocks.runContainerAgent.mockReset();
    containerRunnerMocks.writeTasksSnapshot.mockReset();
    containerRunnerMocks.runContainerAgent.mockResolvedValue({
      status: 'success',
      result: null,
    });
    outboundEmailMocks.sendOutboundEmailResult.mockReset();
    outboundEmailMocks.sendOutboundEmailResult.mockResolvedValue({
      status: 'sent',
      resendId: 'resend-123',
    });
    repoReaderMocks.refresh.mockReset();
    repoReaderMocks.readFile.mockReset();
    repoReaderMocks.readFile.mockImplementation((relPath: string) => {
      if (relPath === 'discussions/ACTION_ITEMS.md') {
        return OUTREACH_ACTION_ITEMS;
      }
      if (relPath === 'program/EMAIL_ALLOWLIST.md') {
        return OUTREACH_ALLOWLIST;
      }
      return null;
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('does not count an item waiting on a routed approval, and names it for the composer', async () => {
    process.env.EMAIL_OUTREACH_TASK_ID = 'weekly-action-item-review';
    repoReaderMocks.readFile.mockImplementation((relPath: string) => {
      if (relPath === 'discussions/ACTION_ITEMS.md') {
        return [
          '## Avery Morgan',
          '- [ ] **Review the weekly digest**',
          '',
          '## Lin',
          '- [ ] **Finish ELC 550 modules** — in progress',
          '- [ ] **Confirm the ELC 550 peer review instrument** — reported done',
        ].join('\n');
      }
      if (relPath === 'program/EMAIL_ALLOWLIST.md') return OUTREACH_ALLOWLIST;
      if (relPath === 'discussions/OPEN_QUESTIONS.md') {
        return [
          '## Routed Approvals',
          '',
          '- [ ] **Routed to Avery Morgan (avery): ELC 550 updates** (Sender: lchen12@example.edu; Approver: avery@example.edu; Raw: discussions/raw/x.md) (Added: 2026-10-24)',
          '  - Affects: ACTION_ITEMS.md § Lin — **Confirm the ELC 550 peer review instrument**',
        ].join('\n');
      }
      return null;
    });
    createTask({
      id: 'weekly-action-item-review',
      group_folder: 'program-email',
      chat_jid: 'webhook-email@program',
      prompt: 'Run weekly action item review.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-25T00:00:00.000Z',
    });
    containerRunnerMocks.runContainerAgent.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({ emails: [], summary: 'none' }),
    });
    containerRunnerMocks.writeIpcFile.mockClear();
    const taskRuns: Promise<void>[] = [];
    startSchedulerLoop({
      registeredGroups: () => ({ 'webhook-email@program': EMAIL_GROUP }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_jid: string, _id: string, fn: () => Promise<void>) => {
            taskRuns.push(fn());
          },
        ),
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    const written = (name: string) =>
      JSON.parse(
        containerRunnerMocks.writeIpcFile.mock.calls.find(
          (call) => call[1] === name,
        )![2] as string,
      );
    const counts = written('action_item_counts.json');
    expect(counts.counts).toEqual({ 'Avery Morgan': 1, Lin: 1 });
    expect(counts.excludedRoutedItems).toEqual([
      {
        section: 'Lin',
        title: 'Confirm the ELC 550 peer review instrument',
        entry: 'Routed to Avery Morgan (avery): ELC 550 updates',
      },
    ]);
    const roster = written('action_item_recipients.json');
    expect(
      roster.recipients.find(
        (r: { email: string }) => r.email === 'lchen12@example.edu',
      ),
    ).toMatchObject({ openCount: 1 });
    const [, input] = containerRunnerMocks.runContainerAgent.mock.calls[0];
    expect(input.prompt).toContain('excludedRoutedItems');
  });

  it('the env-approved outreach run composes a batch and the host sends it', async () => {
    process.env.EMAIL_OUTREACH_TASK_ID = 'weekly-action-item-review';
    createTask({
      id: 'weekly-action-item-review',
      group_folder: 'program-email',
      chat_jid: 'webhook-email@program',
      prompt:
        'Run weekly action item review. Send to exactly stale-person@example.com and nobody else.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-25T00:00:00.000Z',
    });

    containerRunnerMocks.runContainerAgent.mockResolvedValue({
      status: 'success',
      result: JSON.stringify({
        emails: [
          {
            to: 'lchen12@example.edu',
            subject: 'Your open Program action items',
            body: 'You have 3 open items…',
          },
          {
            to: 'avery@example.edu',
            subject: 'Program Weekly Digest — Action Items',
            body: 'Digest…',
          },
        ],
        summary: 'Nudged 1 owner, digest sent.',
      }),
    });

    const sent: string[] = [];
    const taskRuns: Promise<void>[] = [];
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        taskRuns.push(fn());
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({ 'webhook-email@program': EMAIL_GROUP }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async (jid, text) => {
        sent.push(`${jid}|${text}`);
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    expect(containerRunnerMocks.runContainerAgent).toHaveBeenCalledOnce();
    const [, input] = containerRunnerMocks.runContainerAgent.mock.calls[0];
    // The composer run never executes a stale (possibly tampered) runner cache.
    expect(input.forceRunnerRefresh).toBe(true);
    // The live host-computed roster replaces any obsolete fixed audience saved
    // in the scheduled task itself.
    expect(input.prompt).toContain('action_item_recipients.json');
    expect(input.prompt).toContain('sole authoritative audience');
    expect(input.prompt).not.toContain('stale-person@example.com');

    // Host sent both composed emails with forced bot Reply-To in the bulk lane…
    expect(outboundEmailMocks.sendOutboundEmailResult).toHaveBeenCalledTimes(2);
    expect(
      outboundEmailMocks.sendOutboundEmailResult.mock.calls[0][1],
    ).toMatchObject({
      sourceGroup: 'program-email',
      forceBotReplyTo: true,
      lane: 'bulk',
      position: 0,
    });
    expect(
      outboundEmailMocks.sendOutboundEmailResult.mock.calls[1][1],
    ).toMatchObject({
      sourceGroup: 'program-email',
      forceBotReplyTo: true,
      lane: 'bulk',
      position: 1,
    });
    expect(
      outboundEmailMocks.sendOutboundEmailResult.mock.calls[0][1].deliveryId,
    ).toMatch(/^outreach:weekly-action-item-review:/);
    // …and forwarded a summary, not the raw JSON batch.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('tg-avery@program|');
    expect(sent[0]).toContain('Outreach: 2 sent, 0 blocked/failed');
    expect(sent[0]).toContain('Nudged 1 owner');
  });

  it('an unparseable outreach batch fails loud and sends nothing', async () => {
    process.env.EMAIL_OUTREACH_TASK_ID = 'weekly-action-item-review';
    createTask({
      id: 'weekly-action-item-review',
      group_folder: 'program-email',
      chat_jid: 'webhook-email@program',
      prompt: 'Run weekly action item review and send the owner nudges.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-25T00:00:00.000Z',
    });

    containerRunnerMocks.runContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'I emailed everyone, all good!', // prose, not a batch
    });

    const sent: string[] = [];
    const taskRuns: Promise<void>[] = [];
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        taskRuns.push(fn());
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({ 'webhook-email@program': EMAIL_GROUP }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async (jid, text) => {
        sent.push(`${jid}|${text}`);
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('unparseable');
  });

  it('notifies the owner DM when the outreach container errors', async () => {
    process.env.EMAIL_OUTREACH_TASK_ID = 'weekly-action-item-review';
    createTask({
      id: 'weekly-action-item-review',
      group_folder: 'program-email',
      chat_jid: 'webhook-email@program',
      prompt: 'Run weekly action item review and send the owner nudges.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-25T00:00:00.000Z',
    });

    containerRunnerMocks.runContainerAgent.mockResolvedValue({
      status: 'error',
      error: 'container crashed',
    });

    const sent: string[] = [];
    const taskRuns: Promise<void>[] = [];
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        taskRuns.push(fn());
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({ 'webhook-email@program': EMAIL_GROUP }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async (jid, text) => {
        sent.push(`${jid}|${text}`);
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('tg-avery@program|');
    expect(sent[0]).toContain('Outreach run failed');
  });

  it('does not grant send_email to a shape-identical task under a different id (anti-imitation)', async () => {
    process.env.EMAIL_OUTREACH_TASK_ID = 'weekly-action-item-review';
    createTask({
      // Same group, cron, and prompt wording as the approved task — only the
      // host-pinned id differs. Shape must NOT earn a grant.
      id: 'task-agent-created-lookalike',
      group_folder: 'program-email',
      chat_jid: 'webhook-email@program',
      prompt: 'Run weekly action item review and send the owner nudges.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-25T00:00:00.000Z',
    });

    const taskRuns: Promise<void>[] = [];
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        taskRuns.push(fn());
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({ 'webhook-email@program': EMAIL_GROUP }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    expect(containerRunnerMocks.runContainerAgent).toHaveBeenCalledOnce();
    const [, input] = containerRunnerMocks.runContainerAgent.mock.calls[0];
    expect(input.forceRunnerRefresh).toBe(false);
    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
  });

  it('grants nothing when EMAIL_OUTREACH_TASK_ID is unset (fail-closed)', async () => {
    createTask({
      id: 'weekly-action-item-review',
      group_folder: 'program-email',
      chat_jid: 'webhook-email@program',
      prompt: 'Run weekly action item review and send the owner nudges.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * 1',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-03-25T00:00:00.000Z',
    });

    const taskRuns: Promise<void>[] = [];
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        taskRuns.push(fn());
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({ 'webhook-email@program': EMAIL_GROUP }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(taskRuns);

    expect(containerRunnerMocks.runContainerAgent).toHaveBeenCalledOnce();
    const [, input] = containerRunnerMocks.runContainerAgent.mock.calls[0];
    expect(input.forceRunnerRefresh).toBe(false);
    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
  });

  it('parseOutreachBatch accepts bare JSON and fenced JSON, rejects prose and bad shapes', () => {
    const batch = {
      emails: [{ to: 'a@example.edu', subject: 's', body: 'b' }],
      summary: 'ok',
    };

    expect(parseOutreachBatch(JSON.stringify(batch))).toEqual({
      emails: [{ to: 'a@example.edu', cc: undefined, subject: 's', body: 'b' }],
      summary: 'ok',
    });

    const fenced = `Here is the batch:\n\n\`\`\`json\n${JSON.stringify(batch)}\n\`\`\`\n`;
    expect(parseOutreachBatch(fenced)?.emails).toHaveLength(1);

    expect(parseOutreachBatch('I sent the emails!')).toBeNull();
    expect(parseOutreachBatch('{"emails": "nope"}')).toBeNull();
    expect(
      parseOutreachBatch('{"emails": [{"to": "a@b.c"}]}'), // missing subject/body
    ).toBeNull();
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

// --- G46 delivery completeness: partial batch is never a bare count ---

describe('processOutreachResult completeness (G46)', () => {
  const OUTREACH_TASK: ScheduledTask = {
    id: 'weekly-action-item-review',
    group_folder: 'program-email',
    chat_jid: 'webhook-email@program',
    prompt: 'Run weekly action item review.',
    script: null,
    schedule_type: 'cron',
    schedule_value: '0 9 * * 1',
    context_mode: 'isolated',
    next_run: null,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-03-25T00:00:00.000Z',
  };

  beforeEach(() => {
    outboundEmailMocks.sendOutboundEmailResult.mockReset();
  });

  it('a partial batch names the missed recipients in the summary (fail loud)', async () => {
    // First send succeeds, second is blocked/failed.
    outboundEmailMocks.sendOutboundEmailResult
      .mockResolvedValueOnce({ status: 'sent', resendId: 'resend-123' })
      .mockResolvedValueOnce({
        status: 'failed',
        reason: 'to-recipient-not-allowlisted',
        retryable: false,
      });

    const sent: string[] = [];
    const summary = await processOutreachResult(
      OUTREACH_TASK,
      JSON.stringify({
        emails: [
          { to: 'lchen12@example.edu', subject: 'A', body: 'a' },
          { to: 'berg@example.edu', subject: 'B', body: 'b' },
        ],
        summary: 'Two nudges.',
      }),
      async (jid, text) => {
        sent.push(`${jid}|${text}`);
      },
    );

    expect(summary).toContain('⚠️');
    expect(summary).toContain('1 sent, 1 blocked/failed');
    expect(summary).toContain('NOT delivered to: berg@example.edu');
    // The owner notification carries the same named shortfall.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('NOT delivered to: berg@example.edu');
  });

  it('a complete batch stays a clean summary with no shortfall line', async () => {
    outboundEmailMocks.sendOutboundEmailResult.mockResolvedValue({
      status: 'sent',
      resendId: 'resend-123',
    });

    const summary = await processOutreachResult(
      OUTREACH_TASK,
      JSON.stringify({
        emails: [{ to: 'lchen12@example.edu', subject: 'A', body: 'a' }],
        summary: 'One nudge.',
      }),
      async () => {},
    );

    expect(summary).not.toContain('⚠️');
    expect(summary).not.toContain('NOT delivered');
    expect(summary).toContain('1 sent, 0 blocked/failed');
  });

  it('sends nothing when the composed audience omits an expected owner', async () => {
    outboundEmailMocks.sendOutboundEmailResult.mockResolvedValue({
      status: 'sent',
      resendId: 'resend-123',
    });
    const notifications: string[] = [];

    const summary = await processOutreachResult(
      OUTREACH_TASK,
      JSON.stringify({
        emails: [{ to: 'lchen12@example.edu', subject: 'A', body: 'a' }],
        summary: 'One nudge.',
      }),
      async (_jid, text) => {
        notifications.push(text);
      },
      ['lchen12@example.edu', 'berg@example.edu'],
    );

    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
    expect(summary).toContain('no emails sent');
    expect(summary).toContain('Missing: berg@example.edu');
    expect(notifications).toEqual([
      expect.stringContaining('berg@example.edu'),
    ]);
  });

  it('fails loud when the host could not build the expected audience', async () => {
    const notifications: string[] = [];

    const summary = await processOutreachResult(
      OUTREACH_TASK,
      JSON.stringify({ emails: [], summary: 'No owners found.' }),
      async (_jid, text) => {
        notifications.push(text);
      },
      null,
    );

    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
    expect(summary).toContain('recipient roster unavailable');
    expect(summary).toContain('no emails sent');
    expect(notifications).toEqual([
      expect.stringContaining('roster unavailable'),
    ]);
  });

  it('rejects copied recipients even when the To audience is exact', async () => {
    const summary = await processOutreachResult(
      OUTREACH_TASK,
      JSON.stringify({
        emails: [
          {
            to: 'lchen12@example.edu',
            cc: 'user112@example.edu',
            subject: 'A',
            body: 'a',
          },
        ],
        summary: 'One nudge.',
      }),
      async () => {},
      ['lchen12@example.edu'],
    );

    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
    expect(summary).toContain('copied recipients are not permitted');
    expect(summary).toContain('user112@example.edu');
  });

  it('rejects duplicate entries in the host-computed expected audience', async () => {
    const summary = await processOutreachResult(
      OUTREACH_TASK,
      JSON.stringify({
        emails: [{ to: 'lchen12@example.edu', subject: 'A', body: 'a' }],
        summary: 'One nudge.',
      }),
      async () => {},
      ['lchen12@example.edu', 'lchen12@example.edu'],
    );

    expect(outboundEmailMocks.sendOutboundEmailResult).not.toHaveBeenCalled();
    expect(summary).toContain('host recipient roster is invalid');
  });
});
