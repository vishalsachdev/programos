import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  getDatabase,
  getLastTaskRunAt,
  getMessagesSince,
  getRoutedApproval,
  insertRoutedApproval,
  listOpenRoutedApprovals,
  logTaskRun,
  setRouterState,
  storeChatMetadata,
  storeMessage,
  updateTask,
  type RoutedApprovalRow,
} from './db.js';
import { logger } from './logger.js';
import {
  parseRetentionDays,
  readRetentionConfig,
  RETENTION_SETTINGS,
  retentionEnabled,
  runRetention,
  startRetention,
  type RetentionConfig,
  type RetentionDeps,
} from './retention.js';

// Retention deletes data. These tests hold it to: off by default; only what
// is older than the window; nothing a pending operation needs; no link
// followed; bad values stop the host; a dry run changes nothing and reports
// what the real run then deletes.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const BOT = 'Coordinator';
const iso = (daysAgo: number): string =>
  new Date(NOW - daysAgo * DAY).toISOString();

const OFF: RetentionConfig = {
  messages: 0,
  routedApprovals: 0,
  tasks: 0,
  transcriptArchives: 0,
  uploads: 0,
  workingContextArchive: 0,
  evals: 0,
  ipcErrors: 0,
};
const ALL_30: RetentionConfig = {
  messages: 30,
  routedApprovals: 30,
  tasks: 30,
  transcriptArchives: 30,
  uploads: 30,
  workingContextArchive: 30,
  evals: 30,
  ipcErrors: 30,
};

let base: string;
let outside: string;

function deps(): RetentionDeps {
  return {
    db: getDatabase(),
    now: () => NOW,
    botPrefix: BOT,
    paths: {
      storeDir: path.join(base, 'store'),
      dataDir: path.join(base, 'data'),
      groupsDir: path.join(base, 'groups'),
    },
  };
}

function file(rel: string, daysAgo: number, content = 'x'): string {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const at = new Date(NOW - daysAgo * DAY);
  fs.utimesSync(p, at, at);
  return p;
}

function message(
  id: string,
  chat: string,
  daysAgo: number,
  opts: { bot?: boolean; content?: string } = {},
): void {
  storeMessage({
    id,
    chat_jid: chat,
    sender: opts.bot ? 'bot' : 'avery@example.edu',
    sender_name: opts.bot ? BOT : 'Avery Morgan',
    content: opts.content ?? `text of ${id}`,
    timestamp: iso(daysAgo),
    is_from_me: opts.bot === true,
    is_bot_message: opts.bot === true,
  });
}

function messageIds(): string[] {
  return (
    getDatabase().prepare('SELECT id FROM messages ORDER BY id').all() as {
      id: string;
    }[]
  ).map((r) => r.id);
}

function setCursors(seenDaysAgo: number, perChat: Record<string, number>) {
  setRouterState('last_timestamp', iso(seenDaysAgo));
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(perChat).map(([jid, d]) => [jid, iso(d)]),
      ),
    ),
  );
}

function approval(
  key: string,
  patch: Partial<RoutedApprovalRow> = {},
): RoutedApprovalRow {
  const row: RoutedApprovalRow = {
    key,
    title: `Title ${key}`,
    sender: 'sender@example.edu',
    quotes: ['the words'],
    trustedAddresses: [],
    status: 'closed',
    createdAt: NOW - 90 * DAY,
    closedAt: NOW - 60 * DAY,
    relayCount: 1,
    relaySubmitted: 1,
    ...patch,
  };
  insertRoutedApproval(row);
  return row;
}

function approvalKeys(): string[] {
  return (
    getDatabase()
      .prepare('SELECT key FROM routed_approvals ORDER BY key')
      .all() as { key: string }[]
  ).map((r) => r.key);
}

function task(
  id: string,
  status: 'active' | 'paused' | 'completed',
  lastRunDaysAgo: number,
) {
  createTask({
    id,
    group_folder: 'main',
    chat_jid: 'tg:1',
    prompt: `prompt of ${id}`,
    schedule_type: 'once',
    schedule_value: iso(lastRunDaysAgo),
    context_mode: 'isolated',
    next_run: null,
    status: 'active',
    created_at: iso(lastRunDaysAgo + 1),
  });
  getDatabase()
    .prepare('UPDATE scheduled_tasks SET last_run = ? WHERE id = ?')
    .run(iso(lastRunDaysAgo), id);
  updateTask(id, { status });
}

function run(taskId: string, daysAgo: number): void {
  logTaskRun({
    task_id: taskId,
    run_at: iso(daysAgo),
    duration_ms: 5,
    status: 'success',
    result: `result of ${taskId}`,
    error: null,
  });
}

