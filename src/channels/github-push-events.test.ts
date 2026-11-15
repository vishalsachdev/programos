import crypto from 'crypto';
import { EventEmitter } from 'events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.fn(() => ({ advanced: true, sha: 'new-sha' }));
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('../repo-reader.js', () => ({
  getRepoReader: () => ({ refresh, mirrorPath: '/tmp/read-mirror.git' }),
}));
vi.mock('../program-repo.js', () => ({
  CHECKOUT_OWNER: { uid: 1000, gid: 1000 },
  checkoutGitOptions: () => ({
    cwd: process.env.PROGRAM_REPO,
    env: process.env,
    timeout: 30_000,
  }),
  getProgramRepoPath: () => '/tmp/live-program-repo',
}));
vi.mock('../audit-log.js', () => ({
  logTerminalCommit: vi.fn(() => 'written'),
  logTripwireOnce: vi.fn(() => 'written'),
}));

import { logTerminalCommit, logTripwireOnce } from '../audit-log.js';
import { handleGithubPushRequest } from './github-push-events.js';

describe('GitHub protected-path tripwire', () => {
  beforeEach(() => {
    refresh.mockClear();
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: unknown) => void,
      ) => {
        if (command === 'git' && args.includes('diff')) {
          callback(null, {
            stdout: 'program/CURRICULUM.md\n',
            stderr: '',
          });
          return;
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );
  });

  it('alerts the owner when a non-admin commit changes a protected file', async () => {
    const secret = 'test-secret';
    const payload = JSON.stringify({
      ref: 'refs/heads/main',
      before: 'before',
      after: 'after',
      commits: [
        {
          id: 'abc123',
          timestamp: '2026-08-10T12:00:00Z',
          message: 'change allowlist',
          author: {
            name: 'Coordinator',
            email: 'program-bot@example.org',
          },
          added: [],
          modified: ['program/EMAIL_ALLOWLIST.md'],
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
    let responseBody = '';
    const res = {
      writeHead(code: number) {
        statusCode = code;
      },
      end(body = '') {
        responseBody = body;
      },
    };
    const alertOwner = vi.fn(async (_message: string) => {});

    handleGithubPushRequest(req as never, res as never, secret, alertOwner);
    req.emit('data', Buffer.from(payload));
    req.emit('end');
    await vi.waitFor(() => expect(statusCode).toBe(200));

    expect(responseBody).toBe('{"ok":true}');
    expect(alertOwner).toHaveBeenCalledOnce();
    expect(alertOwner.mock.calls[0][0]).toContain('[G39]');
    expect(alertOwner.mock.calls[0][0]).toContain('program/EMAIL_ALLOWLIST.md');
    expect(alertOwner.mock.calls[0][0]).toContain('program-bot@example.org');
  });

  it.each([
    ['program/CURRICULUM.md', '[G11]'],
    ['program/roles.md', '[G39]'],
  ])('covers every protected path family: %s', async (protectedPath, rule) => {
    const alertOwner = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: [protectedPath],
    });

    expect(alertOwner).toHaveBeenCalledOnce();
    expect(alertOwner.mock.calls[0][0]).toContain(rule);
    expect(alertOwner.mock.calls[0][0]).toContain(protectedPath);
  });

  it.each([
    ['avery.personal@gmail.com', ['program/EMAIL_ALLOWLIST.md']],
    ['avery@example.edu', ['program/CURRICULUM.md']],
    ['faculty@example.com', ['courses/CRS-554.md']],
  ])(
    'does not alert for an admin author or an unprotected path',
    async (authorEmail, modified) => {
      const alertOwner = await deliverPush({ authorEmail, modified });

      expect(alertOwner).not.toHaveBeenCalled();
    },
  );

  it('alerts on a forced main update whose commits list omits the protected change', async () => {
    const alertOwner = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: [],
      forced: true,
    });

    expect(alertOwner).toHaveBeenCalledOnce();
    expect(alertOwner.mock.calls[0][0]).toContain('[G11]');
    expect(alertOwner.mock.calls[0][0]).toContain('forced');
    expect(alertOwner.mock.calls[0][0]).toContain('program/CURRICULUM.md');
  });

  it('marks the delivery failed (500) when the owner alert fails', async () => {
    const result = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: ['program/CURRICULUM.md'],
      alertOwner: vi.fn(async (_message: string) => {
        throw new Error('Telegram unavailable');
      }),
    });

    expect(result.statusCode()).toBe(500);
    expect(result.responseBody()).toBe('error logged');
  });

  it('a failed owner alert does not abort audit logging for later commits', async () => {
    vi.mocked(logTerminalCommit).mockClear();
    const result = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: [],
      commits: [
        {
          id: 'c1'.repeat(20),
          timestamp: '2026-08-10T12:00:00Z',
          message: 'tamper curriculum',
          author: { name: 'A', email: 'faculty@example.com' },
          added: [],
          modified: ['program/CURRICULUM.md'],
          removed: [],
        },
        {
          id: 'c2'.repeat(20),
          timestamp: '2026-08-10T12:01:00Z',
          message: 'record decision',
          author: { name: 'B', email: 'faculty2@example.com' },
          added: [],
          modified: ['discussions/DECISIONS.md'],
          removed: [],
        },
      ],
      alertOwner: vi.fn(async (_message: string) => {
        throw new Error('Telegram unavailable');
      }),
    });

    // Both commits are audit-logged even though the tripwire alert failed…
    const loggedShas = vi
      .mocked(logTerminalCommit)
      .mock.calls.map(([entry]) => (entry as { sha: string }).sha);
    expect(loggedShas).toEqual(['c1'.repeat(20), 'c2'.repeat(20)]);
    // …and the delivery still surfaces as failed.
    expect(result.statusCode()).toBe(500);
  });

  it('skips the forced-update diff for all-zero SHAs (branch create/delete)', async () => {
    const alertOwner = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: [],
      forced: true,
      after: '0'.repeat(40),
    });

    expect(alertOwner.statusCode()).toBe(200);
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it('runs range-diff coverage for a possibly-truncated (20-commit) push', async () => {
    const alertOwner = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: [],
      commits: Array.from({ length: 20 }, (_, i) => ({
        id: `${i}`.padStart(2, '0').repeat(20),
        timestamp: '2026-08-10T12:00:00Z',
        message: `kb commit ${i}`,
        author: { name: 'A', email: 'faculty@example.com' },
        added: [],
        modified: ['discussions/DECISIONS.md'],
        removed: [],
      })),
    });

    // The mocked git diff reports program/CURRICULUM.md changed in the range;
    // no listed commit covers it, so the tripwire must fire despite !forced.
    expect(alertOwner.statusCode()).toBe(200);
    const tripwire = alertOwner.mock.calls.find(([m]) =>
      (m as string).includes('outside the webhook commit list'),
    );
    expect(tripwire).toBeDefined();
    expect(tripwire![0]).toContain('[G11]');
  });

  it('suppresses the range-diff alert when every range author is an admin', async () => {
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: unknown) => void,
      ) => {
        if (command === 'git' && args.includes('diff')) {
          callback(null, { stdout: 'program/CURRICULUM.md\n', stderr: '' });
          return;
        }
        if (command === 'git' && args.includes('log')) {
          callback(null, { stdout: 'avery@example.edu\n', stderr: '' });
          return;
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );
    const alertOwner = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: [],
      forced: true,
    });

    expect(alertOwner.statusCode()).toBe(200);
    expect(alertOwner).not.toHaveBeenCalled();
  });

  it('degrades to a manual-review alert when the forced-update diff fails', async () => {
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: unknown) => void,
      ) => {
        if (command === 'git' && args.includes('diff')) {
          callback(new Error('fatal: bad object'));
          return;
        }
        callback(null, { stdout: '', stderr: '' });
      },
    );
    const alertOwner = await deliverPush({
      authorEmail: 'faculty@example.com',
      modified: [],
      forced: true,
    });

    expect(alertOwner.statusCode()).toBe(200);
    expect(alertOwner).toHaveBeenCalledOnce();
    expect(alertOwner.mock.calls[0][0]).toContain('could not be diffed');
    // The undiffable-forced-push case must still leave a durable record.
    expect(vi.mocked(logTripwireOnce)).toHaveBeenCalledWith(
      expect.objectContaining({ paths: '(range not diffable)' }),
    );
  });
});

