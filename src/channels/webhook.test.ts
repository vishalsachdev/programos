import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  logTaskRun,
} from '../db.js';
import { getSchedulerLiveness } from './webhook.js';

import {
  deriveEmailChatJid,
  extractEmailHeader,
  parseEmailIdentity,
  selectEmailThreadId,
} from './webhook-threading.js';

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler health', () => {
  it('returns unknown scheduler fields when the database read fails', () => {
    _closeDatabase();

    expect(getSchedulerLiveness()).toEqual({
      lastTaskRunAt: null,
      schedulerStaleHours: null,
    });
  });

  it('reports completed whole hours since the latest task run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:45:00.000Z'));
    createTask({
      id: 'health-task',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'health check fixture',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-08-21T00:00:00.000Z',
    });
    logTaskRun({
      task_id: 'health-task',
      run_at: '2026-08-22T07:30:00.000Z',
      duration_ms: 100,
      status: 'success',
      result: 'done',
      error: null,
    });

    expect(getSchedulerLiveness()).toEqual({
      lastTaskRunAt: '2026-08-22T07:30:00.000Z',
      schedulerStaleHours: 5,
    });
  });
});

describe('webhook email threading helpers', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers the first References message id as the thread root', () => {
    const rawEmail = [
      'References: <root@example.com> <reply@example.com>',
      'In-Reply-To: <reply@example.com>',
      '',
      'Hello',
    ].join('\n');

    expect(selectEmailThreadId(rawEmail, '<latest@example.com>')).toBe(
      'root@example.com',
    );
  });

  it('falls back to In-Reply-To when References is absent', () => {
    const rawEmail = ['In-Reply-To: <parent@example.com>', '', 'Hello'].join(
      '\n',
    );

    expect(selectEmailThreadId(rawEmail, '<latest@example.com>')).toBe(
      'parent@example.com',
    );
  });

  it('falls back to Message-ID when no thread headers exist', () => {
    expect(selectEmailThreadId('', '<latest@example.com>')).toBe(
      'latest@example.com',
    );
  });

  it('falls back to normalized sender and subject when no ids exist', () => {
    expect(
      selectEmailThreadId(
        '',
        undefined,
        'Re: Program Launch ',
        'Alice@Example.Com',
      ),
    ).toBe('alice@example.com|program launch');
  });

  it('reads folded header lines', () => {
    const rawEmail = [
      'References: <root@example.com>',
      ' <reply@example.com>',
      '',
      'Hello',
    ].join('\n');

    expect(extractEmailHeader(rawEmail, 'References')).toBe(
      '<root@example.com> <reply@example.com>',
    );
  });

  it('derives the same chat jid for replies in the same thread', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-thread-'));
    tempDirs.push(dir);
    const rawPath = path.join(dir, 'message.eml');

    fs.writeFileSync(
      rawPath,
      [
        'References: <root@example.com> <reply@example.com>',
        'In-Reply-To: <reply@example.com>',
        '',
        'Hello',
      ].join('\n'),
    );

    expect(
      deriveEmailChatJid({
        rawFilePath: rawPath,
        messageId: '<latest@example.com>',
        subject: 'Launch question',
        from: 'alice@example.com',
      }),
    ).toBe('webhook-email:root@example.com');
  });

  it('decodes a Q-encoded UTF-8 subject from the real eml', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-identity-'));
    tempDirs.push(dir);
    const rawPath = path.join(dir, 'message.eml');
    fs.writeFileSync(
      rawPath,
      [
        'Subject: =?UTF-8?Q?Re:_Program_=E2=80=93_Fall_Launch?=',
        'Message-ID: <latest@example.com>',
        '',
        'Hello',
      ].join('\r\n'),
    );

    await expect(
      parseEmailIdentity(rawPath, {
        subject: 'encoded fallback',
        messageId: '<fallback@example.com>',
      }),
    ).resolves.toEqual({
      subject: 'Re: Program – Fall Launch',
      messageId: 'latest@example.com',
      references: [],
      inReplyTo: undefined,
      parseFallback: false,
    });
  });

  it('decodes a Base64 UTF-8 subject', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-identity-'));
    tempDirs.push(dir);
    const rawPath = path.join(dir, 'message.eml');
    fs.writeFileSync(
      rawPath,
      [
        'Subject: =?UTF-8?B?UmU6IFByb2dyYW0g4oCTIEZhbGwgTGF1bmNo?=',
        '',
        'Hello',
      ].join('\r\n'),
    );

    const identity = await parseEmailIdentity(rawPath, {});
    expect(identity.subject).toBe('Re: Program – Fall Launch');
    expect(identity.parseFallback).toBe(false);
  });

  it('keeps a plain subject and normalizes folded thread ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-identity-'));
    tempDirs.push(dir);
    const rawPath = path.join(dir, 'message.eml');
    fs.writeFileSync(
      rawPath,
      [
        'Subject: Program launch',
        'Message-ID: <latest@example.com>',
        'References: <root@example.com>',
        ' <reply@example.com>',
        'In-Reply-To: <reply@example.com>',
        '',
        'Hello',
      ].join('\r\n'),
    );

    const identity = await parseEmailIdentity(rawPath, {});
    expect(identity).toMatchObject({
      subject: 'Program launch',
      messageId: 'latest@example.com',
      references: ['root@example.com', 'reply@example.com'],
      inReplyTo: 'reply@example.com',
      parseFallback: false,
    });
    expect(selectEmailThreadId(identity)).toBe('root@example.com');
  });

  it('falls back without throwing when the eml is missing or malformed', async () => {
    const missing = await parseEmailIdentity('/no/such/message.eml', {
      subject: 'Fallback subject',
      messageId: '<fallback@example.com>',
    });
    expect(missing).toEqual({
      subject: 'Fallback subject',
      messageId: 'fallback@example.com',
      references: [],
      inReplyTo: undefined,
      parseFallback: true,
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-identity-'));
    tempDirs.push(dir);
    const rawPath = path.join(dir, 'malformed.eml');
    fs.writeFileSync(rawPath, Buffer.from([0xff, 0xfe, 0xfd]));

    const malformed = await parseEmailIdentity(rawPath, {
      subject: 'Malformed fallback',
      messageId: '<malformed@example.com>',
    });
    expect(malformed.parseFallback).toBe(true);
    expect(malformed.subject).toBe('Malformed fallback');
  });

  it('derives one conversation id across parsed messages in a thread', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-identity-'));
    tempDirs.push(dir);
    const firstPath = path.join(dir, 'first.eml');
    const replyPath = path.join(dir, 'reply.eml');
    fs.writeFileSync(
      firstPath,
      ['Subject: Launch', 'Message-ID: <root@example.com>', '', 'One'].join(
        '\r\n',
      ),
    );
    fs.writeFileSync(
      replyPath,
      [
        'Subject: Re: Launch',
        'Message-ID: <reply@example.com>',
        'References: <root@example.com>',
        'In-Reply-To: <root@example.com>',
        '',
        'Two',
      ].join('\r\n'),
    );

    const first = await parseEmailIdentity(firstPath, {});
    const reply = await parseEmailIdentity(replyPath, {});
    expect(selectEmailThreadId(first)).toBe('root@example.com');
    expect(selectEmailThreadId(reply)).toBe('root@example.com');
  });
});