const count = (table: string): number =>
  (
    getDatabase().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;

function evalsDb(rows: number[]): string {
  const p = path.join(base, 'store', 'evals.db');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.exec(
    `CREATE TABLE response_evals (id INTEGER PRIMARY KEY AUTOINCREMENT,
       chat_jid TEXT NOT NULL, channel TEXT NOT NULL, timestamp TEXT NOT NULL,
       confidence TEXT NOT NULL, has_citation INTEGER NOT NULL,
       category TEXT NOT NULL, topics TEXT NOT NULL,
       response_length INTEGER NOT NULL, eval_notes TEXT)`,
  );
  const ins = db.prepare(
    `INSERT INTO response_evals (chat_jid, channel, timestamp, confidence,
       has_citation, category, topics, response_length, eval_notes)
     VALUES ('tg:1', 'telegram', ?, 'high', 1, 'question', '[]', 10, 'note')`,
  );
  for (const d of rows) ins.run(iso(d));
  db.close();
  return p;
}

function evalCount(p: string): number {
  const db = new Database(p, { readonly: true });
  try {
    return (
      db.prepare('SELECT COUNT(*) AS n FROM response_evals').get() as {
        n: number;
      }
    ).n;
  } finally {
    db.close();
  }
}

/** Every file under base (not through links) with its content, plus row counts. */
function snapshot(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      const rel = path.relative(base, p);
      if (st.isSymbolicLink()) out.push(`${rel} -> ${fs.readlinkSync(p)}`);
      else if (st.isDirectory()) walk(p);
      else if (/evals\.db-(wal|shm)$/.test(name)) continue;
      else if (name === 'evals.db') out.push(`${rel} rows=${evalCount(p)}`);
      else out.push(`${rel} = ${fs.readFileSync(p, 'utf8')}`);
    }
  };
  walk(base);
  for (const t of [
    'messages',
    'routed_approvals',
    'scheduled_tasks',
    'task_run_logs',
  ])
    out.push(`${t} rows=${count(t)}`);
  out.push(
    JSON.stringify(
      getDatabase()
        .prepare('SELECT * FROM routed_approvals ORDER BY key')
        .all(),
    ),
  );
  return out.join('\n');
}

/** One fixture with something old and something recent in every store. */
function populate(): void {
  storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
  message('m-old', 'tg:1', 60);
  message('m-old-reply', 'tg:1', 59, { bot: true });
  message('m-recent', 'tg:1', 2);
  message('m-recent-reply', 'tg:1', 1, { bot: true });
  setCursors(1, { 'tg:1': 1 });
  approval('discussions/raw/a.md');
  approval('discussions/raw/b.md', { closedAt: NOW - 2 * DAY });
  task('t-done-old', 'completed', 60);
  run('t-done-old', 60);
  task('t-active', 'active', 60);
  run('t-active', 60);
  run('t-active', 1);
  file('groups/main/conversations/2026-09-01-old-talk.md', 80);
  file('groups/main/conversations/2026-11-19-new-talk.md', 1);
  file('data/telegram-uploads/main/old.pdf', 60);
  file('data/telegram-uploads/main/old.pdf.extracted.md', 60);
  file('data/telegram-uploads/main/new.pdf', 1);
  file('groups/main/attachments/img-1700000000000-ab12.jpg', 60);
  file('groups/main/attachments/img-1790000000000-cd34.jpg', 1);
  file(
    'data/working-context/avery.archive.json',
    0,
    JSON.stringify([
      { ts: iso(90), type: 'thread', text: 'old note' },
      { ts: iso(3), type: 'thread', text: 'new note' },
    ]),
  );
  file('data/working-context/avery.json', 0, '[]\n');
  evalsDb([60, 1]);
  file('data/ipc/errors/main-old.json', 60, '{}');
  file('data/ipc/errors/main-new.json', 1, '{}');
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'retention-'));
  outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  for (const d of ['store', 'data', 'groups']) fs.mkdirSync(path.join(base, d));
  _initTestDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  _closeDatabase();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('settings', () => {
  it('defaults every store to 0, which keeps everything', () => {
    const config = readRetentionConfig({}, {});
    expect(config).toEqual(OFF);
    expect(retentionEnabled(config)).toBe(false);
  });

  it('reads whole days from the environment, which wins over .env', () => {
    const config = readRetentionConfig(
      { RETENTION_MESSAGES_DAYS: '180', RETENTION_TASKS_DAYS: ' 30 ' },
      { RETENTION_MESSAGES_DAYS: '7', RETENTION_UPLOADS_DAYS: '90' },
    );
    expect(config).toEqual({ ...OFF, messages: 180, tasks: 30, uploads: 90 });
    expect(retentionEnabled(config)).toBe(true);
  });

  it.each([
    '-1',
    '-30',
    'abc',
    '30d',
    '1e3',
    '0.5',
    '1.5',
    '+3',
    '0x10',
    '7 days',
  ])('refuses "%s"', (bad) => {
    expect(() => parseRetentionDays('RETENTION_MESSAGES_DAYS', bad)).toThrow(
      /RETENTION_MESSAGES_DAYS must be a whole number of days/,
    );
  });

  it('refuses a value over 100 years', () => {
    expect(() => parseRetentionDays('RETENTION_EVALS_DAYS', '36501')).toThrow(
      /at most 36500/,
    );
    expect(parseRetentionDays('RETENTION_EVALS_DAYS', '36500')).toBe(36500);
  });

  it('accepts 0, 1 and an empty value', () => {
    expect(parseRetentionDays('K', '0')).toBe(0);
    expect(parseRetentionDays('K', '1')).toBe(1);
    expect(parseRetentionDays('K', '')).toBe(0);
    expect(parseRetentionDays('K', undefined)).toBe(0);
  });

  it('names every bad setting in one error that stops the host', () => {
    expect(() =>
      readRetentionConfig(
        { RETENTION_MESSAGES_DAYS: '-1', RETENTION_UPLOADS_DAYS: 'soon' },
        { RETENTION_TASKS_DAYS: '0.5' },
      ),
    ).toThrow(
      /will not start.*RETENTION_MESSAGES_DAYS.*RETENTION_TASKS_DAYS.*RETENTION_UPLOADS_DAYS/s,
    );
  });

  it('is read in main() before the database is opened', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'index.ts'),
      'utf8',
    );
    const main = source.slice(source.indexOf('async function main()'));
    const read = main.indexOf('readRetentionConfig()');
    expect(read).toBeGreaterThan(-1);
    expect(read).toBeLessThan(main.indexOf('initDatabase()'));
    expect(read).toBeLessThan(main.indexOf('startCredentialProxy('));
  });

  it('has one setting per store', () => {
    expect(Object.keys(RETENTION_SETTINGS).sort()).toEqual(
      Object.keys(OFF).sort(),
    );
    for (const key of Object.values(RETENTION_SETTINGS))
      expect(key).toMatch(/^RETENTION_[A-Z_]+_DAYS$/);
  });
});