async function deliverPush({
  authorEmail,
  modified,
  forced = false,
  before = 'a'.repeat(40),
  after = 'b'.repeat(40),
  commits,
  alertOwner = vi.fn(async (_message: string) => {}),
}: {
  authorEmail: string;
  modified: string[];
  forced?: boolean;
  before?: string;
  after?: string;
  commits?: unknown[];
  alertOwner?: ReturnType<typeof vi.fn<(message: string) => Promise<void>>>;
}) {
  const secret = 'test-secret';
  const payload = JSON.stringify({
    ref: 'refs/heads/main',
    before,
    after,
    forced,
    commits: commits ?? [
      {
        id: 'def456',
        timestamp: '2026-08-10T12:00:00Z',
        message: 'test commit',
        author: { name: 'Test Author', email: authorEmail },
        added: [],
        modified,
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
  let responseBody = '';
  const res = {
    writeHead(code: number) {
      statusCode = code;
    },
    end(body = '') {
      responseBody = body;
    },
  };

  handleGithubPushRequest(req as never, res as never, secret, alertOwner);
  req.emit('data', Buffer.from(payload));
  req.emit('end');
  await vi.waitFor(() => expect(statusCode).not.toBe(0));
  return Object.assign(alertOwner, {
    statusCode: () => statusCode,
    responseBody: () => responseBody,
  });
}
