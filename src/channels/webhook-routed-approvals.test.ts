import crypto from 'crypto';
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

// Routed approvals end to end on the host: intake keeps the host's copy of
// the email, a GitHub push of the Routed Approvals entry starts the scan, and
// the host relays to the approver from the sender's allowlist row.

const TEST_PORT = 39344;

vi.hoisted(() => {
  process.env.WEBHOOK_PORT = '39344';
  process.env.WEBHOOK_HOST = '127.0.0.1';
});

const RAW = 'discussions/raw/2026-10-24-re-admissions-updates.md';

const mocks = vi.hoisted(() => ({
  telegramFetch: vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
  ),
  sendOutboundEmailResult: vi.fn(
    async (..._args: unknown[]) =>
      ({ status: 'sent', resendId: 're_relay' }) as const,
  ),
  openQuestions: { value: '' },
  advanced: { value: true },
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
    TELEGRAM_BOT_TOKEN: 'telegram-test-token',
    TELEGRAM_ADMIN_CHAT_ID: 'telegram-admin',
    GITHUB_PUSH_WEBHOOK_SECRET: 'push-secret',
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

function readKb(relPath: string): string | null {
  if (relPath === 'program/EMAIL_ALLOWLIST.md') {
    return [
      '| Avery Morgan | avery@example.edu | Director | read-write | Program Director · **coordinator-cohort: founding** |',
      '| Omar Haddad | ohaddad@example.edu | Staff | read-write | Oversight · **coordinator-cohort: founding** |',
      '| June Hale | jhl@example.edu | Admissions | read-only | Admissions. Any updates she sends route to **Omar Haddad (ohaddad)** for approval · **coordinator-cohort: team-expansion** |',
    ].join('\n');
  }
  if (relPath === 'discussions/OPEN_QUESTIONS.md') {
    return mocks.openQuestions.value;
  }
  return null;
}

vi.mock('../repo-reader.js', () => ({
  getRepoReader: () => ({
    mirrorPath: '/tmp/missing-mirror',
    refresh: vi.fn(() => ({ advanced: mocks.advanced.value, sha: 'abc123' })),
    readFile: vi.fn(readKb),
    readFileAsync: vi.fn(async (relPath: string) => readKb(relPath)),
    readFileAtCreationAsync: vi.fn(async () => null),
    readFileBuffer: vi.fn(() => null),
    commitExists: vi.fn(() => true),
  }),
}));

vi.mock('../outbound-email.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../outbound-email.js')>();
  return {
    ...actual,
    sendOutboundEmailResult: mocks.sendOutboundEmailResult,
    peekOutboundEmailResult: () => ({ state: 'none' as const }),
  };
});

import './webhook.js';
import { flushAuditLog } from '../audit-log.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getRoutedApprovalEvidence,
} from '../db.js';
import { getChannelFactory } from './registry.js';

function post(
  urlPath: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: urlPath,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
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
    req.end(body);
  });
}

function pushEvent(): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ ref: 'refs/heads/main', commits: [] });
  const sig = `sha256=${crypto.createHmac('sha256', 'push-secret').update(body).digest('hex')}`;
  return post('/api/github-push', body, { 'x-hub-signature-256': sig });
}

const ENTRY = [
  '# Open questions',
  '',
  '## Routed Approvals',
  '',
  `- [ ] **Routed to Omar Haddad (ohaddad): admissions updates** (Sender: jhl@example.edu; Approver: ohaddad@example.edu; Raw: ${RAW}) (Added: 2026-10-24)`,
  `  - Sender's words: "The webinar series moves to Thursdays starting in November."`,
].join('\n');

describe('routed approvals at the webhook', () => {
  let repo: string;
  let disconnect: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    vi.stubGlobal('fetch', mocks.telegramFetch);
    const channel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');
    disconnect = () => channel.disconnect();
    await channel.connect();
  });

  beforeEach(() => {
    _initTestDatabase();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'routed-approvals-'));
    fs.mkdirSync(path.join(repo, '.git'));
    vi.stubEnv('PROGRAM_REPO', repo);
    mocks.telegramFetch.mockClear();
    mocks.sendOutboundEmailResult.mockClear();
    mocks.openQuestions.value = '# Open questions\n\n## Routed Approvals\n';
    mocks.advanced.value = true;
  });

  afterEach(() => {
    flushAuditLog();
    _closeDatabase();
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  afterAll(async () => {
    await disconnect?.();
    vi.unstubAllGlobals();
  });

  it('keeps the host copy at intake, then relays on the push of the entry', async () => {
    const intake = await post(
      '/',
      JSON.stringify({
        filename: '2026-10-24-re-admissions-updates.md',
        subject: 'Re: Admissions updates',
        from: 'jhl@example.edu',
        to: 'program@example.org',
        cc: '',
        date: '2026-10-24T15:00:00Z',
        message_id: '<june-1024@example.edu>',
        inbound_text:
          'Hi Coordinator, the webinar series moves to Thursdays starting in November. June',
      }),
      { authorization: 'Bearer test-secret' },
    );
    expect(intake.status).toBe(200);
    expect(getRoutedApprovalEvidence(RAW)).toMatchObject({
      sender: 'jhl@example.edu',
      subject: 'Re: Admissions updates',
      // The intake identity stores the Message-ID without angle brackets.
      messageId: 'june-1024@example.edu',
    });

    mocks.openQuestions.value = ENTRY;
    expect((await pushEvent()).status).toBe(200);

    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmailResult).toHaveBeenCalledOnce(),
    );
    const [email, opts] = mocks.sendOutboundEmailResult.mock.calls[0] as [
      { to: string; cc?: string; subject: string; body: string },
      { sourceGroup: string; deliveryId: string },
    ];
    expect(email).toMatchObject({
      to: 'ohaddad@example.edu',
      cc: 'jhl@example.edu',
      subject: 'For your approval: Admissions updates',
    });
    expect(email.body).toContain(
      '"The webinar series moves to Thursdays starting in November."',
    );
    expect(opts.sourceGroup).toBe('routed-approval');
    await vi.waitFor(() => expect(mocks.telegramFetch).toHaveBeenCalled());
    const telegram = JSON.parse(
      (mocks.telegramFetch.mock.calls[0][1] as RequestInit).body as string,
    ).text;
    expect(telegram).toContain('Coordinator routed approval (G42)');
  });

  it('does not scan on a push that did not advance the mirror', async () => {
    mocks.openQuestions.value = ENTRY;
    mocks.advanced.value = false;
    expect((await pushEvent()).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.telegramFetch).not.toHaveBeenCalled();
    expect(mocks.sendOutboundEmailResult).not.toHaveBeenCalled();
  });
});
