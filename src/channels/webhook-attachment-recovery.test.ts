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

const TEST_PORT = 39342;

vi.hoisted(() => {
  process.env.WEBHOOK_PORT = '39342';
  process.env.WEBHOOK_HOST = '127.0.0.1';
  // The quota tests below post 12 retries; pin the person cap to 10 so a
  // retry wrongly charged against quota still fails them (G19 v9.12 raised
  // the person default to 30).
  process.env.EMAIL_PERSON_SENDER_DAILY_CAP = '10';
});

const mocks = vi.hoisted(() => ({
  extractEmailAttachments: vi.fn(async () => []),
  telegramFetch: vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
  ),
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
    TELEGRAM_BOT_TOKEN: 'telegram-test-token',
    TELEGRAM_ADMIN_CHAT_ID: 'telegram-admin',
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
      relPath === 'program/EMAIL_ALLOWLIST.md'
        ? [
            '| Person | person@example.edu | Staff | read-write | Program |',
            '| Retrying Person | retrying-person@example.edu | Staff | read-write | Program |',
            '| Recovering Person | recovering-person@example.edu | Staff | read-write | Program |',
          ].join('\n')
        : null,
    ),
    readFileAsync: vi.fn(async () => null),
    readFileAtCreationAsync: vi.fn(async () => null),
    readFileBuffer: vi.fn((relPath: string) => {
      if (!relPath.endsWith('.eml')) return null;
      const id = path.basename(relPath, '.eml');
      return Buffer.from(
        [
          'From: person@example.edu',
          'To: program@example.org',
          'Subject: Course source files',
          `Message-ID: <${id}@example.com>`,
          '',
          'Body',
        ].join('\r\n'),
      );
    }),
  }),
}));

vi.mock('../document-extractor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../document-extractor.js')>();
  return {
    ...actual,
    extractEmailAttachments: mocks.extractEmailAttachments,
  };
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

function basePayload(): Record<string, unknown> {
  return {
    filename: '2026-08-10-course-source-files.md',
    subject: 'Course source files',
    from: 'person@example.edu',
    to: 'program@example.org',
    cc: '',
    date: '2026-08-10T15:00:00Z',
    message_id: '<message-50@example.com>',
  };
}

