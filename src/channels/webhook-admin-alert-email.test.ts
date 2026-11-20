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

// ADMIN_ALERT_ROUTE=email with NO Telegram token: every operator alert the
// webhook channel raises must still be delivered, as one mail to the
// operator address, and nothing may call the Telegram API.

// The system assigns a free port at connect(); see connectOnFreePort.
let TEST_PORT = 0;
const OPERATOR = 'avery-ops@example.edu';
const RAW = 'discussions/raw/2026-10-24-re-admissions-updates.md';
const SVIX_SECRET_BYTES = Buffer.from('admin-alert-route-test-secret');
const SVIX_SECRET = `whsec_${SVIX_SECRET_BYTES.toString('base64')}`;

vi.hoisted(() => {
  process.env.WEBHOOK_PORT = '0';
  process.env.WEBHOOK_HOST = '127.0.0.1';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ADMIN_CHAT_ID;
  delete process.env.ADMIN_ALERT_ROUTE;
});

interface SentMail {
  email: { to: string; cc?: string; subject: string; body: string };
  opts: {
    sourceGroup: string;
    lane?: string;
    extraHeaders?: Record<string, string>;
    allowlistState?: { senders: Set<string> };
  };
}

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    throw new Error('no network call is expected in this test');
  }),
  sent: [] as unknown[],
  openQuestions: { value: '' },
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
    RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from('admin-alert-route-test-secret').toString('base64')}`,
    GITHUB_PUSH_WEBHOOK_SECRET: 'push-secret',
    OPERATOR_CC_EMAIL: 'avery-ops@example.edu',
    ADMIN_ALERT_ROUTE: 'email',
    ASSISTANT_NAME: 'Coordinator',
    // No TELEGRAM_BOT_TOKEN and no TELEGRAM_ADMIN_CHAT_ID.
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
      '| Avery Morgan (PeerAgent Agent) | agent@example.com | **agent** (owner: Avery) | read-write | G52 agent principal · **coordinator-cohort: agent** |',
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
    refresh: vi.fn(() => ({ advanced: true, sha: 'abc123' })),
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
    sendOutboundEmailResult: async (email: unknown, opts: unknown) => {
      mocks.sent.push({ email, opts });
      return { status: 'sent', resendId: 're_test_id' } as const;
    },
    sendOutboundEmail: async (email: unknown, opts: unknown) => {
      mocks.sent.push({ email, opts });
      return true;
    },
    peekOutboundEmailResult: () => ({ state: 'none' as const }),
  };
});

import './webhook.js';
import { connectOnFreePort } from '../test-support/webhook-test-port.js';
import { ADMIN_ALERT_MAIL_HEADERS } from '../admin-alert.js';
import { flushAuditLog } from '../audit-log.js';
import { _closeDatabase, _initTestDatabase } from '../db.js';
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

function postMail(payload: Record<string, unknown>) {
  return post('/', JSON.stringify(payload), {
    authorization: 'Bearer test-secret',
  });
}

function pushEvent(commits: unknown[]) {
  const body = JSON.stringify({ ref: 'refs/heads/main', commits });
  const sig = `sha256=${crypto.createHmac('sha256', 'push-secret').update(body).digest('hex')}`;
  return post('/api/github-push', body, { 'x-hub-signature-256': sig });
}

function resendEvent(event: Record<string, unknown>) {
  const body = JSON.stringify(event);
  const id = 'msg_admin_alert';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    'v1,' +
    crypto
      .createHmac('sha256', SVIX_SECRET_BYTES)
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
  return post('/resend/webhook', body, {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': signature,
  });
}

function alertMails(): SentMail[] {
  return (mocks.sent as SentMail[]).filter(
    ({ opts }) => opts.sourceGroup === 'admin-alert',
  );
}

async function expectOneAlertMail(bodyPart: string): Promise<SentMail> {
  await vi.waitFor(() => expect(alertMails()).toHaveLength(1));
  const [mail] = alertMails();
  expect(mail.email.to).toBe(OPERATOR);
  expect(mail.email.cc).toBeUndefined();
  expect(mail.email.body).toContain(bodyPart);
  expect(mail.email.subject.startsWith('[')).toBe(true);
  expect(mail.email.subject).toContain(' alert] ');
  expect(mail.opts.lane).toBe('alert');
  expect(mail.opts.extraHeaders).toMatchObject(ADMIN_ALERT_MAIL_HEADERS);
  expect([...mail.opts.allowlistState!.senders]).toEqual([OPERATOR]);
  return mail;
}

describe('webhook operator alerts with ADMIN_ALERT_ROUTE=email and no Telegram token', () => {
  let repo: string;
  let disconnect: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    expect(SVIX_SECRET).toContain('whsec_');
    vi.stubGlobal('fetch', mocks.fetch);
    const channel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');
    disconnect = () => channel.disconnect();
    TEST_PORT = await connectOnFreePort(channel);
  });

  beforeEach(() => {
    _initTestDatabase();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-alert-route-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    // The audit log is written in the host-owned repository (host-repo.ts).
    vi.stubEnv('PROGRAM_HOST_REPO', repo);
    mocks.fetch.mockClear();
    mocks.sent.length = 0;
    mocks.openQuestions.value = '# Open questions\n\n## Routed Approvals\n';
  });

  afterEach(() => {
    // The Telegram API (or any other host) was never called.
    expect(mocks.fetch).not.toHaveBeenCalled();
    flushAuditLog();
    _closeDatabase();
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  afterAll(async () => {
    await disconnect?.();
    vi.unstubAllGlobals();
  });

  const highAttachment = {
    filename: '2026-08-10-course-source-files.md',
    subject: 'Course source files',
    from: 'jhl@example.edu',
    to: 'program@example.org',
    cc: '',
    date: '2026-08-10T15:00:00Z',
    message_id: '<message-50@example.com>',
    phase: 'accepted',
    attachment_count: 50,
  };

  it('high-attachment receipt accepted', async () => {
    expect((await postMail(highAttachment)).status).toBe(202);
    await expectOneAlertMail('High-attachment email accepted (50 files)');
  });

  it('high-attachment receipt that could not be written to the audit log', async () => {
    const notADirectory = path.join(repo, 'not-a-directory');
    fs.writeFileSync(notADirectory, 'file');
    vi.stubEnv('PROGRAM_HOST_REPO', notADirectory);
    expect((await postMail(highAttachment)).status).toBe(503);
    await expectOneAlertMail('Email intake audit failed');
  });

  it('sender cap reached', async () => {
    for (let i = 1; i <= 11; i += 1) {
      const response = await postMail({
        filename: `2026-10-23-agent-${i}.md`,
        subject: 'Re: Coordinator Weekly Digest',
        from: 'agent@example.com',
        to: 'program@example.org',
        cc: '',
        date: '2026-10-23T15:00:00Z',
        message_id: `<agent-${i}@example.com>`,
      });
      expect(response.status).toBe(200);
    }
    const mail = await expectOneAlertMail('sender cap reached (G19)');
    expect(mail.email.body).toContain('From: agent@example.com');
  });

  it('routed-approval notice', async () => {
    const intake = await postMail({
      filename: '2026-10-24-re-admissions-updates.md',
      subject: 'Re: Admissions updates',
      from: 'jhl@example.edu',
      to: 'program@example.org',
      cc: '',
      date: '2026-10-24T15:00:00Z',
      message_id: '<june-1024@example.edu>',
      inbound_text:
        'Hi Coordinator, the webinar series moves to Thursdays starting in November. June',
    });
    expect(intake.status).toBe(200);
    mocks.openQuestions.value = [
      '# Open questions',
      '',
      '## Routed Approvals',
      '',
      `- [ ] **Routed to Omar Haddad (ohaddad): admissions updates** (Sender: jhl@example.edu; Approver: ohaddad@example.edu; Raw: ${RAW}) (Added: 2026-10-24)`,
      `  - Sender's words: "The webinar series moves to Thursdays starting in November."`,
    ].join('\n');

    expect((await pushEvent([])).status).toBe(200);

    await expectOneAlertMail('routed approval (G42)');
    // The relay to the approver is a separate, ordinary mail.
    expect(
      (mocks.sent as SentMail[]).some(
        ({ opts }) => opts.sourceGroup === 'routed-approval',
      ),
    ).toBe(true);
  });

  it('mail provider reports a bounce', async () => {
    const response = await resendEvent({
      type: 'email.bounced',
      data: {
        email_id: 're_bounced',
        to: ['person@example.edu'],
        subject: 'Weekly digest',
        bounce: { message: 'mailbox full' },
      },
    });
    expect(response.status).toBe(200);
    const mail = await expectOneAlertMail('Email bounced');
    expect(mail.email.body).toContain('To: person@example.edu');
  });

  it('a bounce of an alert mail is not answered with another alert mail', async () => {
    const response = await resendEvent({
      type: 'email.bounced',
      data: {
        email_id: 're_alert_bounced',
        to: [OPERATOR],
        subject: '[Coordinator alert] Disk is full',
        bounce: { message: 'mailbox full' },
      },
    });
    // Logged, answered 200 so the provider does not redeliver, and not mailed.
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alertMails()).toHaveLength(0);
  });

  it('protected-path push by a non-admin author', async () => {
    const response = await pushEvent([
      {
        id: 'abc123abc123abc123abc123abc123abc123abc1',
        timestamp: '2026-08-10T12:00:00Z',
        message: 'change allowlist',
        author: { name: 'Someone', email: 'someone@example.com' },
        added: [],
        modified: ['program/EMAIL_ALLOWLIST.md'],
        removed: [],
      },
    ]);
    expect(response.status).toBe(200);
    const mail = await expectOneAlertMail('Protected-path tripwire');
    expect(mail.email.body).toContain('program/EMAIL_ALLOWLIST.md');
  });

  it('Box update notification', async () => {
    const response = await postMail({
      filename: '2026-10-25-box-update.md',
      subject: 'Course Map was updated',
      from: 'noreply@box.com',
      to: 'program@example.org',
      cc: '',
      date: '2026-10-25T15:00:00Z',
      message_id: '<box-1@box.com>',
    });
    expect(response.status).toBe(200);
    await expectOneAlertMail('Box update detected');
  });

  it('no call site in webhook.ts bypasses the route', () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, 'webhook.ts'),
      'utf8',
    );
    const directCalls = source
      .split('\n')
      .filter(
        (line) =>
          line.includes('pingAdminViaTelegram(') &&
          !line.includes('async function pingAdminViaTelegram('),
      )
      .map((line) => line.trim());
    // The only caller of the Telegram transport is the route function.
    expect(directCalls).toEqual([
      'sendAdminAlert(text, { telegram: () => pingAdminViaTelegram(text) });',
    ]);
    // Every alert in the channel goes through alertAdmin: the two
    // high-attachment alerts, the sender-cap alert and its retry, the
    // routed-approval notice, provider delivery problems, the protected-path
    // tripwire and the Box notification.
    expect(source.match(/\balertAdmin\(/g)).toHaveLength(7);
    expect(source).toContain('pingOwner: alertAdmin,');
  });
});