describe('the default', () => {
  it('deletes nothing and starts no timer', async () => {
    populate();
    const before = snapshot();
    vi.useFakeTimers();
    const stop = startRetention(OFF, deps());
    expect(vi.getTimerCount()).toBe(0);
    stop();
    vi.useRealTimers();
    expect(await runRetention(OFF, deps())).toEqual({});
    expect(snapshot()).toBe(before);
  });

  it('starts a first run and a daily run when a setting is on', async () => {
    populate();
    vi.useFakeTimers();
    const stop = startRetention({ ...OFF, ipcErrors: 30 }, deps());
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      fs.existsSync(path.join(base, 'data/ipc/errors/main-old.json')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(base, 'data/ipc/errors/main-new.json')),
    ).toBe(true);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('touches only the stores whose setting is on', async () => {
    populate();
    const report = await runRetention({ ...OFF, ipcErrors: 30 }, deps());
    expect(report).toEqual({ ipcErrors: { deleted: 1 } });
    expect(messageIds()).toHaveLength(4);
    expect(approvalKeys()).toHaveLength(2);
    expect(
      fs.existsSync(path.join(base, 'data/telegram-uploads/main/old.pdf')),
    ).toBe(true);
  });
});

describe('messages', () => {
  const only = { ...OFF, messages: 30 };

  it('deletes answered messages older than the window and keeps newer ones', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('a-45', 'tg:1', 45);
    message('b-45-reply', 'tg:1', 44, { bot: true });
    message('c-31', 'tg:1', 31);
    message('d-29', 'tg:1', 29);
    message('e-1-reply', 'tg:1', 1, { bot: true });
    setCursors(1, { 'tg:1': 1 });
    const report = await runRetention(only, deps());
    expect(report.messages).toEqual({ deleted: 3, keptNeeded: 0 });
    expect(messageIds()).toEqual(['d-29', 'e-1-reply']);
  });

  it('keeps a message that has not been answered, however old', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('answered', 'tg:1', 90);
    message('reply', 'tg:1', 89, { bot: true });
    message('waiting-1', 'tg:1', 60);
    message('waiting-2', 'tg:1', 40);
    setCursors(1, { 'tg:1': 80 });
    const pendingBefore = getMessagesSince('tg:1', iso(80), BOT);
    const report = await runRetention(only, deps());
    expect(report.messages).toEqual({ deleted: 1, keptNeeded: 3 });
    expect(messageIds()).toEqual(['reply', 'waiting-1', 'waiting-2']);
    expect(getMessagesSince('tg:1', iso(80), BOT)).toEqual(pendingBefore);
  });

  it('keeps a message the message loop has not seen yet', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('seen', 'tg:1', 90);
    message('unseen', 'tg:1', 50);
    // The per-chat cursor is ahead of the seen cursor (a recovered cursor).
    setCursors(70, { 'tg:1': 40 });
    await runRetention(only, deps());
    expect(messageIds()).toEqual(['unseen']);
  });

  it('keeps everything when no message has ever been seen', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('old', 'tg:1', 90);
    setRouterState('last_agent_timestamp', JSON.stringify({ 'tg:1': iso(1) }));
    const report = await runRetention(only, deps());
    expect(report.messages).toEqual({ deleted: 0, keptNeeded: 1 });
  });

  it('keeps every message of a chat with no cursor and no bot message', async () => {
    storeChatMetadata('tg:2', iso(0), 'Quiet chat', 'telegram', true);
    message('q1', 'tg:2', 90);
    message('q2', 'tg:2', 60);
    setCursors(1, {});
    const report = await runRetention(only, deps());
    expect(report.messages).toEqual({ deleted: 0, keptNeeded: 2 });
    expect(messageIds()).toEqual(['q1', 'q2']);
  });

  it('keeps the newest bot message, which rebuilds a lost cursor', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('q-old', 'tg:1', 90);
    message('reply-old', 'tg:1', 89, { bot: true });
    message('q-last', 'tg:1', 61);
    message('reply-last', 'tg:1', 60, { bot: true });
    message('legacy-prefix', 'tg:1', 70, { content: `${BOT}: an old reply` });
    // The saved per-chat cursor is lost: the host falls back to the newest
    // bot message, and so does the prune.
    setCursors(1, {});
    await runRetention(only, deps());
    expect(messageIds()).toEqual(['reply-last']);
    // With the cursor rebuilt from that row nothing is answered twice.
    expect(getMessagesSince('tg:1', iso(60), BOT)).toEqual([]);
  });

  it('treats each chat by its own cursor', async () => {
    storeChatMetadata('tg:1', iso(0), 'One', 'telegram', true);
    storeChatMetadata('tg:2', iso(0), 'Two', 'telegram', true);
    message('one-old', 'tg:1', 50);
    message('two-old', 'tg:2', 50);
    setCursors(1, { 'tg:1': 10, 'tg:2': 55 });
    await runRetention(only, deps());
    expect(messageIds()).toEqual(['two-old']);
  });

  it('deletes nothing when the saved cursors cannot be read', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('old', 'tg:1', 90);
    message('reply', 'tg:1', 80, { bot: true });
    setRouterState('last_timestamp', iso(1));
    setRouterState('last_agent_timestamp', '{not json');
    const report = await runRetention(only, deps());
    expect(report.messages).toEqual({
      deleted: 0,
      skipped: 'saved cursors unreadable',
    });
    expect(messageIds()).toEqual(['old', 'reply']);
  });

  it('leaves a row whose timestamp is not an ISO time', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('odd', 'tg:1', 90);
    getDatabase()
      .prepare(`UPDATE messages SET timestamp = '1700000000' WHERE id = 'odd'`)
      .run();
    message('reply', 'tg:1', 1, { bot: true });
    setCursors(1, { 'tg:1': 1 });
    await runRetention(only, deps());
    expect(messageIds()).toEqual(['odd', 'reply']);
  });
});

