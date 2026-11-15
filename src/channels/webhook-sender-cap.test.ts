import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// G19 (v9.12): a person on the allowlist gets 30 turns per 24h, an agent
// principal 10; the first over-cap message alerts Avery once and sends a
// person (never an agent) one notice.

const TEST_PORT = 39343;

vi.hoisted(() => {
  process.env.WEBHOOK_PORT = '39343';
  process.env.WEBHOOK_HOST = '127.0.0.1';
});

const mocks = vi.hoisted(() => ({
  telegramFetch: vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
  ),
  sendOutboundEmail: vi.fn(async (..._args: unknown[]) => true),
  allowlistReadable: { value: true },
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
    TELEGRAM_BOT_TOKEN: 'telegram-test-token',
    TELEGRAM_ADMIN_CHAT_ID: 'telegram-admin',
    OPERATOR_CC_EMAIL: 'avery-cc@example.edu',
  }),
}));

vi.mock('../program-repo.js', () => ({
  CHECKOUT_OWNER: { uid: 1000, gid: 1000 },
  checkoutGitOptions: () => ({
    cwd: process.env.PROGRAM_REPO,
    env: process.env,
    timeout: 30_000,
  }),
  getProgramRepoPath: () => process.env.PROGRAM_REPO || '/tmp/missing',
}));

vi.mock('../repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: vi.fn(),
    readFile: vi.fn((relPath: string) =>
      relPath === 'program/EMAIL_ALLOWLIST.md' && mocks.allowlistReadable.value
        ? [
            '| Busy Person | busy-person@example.edu | Professor | read-only | Research observer · **coordinator-cohort: observer** |',
            '| Quiet Person | quiet-person@example.edu | Professor | read-only | Research observer · **coordinator-cohort: observer** |',
            '| Retry Person | retry-person@example.edu | Professor | read-only | Research observer · **coordinator-cohort: observer** |',
            '| Throw Person | throw-person@example.edu | Professor | read-only | Research observer · **coordinator-cohort: observer** |',
            '| Snapshot Person | snapshot-person@example.edu | Professor | read-only | Research observer · **coordinator-cohort: observer** |',
            '| Avery Morgan (PeerAgent Agent) | agent@example.com | **agent** (owner: Avery) | read-write | G52 agent principal · **coordinator-cohort: agent** |',
          ].join('\n')
        : null,
    ),
    readFileAsync: vi.fn(async () => null),
    readFileAtCreationAsync: vi.fn(async () => null),
    readFileBuffer: vi.fn(() => null),
  }),
}));

vi.mock('../outbound-email.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../outbound-email.js')>();
  return { ...actual, sendOutboundEmail: mocks.sendOutboundEmail };
});

import './webhook.js';
import { flushAuditLog } from '../audit-log.js';
import type { NewMessage } from '../types.js';
import { getChannelFactory } from './registry.js';