describe('webhook large-attachment recovery', () => {
  let repo: string;
  let disconnect: (() => Promise<void>) | undefined;
  type OnMessage = (
    chatJid: string,
    message: NewMessage,
    deliveryContext?: unknown,
  ) => void;
  let currentOnMessage: ReturnType<typeof vi.fn<OnMessage>>;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.telegramFetch);
    const channel = getChannelFactory('webhook')?.({
      onMessage: (...args) => currentOnMessage(...args),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');
    disconnect = () => channel.disconnect();
    await channel.connect();
  });

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-recovery-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    // The audit log is written in the host-owned repository (host-repo.ts).
    vi.stubEnv('PROGRAM_HOST_REPO', repo);
    mocks.extractEmailAttachments.mockClear();
    mocks.telegramFetch.mockClear();
    currentOnMessage = vi.fn<OnMessage>();
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

  it('durably records an accepted high-attachment receipt before processing', async () => {
    const onMessage = currentOnMessage;

    const response = await postJson({
      ...basePayload(),
      phase: 'accepted',
      attachment_count: 50,
    });
    const replay = await postJson({
      ...basePayload(),
      phase: 'accepted',
      attachment_count: 50,
    });

    expect(response.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(onMessage).not.toHaveBeenCalled();
    const auditDir = path.join(repo, 'discussions', 'audit-log');
    const audit = fs
      .readdirSync(auditDir)
      .map((file) => fs.readFileSync(path.join(auditDir, file), 'utf8'))
      .join('\n');
    expect(audit).toContain('**[EMAIL INTAKE RECEIPT]**');
    expect(audit).toContain('**Attachments:** 50');
    expect(mocks.telegramFetch).toHaveBeenCalledOnce();
    expect(mocks.telegramFetch.mock.calls[0][0]).toContain(
      '/bottelegram-test-token/sendMessage',
    );
    expect(
      JSON.parse(
        (mocks.telegramFetch.mock.calls[0][1] as RequestInit).body as string,
      ),
    ).toMatchObject({
      chat_id: 'telegram-admin',
      text: expect.stringContaining('50 files'),
    });
  });

  it('returns a retryable failure when the receipt cannot be written', async () => {
    const invalidRepo = path.join(repo, 'not-a-directory');
    fs.writeFileSync(invalidRepo, 'file');
    vi.stubEnv('PROGRAM_HOST_REPO', invalidRepo);
    const response = await postJson({
      ...basePayload(),
      phase: 'accepted',
      attachment_count: 50,
    });

    expect(response.status).toBe(503);
  });

  it('retries processing after an accepted request fails downstream', async () => {
    let attempts = 0;
    const onMessage = vi.fn((_jid: string, _message: NewMessage) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary downstream failure');
    });
    currentOnMessage = onMessage;

    const first = await postJson(basePayload());
    const second = await postJson(basePayload());

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('does not expand a high-attachment message into the agent prompt', async () => {
    const onMessage = currentOnMessage;

    const response = await postJson({
      ...basePayload(),
      raw_file_path: 'discussions/raw/message-high.eml',
      attachment_count: 50,
      attachment_state: 'partial',
    });

    expect(response.status).toBe(200);
    expect(mocks.extractEmailAttachments).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][1].content).toContain(
      '50 attachments were accepted',
    );
    expect(onMessage.mock.calls[0][1].content).toContain(
      'The attachment manifest is partial',
    );
  });

  it.each([
    ['pending', 'pending'],
    ['missing', undefined],
    ['malformed', 'complete'],
  ])(
    'keeps a high-attachment message retryable when its state is %s',
    async (_label, attachmentState) => {
      const onMessage = currentOnMessage;
      const payload = {
        ...basePayload(),
        message_id: `<message-high-${_label}@example.com>`,
        raw_file_path: `discussions/raw/message-high-${_label}.eml`,
        attachment_count: 50,
        ...(attachmentState === undefined
          ? {}
          : { attachment_state: attachmentState }),
      };

      const first = await postJson(payload);
      const completed = await postJson({
        ...payload,
        attachment_state: 'ready',
      });

      expect(first.status).toBe(503);
      expect(first.body).toContain('attachment-manifest-not-terminal');
      expect(completed.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
    },
  );

  it('does not charge repeated pending-manifest retries against sender quota', async () => {
    const onMessage = currentOnMessage;
    const payload = {
      ...basePayload(),
      from: 'retrying-person@example.edu',
      message_id: '<message-high-repeated@example.com>',
      raw_file_path: 'discussions/raw/message-high-repeated.eml',
      attachment_count: 50,
      attachment_state: 'pending',
    };

    const pendingResponses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      pendingResponses.push(await postJson(payload));
    }
    const completed = await postJson({
      ...payload,
      attachment_state: 'ready',
    });

    expect(pendingResponses.every(({ status }) => status === 503)).toBe(true);
    expect(completed.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('does not charge retryable downstream failures against sender quota', async () => {
    let attempts = 0;
    const onMessage = vi.fn((_jid: string, _message: NewMessage) => {
      attempts += 1;
      if (attempts <= 12) throw new Error('temporary downstream failure');
    });
    currentOnMessage = onMessage;
    const payload = {
      ...basePayload(),
      from: 'recovering-person@example.edu',
      message_id: '<message-repeated-failure@example.com>',
    };

    const failedResponses = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      failedResponses.push(await postJson(payload));
    }
    const completed = await postJson(payload);

    expect(failedResponses.every(({ status }) => status === 503)).toBe(true);
    expect(completed.status).toBe(200);
    expect(onMessage).toHaveBeenCalledTimes(13);
  });
});