describe('routed approvals', () => {
  const only = { ...OFF, routedApprovals: 30 };
  const stored = (key: string) =>
    getDatabase()
      .prepare('SELECT * FROM routed_approvals WHERE key = ?')
      .get(key) as Record<string, unknown>;

  it('clears the content of rows closed or removed before the window, and keeps the row', async () => {
    approval('raw/closed-old.md', {
      senderName: 'Sam Sender',
      approverEmail: 'approver@example.edu',
      approverName: 'Pat Approver',
      subject: 'A subject',
      trustedAddresses: ['other@example.edu'],
      holdReason: 'a reason',
    });
    approval('raw/removed-old.md', { status: 'removed' });
    approval('raw/closed-recent.md', { closedAt: NOW - 29 * DAY });
    const recentBefore = stored('raw/closed-recent.md');
    const report = await runRetention(only, deps());
    expect(report.routedApprovals).toEqual({ deleted: 2 });
    expect(approvalKeys()).toHaveLength(3);
    expect(stored('raw/closed-old.md')).toMatchObject({
      status: 'closed',
      closed_at: NOW - 60 * DAY,
      title: '',
      sender: '',
      sender_name: null,
      approver_email: null,
      approver_name: null,
      subject: null,
      quotes_json: '[]',
      trusted_addresses_json: '[]',
      hold_reason: null,
    });
    expect(stored('raw/removed-old.md')).toMatchObject({
      status: 'removed',
      title: '',
    });
    expect(stored('raw/closed-recent.md')).toEqual(recentBefore);
    // Cleared rows are not counted again.
    expect((await runRetention(only, deps())).routedApprovals).toEqual({
      deleted: 0,
    });
  });

  it('leaves the row that stops a second relay when an entry is reopened later', async () => {
    // The scan creates a row, and mails the approver, for an open entry it
    // has no row for (routed-approvals.ts, scanOnce). The cleared row is
    // still found by key and is still closed, so a reopened or re-added
    // entry stays as inert after the prune as it was before.
    approval('discussions/raw/reopened.md');
    await runRetention(only, deps());
    expect(getRoutedApproval('discussions/raw/reopened.md')).toMatchObject({
      key: 'discussions/raw/reopened.md',
      status: 'closed',
      relayCount: 1,
      relaySubmitted: 1,
    });
    expect(listOpenRoutedApprovals()).toEqual([]);
  });

  it('does not touch an approval that is still open, however old', async () => {
    for (const status of ['pending', 'relayed', 'held'] as const)
      approval(`raw/${status}.md`, {
        status: status as RoutedApprovalRow['status'],
        closedAt: undefined,
        createdAt: NOW - 400 * DAY,
      });
    const before = snapshot();
    const report = await runRetention(only, deps());
    expect(report.routedApprovals).toEqual({ deleted: 0 });
    expect(snapshot()).toBe(before);
  });

  it('does not touch a closed row with a notice still owed or a relay not yet recorded', async () => {
    approval('raw/notice.md', { status: 'removed', pendingNotice: 'removed' });
    approval('raw/relay.md', { relaySubmitted: 2, relayCount: 1 });
    const before = snapshot();
    const report = await runRetention(only, deps());
    expect(report.routedApprovals).toEqual({ deleted: 0 });
    expect(snapshot()).toBe(before);
  });
});