function postJson(payload: Record<string, unknown>): Promise<{
  status: number;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/',
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

async function sendFrom(from: string, n: number, tag: string) {
  const responses = [];
  for (let i = 1; i <= n; i += 1) {
    responses.push(
      await postJson({
        filename: `2026-10-23-${tag}-${i}.md`,
        subject: 'Re: Coordinator Weekly Digest',
        from,
        to: 'program@example.org',
        cc: '',
        date: '2026-10-23T15:00:00Z',
        message_id: `<${tag}-${i}@example.com>`,
      }),
    );
  }
  return responses;
}

function telegramTexts(): string[] {
  return mocks.telegramFetch.mock.calls.map(
    (call) => JSON.parse((call[1] as RequestInit).body as string).text,
  );
}

describe('G19 tiered sender cap at the webhook', () => {
  let repo: string;
  let disconnect: (() => Promise<void>) | undefined;
  const onMessage = vi.fn(
    (_jid: string, _message: NewMessage, _deliveryContext?: unknown) => {},
  );

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.telegramFetch);
    const channel = getChannelFactory('webhook')?.({
      onMessage: (...args) => onMessage(...args),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');
    disconnect = () => channel.disconnect();
    await channel.connect();
  });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-cap-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    vi.stubEnv('PROGRAM_REPO', repo);
    mocks.telegramFetch.mockClear();
    mocks.telegramFetch.mockImplementation(
      async () => new Response('{}', { status: 200 }),
    );
    mocks.sendOutboundEmail.mockClear();
    onMessage.mockClear();
  });

  afterEach(() => {
    flushAuditLog();
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  afterAll(async () => {
    await disconnect?.();
    vi.unstubAllGlobals();
  });

  it('processes a person past the old cap, then alerts and notifies once at 31', async () => {
    const first30 = await sendFrom('busy-person@example.edu', 30, 'busy');
    expect(first30.every(({ body }) => !body.includes('skipped'))).toBe(true);
    expect(onMessage).toHaveBeenCalledTimes(30);

    const over = await sendFrom('busy-person@example.edu', 1, 'busy-over');
    expect(over[0].status).toBe(200);
    expect(JSON.parse(over[0].body)).toMatchObject({
      skipped: true,
      reason: 'sender quota exceeded (31/30 per 24h)',
    });
    expect(onMessage).toHaveBeenCalledTimes(30);

    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce(),
    );
    expect(telegramTexts()).toHaveLength(1);
    expect(telegramTexts()[0]).toContain(
      'Coordinator sender cap reached (G19)',
    );
    expect(telegramTexts()[0]).toContain(
      'busy-person@example.edu (person on the allowlist)',
    );
    expect(telegramTexts()[0]).toContain(
      'Message-ID: <busy-over-1@example.com>',
    );
    expect(telegramTexts()[0]).toContain(
      'Coordinator is sending the sender one notice.',
    );
    const [message, options] = mocks.sendOutboundEmail.mock.calls[0] as [
      { to: string; cc?: string; subject: string; body: string },
      { inReplyTo?: string; extraHeaders?: Record<string, string> },
    ];
    expect(message.to).toBe('busy-person@example.edu');
    expect(message.cc).toBeUndefined();
    expect(message.subject).toBe('Re: Coordinator Weekly Digest');
    expect(message.body).toContain('30 messages in the last 24 hours');
    expect(message.body).toContain('Avery Morgan has been told');
    expect(options.inReplyTo).toBe('<busy-over-1@example.com>');
    expect(options.extraHeaders).toMatchObject({
      'Auto-Submitted': 'auto-replied',
    });

    // Later over-cap mail in the same window: dropped, no second alert or notice.
    await sendFrom('busy-person@example.edu', 2, 'busy-later');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(telegramTexts()).toHaveLength(1);
    expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce();
  });

  it('keeps the cap of 10 for an agent principal and sends it no notice', async () => {
    const first10 = await sendFrom('agent@example.com', 10, 'agent');
    expect(first10.every(({ body }) => !body.includes('skipped'))).toBe(true);

    const over = await sendFrom('agent@example.com', 1, 'agent-over');
    expect(JSON.parse(over[0].body)).toMatchObject({
      skipped: true,
      reason: 'sender quota exceeded (11/10 per 24h)',
    });

    await vi.waitFor(() => expect(telegramTexts()).toHaveLength(1));
    expect(telegramTexts()[0]).toContain(
      'agent@example.com (agent principal or unverified sender)',
    );
    expect(telegramTexts()[0]).toContain('No notice goes to the sender.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.sendOutboundEmail).not.toHaveBeenCalled();
  });

  it('does not tell a person that Avery knows when the alert failed and the CC would be dropped', async () => {
    // OPERATOR_CC_EMAIL (avery-cc@example.edu) is not on this allowlist, so
    // the send would drop it: no CC, and no claim.
    mocks.telegramFetch.mockImplementation(
      async () => new Response('{}', { status: 400 }),
    );

    await sendFrom('quiet-person@example.edu', 31, 'quiet');

    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce(),
    );
    const [message] = mocks.sendOutboundEmail.mock.calls[0] as [
      { cc?: string; body: string },
    ];
    expect(message.cc).toBeUndefined();
    expect(message.body).not.toContain('Avery');
    expect(message.body).toContain('The limit resets on');
  });

  it('retries a failed alert on the next over-cap message without a second notice', async () => {
    mocks.telegramFetch.mockImplementation(
      async () => new Response('{}', { status: 400 }),
    );
    await sendFrom('retry-person@example.edu', 31, 'retry');
    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(telegramTexts()).toHaveLength(1));

    mocks.telegramFetch.mockImplementation(
      async () => new Response('{}', { status: 200 }),
    );
    await sendFrom('retry-person@example.edu', 1, 'retry-again');

    await vi.waitFor(() => expect(telegramTexts()).toHaveLength(2));
    expect(telegramTexts()[1]).toContain('went with an earlier message');
    await sendFrom('retry-person@example.edu', 1, 'retry-after-sent');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(telegramTexts()).toHaveLength(2);
    expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce();
  });

  it('still releases a failed alert when the notice send throws', async () => {
    // A throwing notice used to skip the release.
    mocks.telegramFetch.mockImplementation(
      async () => new Response('{}', { status: 400 }),
    );
    mocks.sendOutboundEmail.mockRejectedValueOnce(
      new Error('outbox insert failed'),
    );
    await sendFrom('throw-person@example.edu', 31, 'throw');
    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() => expect(telegramTexts()).toHaveLength(1));

    mocks.telegramFetch.mockImplementation(
      async () => new Response('{}', { status: 200 }),
    );
    await sendFrom('throw-person@example.edu', 1, 'throw-again');

    await vi.waitFor(() => expect(telegramTexts()).toHaveLength(2));
    expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce();
  });

  it('sends the notice with the allowlist that admitted the message, not a later failed refresh', async () => {
    // Hold the first Telegram attempt open, let another
    // message refresh the allowlist (unreadable, past the 5-minute TTL),
    // then release Telegram: the notice must still carry the intake list.
    let releaseTelegram: (response: Response) => void = () => {};
    mocks.telegramFetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseTelegram = resolve;
        }),
    );
    await sendFrom('snapshot-person@example.edu', 31, 'snapshot');
    await vi.waitFor(() => expect(mocks.telegramFetch).toHaveBeenCalledOnce());

    const realNow = Date.now;
    const later = realNow() + 10 * 60 * 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => later);
    mocks.allowlistReadable.value = false;
    try {
      await sendFrom('busy-person@example.edu', 1, 'snapshot-refresh');
      releaseTelegram(new Response('{}', { status: 200 }));
      await vi.waitFor(() =>
        expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce(),
      );
    } finally {
      mocks.allowlistReadable.value = true;
      vi.mocked(Date.now).mockRestore();
    }

    const [message, options] = mocks.sendOutboundEmail.mock.calls[0] as [
      { to: string },
      { allowlistState: { available: boolean; senders: Set<string> } },
    ];
    expect(message.to).toBe('snapshot-person@example.edu');
    expect(options.allowlistState.available).toBe(true);
    expect(
      options.allowlistState.senders.has('snapshot-person@example.edu'),
    ).toBe(true);
  });
});
