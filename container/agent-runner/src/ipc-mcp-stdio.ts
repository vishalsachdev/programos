/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { describeSendPrecheck } from './allowlist-check.js';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

/**
 * Weekday of a "once" schedule_value's calendar date (timezone-independent
 * for a calendar date). Returns null if no leading YYYY-MM-DD is present.
 */
function weekdayOfOnceValue(value: string): string | null {
  const ymd = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!ymd) return null;
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

/**
 * Weekend gate for "once" fire dates. Weekend fire times are usually
 * weekday→date arithmetic errors (a task was once mis-aimed at Saturday
 * when "Friday" was meant). Returns an MCP error result the agent must
 * answer by retrying with confirm_date, or null if the date is fine.
 */
function weekendGate(
  scheduleValue: string,
  confirmDate: string | undefined,
): { content: { type: 'text'; text: string }[]; isError: true } | null {
  const weekday = weekdayOfOnceValue(scheduleValue);
  if (weekday !== 'Saturday' && weekday !== 'Sunday') return null;
  const ymd = scheduleValue.match(/^\d{4}-\d{2}-\d{2}/)![0];
  const expected = `${weekday} ${ymd}`;
  if (confirmDate === expected) return null;
  return {
    content: [
      {
        type: 'text' as const,
        text: `Fire time ${scheduleValue} falls on a ${weekday}. Weekend fire times are usually weekday→date arithmetic errors — verify the date against the current_date in your context instead of deriving it. If the weekend date is intentional, retry with confirm_date: "${expected}".`,
      },
    ],
    isError: true,
  };
}

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

function normalizeTaskPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: string }).type === 'Buffer' &&
    Array.isArray((value as { data?: number[] }).data)
  ) {
    try {
      return Buffer.from((value as { data: number[] }).data).toString('utf-8');
    } catch (_err) {
      // fall through to generic string coercion
    }
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
    confirm_date: z
      .string()
      .optional()
      .describe(
        'Required when a "once" fire date falls on a Saturday or Sunday: the resolved date as "<Weekday> YYYY-MM-DD" (e.g. "Saturday 2026-06-13") to confirm the weekend date is intentional and not a weekday→date arithmetic error.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const gateError = weekendGate(args.schedule_value, args.confirm_date);
      if (gateError) return gateError;
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const onceWeekday =
      args.schedule_type === 'once'
        ? weekdayOfOnceValue(args.schedule_value)
        : null;
    const isWeekend = onceWeekday === 'Saturday' || onceWeekday === 'Sunday';

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      // Gate passed above — tells the host backstop this weekend date is
      // deliberate (unconfirmed weekend once-tasks are created paused).
      weekendConfirmed: isWeekend || undefined,
      context_mode: args.context_mode || 'group',
      targetJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          // Echo the resolved weekday for once tasks so a mis-derived
          // date is visible to the agent immediately.
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}${onceWeekday ? ` (fires ${onceWeekday})` : ''}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: unknown;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${normalizeTaskPrompt(t.prompt).slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// The three task-mutation tools differ only in IPC type and wording. The
// payload carries no identity fields: the host derives the sender and its
// main status from the per-group IPC directory path and ignores anything
// self-reported (see src/ipc.ts processTaskIpc).
for (const [toolName, description, requested] of [
  [
    'pause_task',
    'Pause a scheduled task. It will not run until resumed.',
    'pause',
  ],
  ['resume_task', 'Resume a paused task.', 'resume'],
  ['cancel_task', 'Cancel and delete a scheduled task.', 'cancellation'],
] as const) {
  server.tool(
    toolName,
    description,
    {
      task_id: z.string().describe(`The task ID to ${toolName.split('_')[0]}`),
    },
    async (args) => {
      writeIpcFile(TASKS_DIR, {
        type: toolName,
        taskId: args.task_id,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Task ${args.task_id} ${requested} requested.`,
          },
        ],
      };
    },
  );
}

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
    confirm_date: z
      .string()
      .optional()
      .describe(
        'Required when a new "once" fire date falls on a Saturday or Sunday: the resolved date as "<Weekday> YYYY-MM-DD" (e.g. "Saturday 2026-06-13") to confirm the weekend date is intentional.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided. When schedule_type is omitted the
    // task keeps its existing type, which this process can't see. A date-like
    // value therefore REQUIRES an explicit schedule_type: 'once' — if the
    // stored type were 'interval', the host would parseInt the date string
    // into a ~2-second interval. (Previously a bare date-like value was also
    // mis-validated as cron, making once-retargets impossible.)
    const looksLikeOnce = /^\d{4}-\d{2}-\d{2}T/.test(args.schedule_value ?? '');
    if (looksLikeOnce && !args.schedule_type) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `schedule_value "${args.schedule_value}" looks like a once timestamp — include schedule_type: "once" explicitly when retargeting with a timestamp.`,
          },
        ],
        isError: true,
      };
    }
    if (
      args.schedule_value &&
      (args.schedule_type === 'cron' || (!args.schedule_type && !looksLikeOnce))
    ) {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }
    let weekendConfirmed: true | undefined;
    if (args.schedule_value && args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const gateError = weekendGate(args.schedule_value, args.confirm_date);
      if (gateError) return gateError;
      const weekday = weekdayOfOnceValue(args.schedule_value);
      if (weekday === 'Saturday' || weekday === 'Sunday') {
        weekendConfirmed = true;
      }
    }

    const data: Record<string, string | boolean | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;
    if (weekendConfirmed) data.weekendConfirmed = true;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

// RC-018: the host writes a pinned snapshot of the allowlist (the same
// admin-verified revision its own gate reads) into this group's IPC dir at
// container start (read-only mount). Only that snapshot counts: the checkout can be
// stale or carry an unverified edit, so when the snapshot is absent the
// tool reports the send as unverified rather than judging from the checkout.
// Read-only mount written by the host (src/container-runner.ts); never the
// writable IPC dir, which an injected prompt could rewrite.
const ALLOWLIST_SNAPSHOT_PATH =
  '/workspace/allowlist/email-allowlist.snapshot.md';
async function readAllowlistText(): Promise<string | null> {
  try {
    return await fs.promises.readFile(ALLOWLIST_SNAPSHOT_PATH, 'utf8');
  } catch {
    return null;
  }
}

server.tool(
  'send_email',
  `Send a proactive email to a stakeholder. Main group only — the weekly outreach task instead composes its email batch as structured output and the host sends it.

The email is sent from the Program bot address; the host sets Reply-To to that same address so replies route back to the bot.

IMPORTANT: The recipient must be on the EMAIL_ALLOWLIST. Emails to addresses not on the allowlist will be silently dropped by the host.`,
  {
    to: z
      .string()
      .refine(
        (s) => {
          const parts = s
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
          return (
            parts.length > 0 &&
            parts.every((p) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p))
          );
        },
        {
          message: 'must be one or more comma-separated email addresses',
        },
      )
      .describe(
        'Recipient email address(es), comma-separated for multiple. Every address must be on EMAIL_ALLOWLIST.md — the whole send fails closed if any is not.',
      ),
    cc: z
      .string()
      .email()
      .optional()
      .describe(
        'Optional CC recipient (must also be on EMAIL_ALLOWLIST.md). Use for keeping a secondary owner informed without addressing them directly.',
      ),
    subject: z.string().describe('Email subject line'),
    body: z.string().describe('Plain text email body'),
    reply_to: z
      .string()
      .email()
      .optional()
      .describe(
        "Override Reply-To header (default: the bot's configured sending address)",
      ),
  },
  async (args) => {
    // UX guard: early rejection for non-main containers (the host enforces
    // this too). Outreach runs return a batch instead of calling this tool.
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: send_email is only available from the main group. If you are the weekly outreach task, return your email batch JSON as your final output instead.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'send_email',
      to: args.to,
      cc: args.cc,
      subject: args.subject,
      body: args.body,
      // No container-side default: the host resolves an absent reply_to to
      // its configured bot address (SEND_FROM_EMAIL || DEFAULT_BOT_EMAIL).
      // A literal here would pin replies to the old mailbox after an
      // address change.
      reply_to: args.reply_to,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const ccSuffix = args.cc ? ` (cc ${args.cc})` : '';
    // RC-018: make the tool result truthful at call time. The host gate is
    // authoritative and fail-closed; this only tells the agent, before it
    // writes its reply, which addresses the host will NOT send to.
    const warning = describeSendPrecheck({
      to: args.to,
      cc: args.cc,
      body: args.body,
      allowlistText: await readAllowlistText(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `Email queued for delivery to ${args.to}${ccSuffix}: "${args.subject}"${warning}`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