describe('scheduled tasks and run records', () => {
  it('deletes finished one-time tasks and old run records only', async () => {
    task('done-old', 'completed', 45);
    run('done-old', 45);
    task('done-recent', 'completed', 10);
    run('done-recent', 10);
    task('active-old', 'active', 45);
    run('active-old', 45);
    run('active-old', 5);
    task('paused-old', 'paused', 400);
    const report = await runRetention({ ...OFF, tasks: 30 }, deps());
    expect(report.tasks).toEqual({ deleted: 3 });
    const ids = (
      getDatabase()
        .prepare('SELECT id FROM scheduled_tasks ORDER BY id')
        .all() as { id: string }[]
    ).map((r) => r.id);
    expect(ids).toEqual(['active-old', 'done-recent', 'paused-old']);
    const runs = getDatabase()
      .prepare('SELECT task_id, run_at FROM task_run_logs ORDER BY run_at')
      .all();
    expect(runs).toEqual([
      { task_id: 'done-recent', run_at: iso(10) },
      { task_id: 'active-old', run_at: iso(5) },
    ]);
  });

  it('never deletes the approved email-outreach task', async () => {
    task('outreach-approved', 'completed', 400);
    run('outreach-approved', 400);
    task('other-done', 'completed', 400);
    task('active', 'active', 1);
    run('active', 1);
    const report = await runRetention(
      { ...OFF, tasks: 30 },
      { ...deps(), protectedTaskIds: ['outreach-approved'] },
    );
    // The other task and the protected task's old run record.
    expect(report.tasks).toEqual({ deleted: 2 });
    expect(
      getDatabase().prepare('SELECT id FROM scheduled_tasks ORDER BY id').all(),
    ).toEqual([{ id: 'active' }, { id: 'outreach-approved' }]);
  });

  it('always keeps the newest run record and its task, which /health reads', async () => {
    task('done-long-ago', 'completed', 400);
    run('done-long-ago', 401);
    run('done-long-ago', 400);
    const report = await runRetention({ ...OFF, tasks: 30 }, deps());
    expect(report.tasks).toEqual({ deleted: 1 });
    expect(getLastTaskRunAt()).toBe(iso(400));
    expect(count('scheduled_tasks')).toBe(1);
  });

  it('keeps the seven days of run records the exceptions digest reads', async () => {
    task('done', 'completed', 3);
    run('done', 3);
    task('active', 'active', 6);
    run('active', 6);
    run('active', 8);
    const report = await runRetention({ ...OFF, tasks: 1 }, deps());
    expect(report.tasks).toEqual({ deleted: 1 });
    expect(count('scheduled_tasks')).toBe(2);
    expect(count('task_run_logs')).toBe(2);
  });
});

