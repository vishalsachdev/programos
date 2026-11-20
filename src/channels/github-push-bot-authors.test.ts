import crypto from 'crypto';
import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

// The intake service's pushes and the bot's own pushes refresh the mirror but
// are not written to the audit log as terminal commits. Both identities come
// from settings (INTAKE_GIT_AUTHOR_EMAIL, BOT_MAIL_DOMAIN).

vi.hoisted(() => {
  process.env.INTAKE_GIT_AUTHOR_EMAIL = 'intake@mail.test';
  process.env.BOT_MAIL_DOMAIN = 'bot.test';
});

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('../repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: () => ({ advanced: true, sha: 'new-sha' }),
    mirrorPath: '/tmp/read-mirror.git',
  }),
}));
vi.mock('../audit-log.js', () => ({
  logTerminalCommit: vi.fn(() => 'written'),
  logTripwireOnce: vi.fn(() => 'written'),
}));

import { logTerminalCommit } from '../audit-log.js';
import { handleGithubPushRequest } from './github-push-events.js';

async function push(authorEmail: string): Promise<number> {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: unknown) => void,
    ) => callback(null, { stdout: '', stderr: '' }),
  );
  const secret = 'test-secret';
  const payload = JSON.stringify({
    ref: 'refs/heads/main',
    before: 'before',
    after: 'after',
    commits: [
      {
        id: 'abc123',
        timestamp: '2026-08-10T12:00:00Z',
        message: 'update the FAQ',
        author: { name: 'Someone', email: authorEmail },
        added: [],
        modified: ['docs/faq.md'],
        removed: [],
      },
    ],
  });
  const req = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
  };
  req.headers = {
    'x-hub-signature-256':
      'sha256=' +
      crypto.createHmac('sha256', secret).update(payload).digest('hex'),
  };
  let statusCode = 0;
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end() {},
  };
  vi.mocked(logTerminalCommit).mockClear();
  handleGithubPushRequest(req as never, res as never, secret, async () => {});
  req.emit('data', Buffer.from(payload));
  req.emit('end');
  await vi.waitFor(() => expect(statusCode).toBe(200));
  return vi.mocked(logTerminalCommit).mock.calls.length;
}

describe('bot authors on the push webhook follow the settings', () => {
  it('does not log a push by the configured intake author or bot author', async () => {
    expect(await push('intake@mail.test')).toBe(0);
    expect(await push('program-bot@bot.test')).toBe(0);
  });

  // Review finding on PR 28 (Bugbot): the settings are lower-cased, and the
  // commit author was compared as git wrote it.
  it('matches the intake and bot authors whatever the case of the commit author', async () => {
    expect(await push('Intake@Mail.Test')).toBe(0);
    expect(await push('Program-Bot@BOT.test')).toBe(0);
  });

  it('logs the placeholder identities like any other author once replaced', async () => {
    expect(await push('email-inbox@example.org')).toBe(1);
    expect(await push('program-bot@example.org')).toBe(1);
    expect(await push('person@uni.test')).toBe(1);
  });
});