describe('files', () => {
  it('deletes transcript archives older than the window, by the hook’s name only', async () => {
    const old = file('groups/main/conversations/2026-08-01-budget.md', 100);
    const recent = file('groups/main/conversations/2026-11-10-budget.md', 10);
    const other = file('groups/main/conversations/notes.md', 100);
    const elsewhere = file('groups/main/2026-08-01-budget.md', 100);
    const nested = file('groups/main/conversations/sub/2026-08-01-x.md', 100);
    const report = await runRetention(
      { ...OFF, transcriptArchives: 30 },
      deps(),
    );
    expect(report.transcriptArchives).toEqual({ deleted: 1 });
    expect(fs.existsSync(old)).toBe(false);
    for (const kept of [recent, other, elsewhere, nested])
      expect(fs.existsSync(kept)).toBe(true);
  });

  it('deletes old Telegram files and host-written photos, and nothing else', async () => {
    const gone = [
      file('data/telegram-uploads/main/report.pdf', 40),
      file('data/telegram-uploads/main/report.pdf.extracted.md', 40),
      file('groups/main/attachments/img-1700000000000-ab12.jpg', 40),
    ];
    const kept = [
      file('data/telegram-uploads/main/fresh.pdf', 29),
      file('groups/main/attachments/img-1790000000000-zz99.jpg', 2),
      file('groups/main/attachments/my-own-chart.jpg', 400),
      file('groups/main/CLAUDE.md', 400),
      file('groups/main/logs/run.log', 400),
      file('data/sessions/main/.claude/projects/-workspace-group/s.jsonl', 400),
    ];
    const report = await runRetention({ ...OFF, uploads: 30 }, deps());
    expect(report.uploads).toEqual({ deleted: 3 });
    for (const p of gone) expect(fs.existsSync(p)).toBe(false);
    for (const p of kept) expect(fs.existsSync(p)).toBe(true);
  });

  it('keeps a file named in a message that has not been answered', async () => {
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    message('answered', 'tg:1', 50, {
      content: '[Document: /workspace/telegram-uploads/done.pdf]',
    });
    message('reply', 'tg:1', 49, { bot: true });
    message('waiting', 'tg:1', 40, {
      content:
        '[Document: /workspace/telegram-uploads/waiting.pdf] and [Image: attachments/img-1700000000001-ab12.jpg] see these',
    });
    setCursors(1, { 'tg:1': 45 });
    const needed = [
      file('data/telegram-uploads/main/waiting.pdf', 40),
      file('data/telegram-uploads/main/waiting.pdf.extracted.md', 40),
      file('groups/main/attachments/img-1700000000001-ab12.jpg', 40),
    ];
    const done = file('data/telegram-uploads/main/done.pdf', 50);
    const report = await runRetention(
      { ...OFF, uploads: 30, messages: 30 },
      deps(),
    );
    expect(report.uploads).toEqual({ deleted: 1, keptNeeded: 3 });
    expect(fs.existsSync(done)).toBe(false);
    for (const p of needed) expect(fs.existsSync(p)).toBe(true);
    expect(messageIds()).toEqual(['reply', 'waiting']);
  });

  it('drops old entries from the working-context archive and leaves the live file', async () => {
    const archive = file(
      'data/working-context/avery.archive.json',
      0,
      JSON.stringify([
        { ts: iso(100), type: 'thread', text: 'old' },
        { ts: iso(5), type: 'thread', text: 'new' },
        { type: 'thread', text: 'no time' },
        'not an entry',
      ]),
    );
    const live = file(
      'data/working-context/avery.json',
      0,
      JSON.stringify([{ ts: iso(100), type: 'thread', text: 'live and old' }]),
    );
    const corrupt = file('data/working-context/sam.archive.json', 0, '{nope');
    const report = await runRetention(
      { ...OFF, workingContextArchive: 30 },
      deps(),
    );
    expect(report.workingContextArchive).toEqual({ deleted: 1 });
    expect(JSON.parse(fs.readFileSync(archive, 'utf8'))).toEqual([
      { ts: iso(5), type: 'thread', text: 'new' },
      { type: 'thread', text: 'no time' },
      'not an entry',
    ]);
    expect(JSON.parse(fs.readFileSync(live, 'utf8'))).toHaveLength(1);
    expect(fs.readFileSync(corrupt, 'utf8')).toBe('{nope');
  });

  it('deletes old eval rows and never creates the eval database', async () => {
    const only = { ...OFF, evals: 30 };
    expect((await runRetention(only, deps())).evals).toEqual({ deleted: 0 });
    expect(fs.existsSync(path.join(base, 'store', 'evals.db'))).toBe(false);
    const p = evalsDb([100, 31, 29, 0]);
    expect((await runRetention(only, deps())).evals).toEqual({ deleted: 2 });
    expect(evalCount(p)).toBe(2);
  });

  it('keeps the seven days of eval rows the weekly report reads', async () => {
    const p = evalsDb([8, 6, 3]);
    expect((await runRetention({ ...OFF, evals: 1 }, deps())).evals).toEqual({
      deleted: 1,
    });
    expect(evalCount(p)).toBe(2);
  });

  it('deletes old set-aside IPC requests', async () => {
    const old = file('data/ipc/errors/main-1.json', 31, '{}');
    const recent = file('data/ipc/errors/main-2.json', 29, '{}');
    const live = file('data/ipc/main/messages/3.json', 400, '{}');
    const report = await runRetention({ ...OFF, ipcErrors: 30 }, deps());
    expect(report.ipcErrors).toEqual({ deleted: 1 });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
  });
});

describe('path safety', () => {
  const secret = (): string => {
    const p = path.join(outside, '2026-01-01-secret.md');
    fs.writeFileSync(p, 'KEEP');
    const at = new Date(NOW - 400 * DAY);
    fs.utimesSync(p, at, at);
    return p;
  };
  const on = {
    ...OFF,
    transcriptArchives: 30,
    uploads: 30,
    workingContextArchive: 30,
    ipcErrors: 30,
  };

  it('does not delete through a folder that is a link', async () => {
    const target = secret();
    const img = path.join(outside, 'img-1700000000000-ab12.jpg');
    fs.writeFileSync(img, 'KEEP');
    fs.utimesSync(img, new Date(NOW - 400 * DAY), new Date(NOW - 400 * DAY));
    fs.mkdirSync(path.join(base, 'groups/main'), { recursive: true });
    fs.symlinkSync(outside, path.join(base, 'groups/main/conversations'));
    fs.symlinkSync(outside, path.join(base, 'groups/main/attachments'));
    fs.mkdirSync(path.join(base, 'data/ipc'), { recursive: true });
    fs.symlinkSync(outside, path.join(base, 'data/ipc/errors'));
    const report = await runRetention(on, deps());
    expect(report.transcriptArchives).toEqual({ deleted: 0, refused: 1 });
    expect(report.uploads).toEqual({ deleted: 0, refused: 1 });
    expect(report.ipcErrors).toEqual({ deleted: 0, refused: 1 });
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP');
    expect(fs.readFileSync(img, 'utf8')).toBe('KEEP');
  });

  it('does not enter a group folder that is a link', async () => {
    const target = secret();
    fs.mkdirSync(path.join(outside, 'conversations'));
    const inner = path.join(outside, 'conversations', '2026-01-01-x.md');
    fs.writeFileSync(inner, 'KEEP');
    fs.utimesSync(inner, new Date(NOW - 400 * DAY), new Date(NOW - 400 * DAY));
    fs.symlinkSync(outside, path.join(base, 'groups/linked'));
    fs.mkdirSync(path.join(base, 'data/telegram-uploads'), { recursive: true });
    fs.symlinkSync(outside, path.join(base, 'data/telegram-uploads/linked'));
    const report = await runRetention(on, deps());
    expect(report.transcriptArchives).toEqual({ deleted: 0 });
    expect(report.uploads).toEqual({ deleted: 0 });
    expect(fs.readFileSync(inner, 'utf8')).toBe('KEEP');
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP');
  });

  it('leaves a planted link and a hard link where an old file would be', async () => {
    const target = secret();
    const dir = path.join(base, 'groups/main/conversations');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(target, path.join(dir, '2026-01-01-link.md'));
    fs.linkSync(target, path.join(dir, '2026-01-01-hard.md'));
    const real = file('groups/main/conversations/2026-01-01-real.md', 400);
    const report = await runRetention(on, deps());
    expect(report.transcriptArchives).toEqual({ deleted: 1 });
    expect(fs.existsSync(real)).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP');
    expect(fs.lstatSync(path.join(dir, '2026-01-01-link.md'))).toBeTruthy();
    expect(fs.lstatSync(path.join(dir, '2026-01-01-hard.md'))).toBeTruthy();
  });

  it('does not rewrite a working-context archive that is a link', async () => {
    const target = path.join(outside, 'target.json');
    const body = JSON.stringify([{ ts: iso(400), type: 'thread', text: 'x' }]);
    fs.writeFileSync(target, body);
    fs.mkdirSync(path.join(base, 'data/working-context'), { recursive: true });
    fs.symlinkSync(
      target,
      path.join(base, 'data/working-context/avery.archive.json'),
    );
    const report = await runRetention(on, deps());
    expect(report.workingContextArchive).toEqual({ deleted: 0 });
    expect(fs.readFileSync(target, 'utf8')).toBe(body);
  });
});

describe('guards', () => {
  it('refuses a window under one day even if a caller passes one', async () => {
    populate();
    const before = snapshot();
    const bad = Object.fromEntries(
      Object.keys(OFF).map((k) => [k, 0.5]),
    ) as RetentionConfig;
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const report = await runRetention(bad, deps());
    for (const result of Object.values(report)) {
      expect(result?.deleted).toBe(0);
      expect(result?.skipped).toMatch(/failed/);
    }
    expect(errors).toHaveBeenCalledTimes(8);
    expect(snapshot()).toBe(before);
  });

  it('keeps going when one store fails', async () => {
    populate();
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const report = await runRetention(
      { ...OFF, messages: 30, ipcErrors: 30 },
      {
        ...deps(),
        db: new Proxy(
          {},
          {
            get: () => () => {
              throw new Error('db gone');
            },
          },
        ) as never,
      },
    );
    expect(report.messages).toEqual({
      deleted: 0,
      skipped: 'failed; see the error above',
    });
    expect(report.ipcErrors).toEqual({ deleted: 1 });
  });

  it('writes one log line per run, with counts and no content', async () => {
    populate();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await runRetention(ALL_30, deps());
    expect(info).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(info.mock.calls[0]);
    expect(line).toContain('Retention prune');
    for (const content of [
      'text of',
      'm-old',
      'old.pdf',
      'old-talk',
      'old note',
      'prompt of',
      'discussions/raw',
      'example.edu',
      'tg:1',
      'main',
    ])
      expect(line).not.toContain(content);
    expect(info.mock.calls[0][0]).toMatchObject({
      dryRun: false,
      stores: { messages: { deleted: 2 }, ipcErrors: { deleted: 1 } },
    });
  });
});

describe('dry run', () => {
  it('deletes nothing and reports the counts the real run then deletes', async () => {
    populate();
    // One of each "still needed" kind, so those counts are compared too.
    storeChatMetadata('tg:9', iso(0), 'Other chat', 'telegram', true);
    message('m-waiting', 'tg:9', 45, {
      content: '[Document: /workspace/telegram-uploads/held.pdf]',
    });
    setCursors(1, { 'tg:1': 1, 'tg:9': 50 });
    file('data/telegram-uploads/main/held.pdf', 60);
    const before = snapshot();

    const dry = await runRetention(ALL_30, deps(), { dryRun: true });
    expect(snapshot()).toBe(before);
    expect(dry).toEqual({
      uploads: { deleted: 3, keptNeeded: 1 },
      messages: { deleted: 2, keptNeeded: 1 },
      routedApprovals: { deleted: 1 },
      tasks: { deleted: 3 },
      transcriptArchives: { deleted: 1 },
      workingContextArchive: { deleted: 1 },
      evals: { deleted: 1 },
      ipcErrors: { deleted: 1 },
    });

    const real = await runRetention(ALL_30, deps());
    expect(real).toEqual(dry);
    expect(snapshot()).not.toBe(before);
    // A second real run finds nothing more to delete.
    const again = await runRetention(ALL_30, deps());
    for (const result of Object.values(again)) expect(result?.deleted).toBe(0);
  });

  it('says in the log line that nothing was deleted', async () => {
    populate();
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    await runRetention(ALL_30, deps(), { dryRun: true });
    expect(info.mock.calls[0][0]).toMatchObject({ dryRun: true });
    expect(info.mock.calls[0][1]).toBe('Retention dry run: nothing deleted');
  });
});

describe('scripts/retention-prune.ts', () => {
  const script = path.join(process.cwd(), 'scripts', 'retention-prune.ts');
  const tsx = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');

  function install(): string {
    const dir = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'retention-cli-'),
    );
    fs.mkdirSync(path.join(dir, 'store'));
    _initTestDatabase(path.join(dir, 'store', 'messages.db'));
    storeChatMetadata('tg:1', iso(0), 'Team chat', 'telegram', true);
    const at = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * DAY).toISOString();
    for (const [id, daysAgo, bot] of [
      ['old', 60, false],
      ['old-reply', 59, true],
      ['last-reply', 1, true],
    ] as const)
      storeMessage({
        id,
        chat_jid: 'tg:1',
        sender: 's',
        sender_name: 'S',
        content: `text of ${id}`,
        timestamp: at(daysAgo),
        is_from_me: bot,
        is_bot_message: bot,
      });
    setRouterState('last_timestamp', at(1));
    setRouterState('last_agent_timestamp', JSON.stringify({ 'tg:1': at(1) }));
    getDatabase().pragma('wal_checkpoint(TRUNCATE)');
    return dir;
  }

  function cli(dir: string, args: string[], env: Record<string, string>) {
    try {
      const stdout = execFileSync(tsx, [script, ...args], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', LOG_LEVEL: 'silent', ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      return { code: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  it('is a dry run unless --apply is given, and the two report the same count', () => {
    const dir = install();
    try {
      const env = { RETENTION_MESSAGES_DAYS: '30' };
      for (const args of [[], ['--dry-run']]) {
        const dry = cli(dir, args, env);
        expect(dry.code).toBe(0);
        expect(dry.stdout).toContain('DRY RUN: nothing was deleted.');
        expect(dry.stdout).toContain(
          'RETENTION_MESSAGES_DAYS=30  would delete 2',
        );
        expect(dry.stdout).toContain(
          'RETENTION_UPLOADS_DAYS=0  off, everything kept',
        );
        expect(dry.stdout).not.toContain('text of');
        expect(count('messages')).toBe(3);
      }
      const applied = cli(dir, ['--apply'], env);
      expect(applied.code).toBe(0);
      expect(applied.stdout).toContain('RETENTION_MESSAGES_DAYS=30  deleted 2');
      expect(messageIds()).toEqual(['last-reply']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('deletes nothing with no setting, and stops on a bad one', () => {
    const dir = install();
    try {
      const off = cli(dir, ['--apply'], {});
      expect(off.code).toBe(0);
      expect(off.stdout).toContain(
        'RETENTION_MESSAGES_DAYS=0  off, everything kept',
      );
      const bad = cli(dir, ['--apply'], { RETENTION_MESSAGES_DAYS: '-5' });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toMatch(
        /RETENTION_MESSAGES_DAYS must be a whole number of days/,
      );
      const usage = cli(dir, ['--force'], { RETENTION_MESSAGES_DAYS: '30' });
      expect(usage.code).toBe(1);
      expect(count('messages')).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
