import { execFileSync } from 'child_process';
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

// Sender authentication on the email path: the verdict from
// `src/email-auth.ts`, the audit entry, and what EMAIL_AUTH_MODE=enforce
// changes. The messages are the synthetic fixtures of `inbound/`; the `auth`
// field is what the intake worker would send (`inbound/src/auth.ts`).

const TEST_PORT = 39348;

const hoisted = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/programos-email-auth-${process.pid}`;
  process.env.WEBHOOK_PORT = '39348';
  process.env.WEBHOOK_HOST = '127.0.0.1';
  process.env.INSTITUTION_DOMAIN = 'example.edu';
  // The real reader is used, pointed at a mirror this test creates.
  process.env.PROGRAM_READ_MIRROR = `${dir}/mirror.git`;
  return { dir };
});

const mocks = vi.hoisted(() => ({
  sendOutboundEmail: vi.fn(async (..._args: unknown[]) => true),
  telegramFetch: vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{}', { status: 200 }),
  ),
  sendOutboundEmailResult: vi.fn(
    async (..._args: unknown[]) =>
      ({ status: 'sent', resendId: 're_relay' }) as const,
  ),
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

vi.mock('../outbound-email.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../outbound-email.js')>();
  return {
    ...actual,
    sendOutboundEmailResult: mocks.sendOutboundEmailResult,
    sendOutboundEmail: mocks.sendOutboundEmail,
    peekOutboundEmailResult: () => ({ state: 'none' as const }),
  };
});

const audit = vi.hoisted(() => ({
  logEmailAuthentication: vi.fn(),
  logDroppedEmail: vi.fn(),
}));

vi.mock('../audit-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit-log.js')>()),
  logEmailAuthentication: audit.logEmailAuthentication,
  logDroppedEmail: audit.logDroppedEmail,
}));

import './webhook.js';
import { flushAuditLog } from '../audit-log.js';
import { _closeDatabase, _initTestDatabase } from '../db.js';
import { getChannelFactory } from './registry.js';

const FIXTURES = path.join(process.cwd(), 'inbound', 'fixtures');

interface Contract {
  gitAuthorName: string;
  gitAuthorEmail: string;
  cases: string[];
}

interface WorkerPayload {
  filename: string;
  subject: string;
  from: string;
  message_id: string;
  raw_file_path: string;
  eml_file_path: string;
  auth?: unknown;
}

const contract: Contract = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'contract.json'), 'utf-8'),
);

function payloadOf(name: string): WorkerPayload {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.expected.json`), 'utf-8'),
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf-8' },
  );
}

const upstream = path.join(hoisted.dir, 'upstream');

/** Both files in one commit by the intake author: what the worker does. */
function commitAsWorker(
  name: string,
  authorEmail = contract.gitAuthorEmail,
): WorkerPayload {
  const payload = payloadOf(name);
  for (const [rel, source] of [
    [payload.eml_file_path, `${name}.eml`],
    [payload.raw_file_path, `${name}.expected.md`],
  ]) {
    fs.mkdirSync(path.dirname(path.join(upstream, rel)), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, source), path.join(upstream, rel));
  }
  git(upstream, 'add', '-A');
  git(
    upstream,
    '-c',
    `user.name=${contract.gitAuthorName}`,
    '-c',
    `user.email=${authorEmail}`,
    'commit',
    // Two tests here file the same fixture.
    '--allow-empty',
    '-m',
    `Inbound email: ${payload.filename}`,
  );
  return payload;
}

/**
 * A new message from an allowlisted sender, filed as the worker files it.
 * The host remembers a handled Message-ID for the life of the process, so a
 * test that expects a model turn needs a message no other test delivered.
 */
function commitNew(tag: string): WorkerPayload {
  const base = `discussions/raw/2026-11-20-${tag}`;
  const headers = [
    'From: Priya Raman <praman@example.edu>',
    'To: program@example.org',
    'Date: Fri, 20 Nov 2026 09:00:00 -0600',
    `Subject: Question ${tag}`,
    `Message-ID: <${tag}@example.edu>`,
  ];
  fs.mkdirSync(path.join(upstream, 'discussions/raw'), { recursive: true });
  fs.writeFileSync(
    path.join(upstream, `${base}.eml`),
    [...headers, '', 'Is the form due on Friday?', ''].join('\r\n'),
  );
  fs.writeFileSync(
    path.join(upstream, `${base}.md`),
    [
      ...headers,
      '',
      `# Question ${tag}`,
      '',
      'Is the form due on Friday?',
      '',
    ].join('\n'),
  );
  git(upstream, 'add', '-A');
  git(
    upstream,
    '-c',
    `user.name=${contract.gitAuthorName}`,
    '-c',
    `user.email=${contract.gitAuthorEmail}`,
    'commit',
    '-m',
    `Inbound email: 2026-11-20-${tag}.md`,
  );
  return {
    filename: `2026-11-20-${tag}.md`,
    subject: `Question ${tag}`,
    from: 'praman@example.edu',
    message_id: `<${tag}@example.edu>`,
    raw_file_path: `${base}.md`,
    eml_file_path: `${base}.eml`,
  };
}

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

const deliver = (payload: WorkerPayload) =>
  post('/', JSON.stringify(payload), { authorization: 'Bearer test-secret' });

const PLATFORM = 'mx.platform.example';

/** The worker's record with one platform result. */
function authFrom(result: Record<string, unknown>) {
  return {
    version: 1,
    envelope_from_domain: 'mail.example.edu',
    from_headers: 1,
    from_mailboxes: 1,
    results: [
      {
        source: 'platform',
        authserv_id: PLATFORM,
        spf: '',
        spf_domain: '',
        dkim: [],
        dmarc: '',
        dmarc_from: '',
        arc: '',
        ...result,
      },
    ],
  };
}

describe('sender authentication on inbound email', () => {
  const onMessage = vi.fn();
  let checkout: string;
  let disconnect: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    fs.rmSync(hoisted.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(upstream, 'program'), { recursive: true });
    fs.mkdirSync(path.join(upstream, 'discussions'), { recursive: true });
    git(upstream, 'init', '-b', 'main');
    // The allowlist is a protected file: its commit needs an admin author.
    git(upstream, 'config', 'user.email', 'avery.personal@gmail.com');
    git(upstream, 'config', 'user.name', 'Avery Morgan');
    fs.writeFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      [
        '| Name | Email | Role | Access | Notes |',
        '|---|---|---|---|---|',
        '| Avery Morgan | avery@example.edu | Director | read-write | Program Director · **coordinator-cohort: founding** |',
        '| Omar Haddad | ohaddad@example.edu | Staff | read-write | Oversight · **coordinator-cohort: founding** |',
        '| Priya Raman | praman@example.edu | Faculty | read-write | Teaching · **coordinator-cohort: founding** |',
        '| Zoë Müller | zmuller@example.edu | Faculty | read-write | Teaching · **coordinator-cohort: founding** |',
        '| June Hale | jhl@example.edu | Admissions | read-only | Admissions. Any updates she sends route to **Omar Haddad (ohaddad)** for approval · **coordinator-cohort: team-expansion** |',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(upstream, 'discussions', 'OPEN_QUESTIONS.md'),
      '# Open questions\n\n## Routed Approvals\n',
    );
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', 'init');
    execFileSync('git', [
      'clone',
      '--mirror',
      upstream,
      process.env.PROGRAM_READ_MIRROR!,
    ]);

    vi.stubGlobal('fetch', mocks.telegramFetch);
    const channel = getChannelFactory('webhook')?.({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');
    disconnect = () => channel.disconnect();
    await channel.connect();
  });

  beforeEach(() => {
    _initTestDatabase();
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'email-auth-'));
    fs.mkdirSync(path.join(checkout, '.git'));
    vi.stubEnv('PROGRAM_REPO', checkout);
    onMessage.mockClear();
    mocks.telegramFetch.mockClear();
    mocks.sendOutboundEmailResult.mockClear();
  });

  afterEach(() => {
    flushAuditLog();
    _closeDatabase();
    vi.unstubAllEnvs();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  afterAll(async () => {
    await disconnect?.();
    vi.unstubAllGlobals();
    fs.rmSync(hoisted.dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    audit.logEmailAuthentication.mockClear();
    audit.logDroppedEmail.mockClear();
    mocks.sendOutboundEmail.mockClear();
  });

  describe('flag mode (the default)', () => {
    it('with no setting, processes the message as before and records "unknown"', async () => {
      const payload = commitAsWorker('plain-question');
      // Even a payload that claims a pass: the host was told to believe nobody.
      payload.auth = authFrom({ dmarc: 'pass' });
      const res = await deliver(payload);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).not.toHaveProperty('skipped');
      expect(onMessage).toHaveBeenCalledOnce();
      expect(audit.logEmailAuthentication).toHaveBeenCalledExactlyOnceWith({
        from: 'praman@example.edu',
        subject: 'When is the capstone proposal due?',
        messageId: 'plain-1119@example.edu',
        verdict: 'unknown',
        reason: 'no trusted mail server is set',
        mode: 'flag',
      });
    });

    it('records "unauthenticated" and still processes the message', async () => {
      vi.stubEnv('EMAIL_AUTH_TRUSTED_AUTHSERV_IDS', PLATFORM);
      const payload = commitAsWorker('multipart-attachment');
      payload.auth = authFrom({ spf: 'fail', dmarc: 'fail' });
      const res = await deliver(payload);
      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(audit.logEmailAuthentication).toHaveBeenCalledOnce();
      expect(audit.logEmailAuthentication.mock.calls[0][0]).toMatchObject({
        verdict: 'unauthenticated',
        mode: 'flag',
      });
      expect(audit.logEmailAuthentication.mock.calls[0][0]).not.toHaveProperty(
        'blocked',
      );
    });

    it('still sends the access-closed reply to a colleague who is not on the list', async () => {
      vi.stubEnv('EMAIL_AUTH_TRUSTED_AUTHSERV_IDS', PLATFORM);
      const payload = commitAsWorker('routed-approval');
      payload.from = 'flag-newcomer@example.edu';
      payload.auth = authFrom({ dmarc: 'fail' });
      const res = await deliver(payload);
      expect(JSON.parse(res.body)).toMatchObject({
        skipped: true,
        reason: 'sender not on allowlist',
      });
      expect(onMessage).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce(),
      );
      expect(audit.logDroppedEmail).toHaveBeenCalledExactlyOnceWith(
        'flag-newcomer@example.edu',
        expect.any(String),
        expect.stringMatching(/^unauthenticated — /),
      );
    });
  });

  describe('enforce mode', () => {
    beforeEach(() => {
      vi.stubEnv('EMAIL_AUTH_MODE', 'enforce');
      vi.stubEnv('EMAIL_AUTH_TRUSTED_AUTHSERV_IDS', PLATFORM);
    });

    it('processes a message the platform authenticated', async () => {
      const payload = commitNew('enforce-pass');
      payload.auth = authFrom({ dmarc: 'pass', dmarc_from: 'example.edu' });
      const res = await deliver(payload);
      expect(res.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      expect(audit.logEmailAuthentication.mock.calls[0][0]).toMatchObject({
        verdict: 'authenticated',
        mode: 'enforce',
      });
    });

    it('drops a forged allowlisted sender: no model turn, no reply, an audit entry', async () => {
      const payload = commitAsWorker('routed-approval');
      payload.auth = authFrom({
        spf: 'pass',
        spf_domain: 'attacker.example.net',
        dkim: [{ result: 'pass', domain: 'attacker.example.net' }],
        dmarc: 'fail',
      });
      const res = await deliver(payload);
      // 200: the intake worker must not send it again.
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        ok: true,
        skipped: true,
        reason: 'sender not authenticated',
      });
      expect(onMessage).not.toHaveBeenCalled();
      expect(mocks.sendOutboundEmail).not.toHaveBeenCalled();
      expect(mocks.sendOutboundEmailResult).not.toHaveBeenCalled();
      expect(mocks.telegramFetch).not.toHaveBeenCalled();
      expect(audit.logEmailAuthentication).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          from: payload.from,
          verdict: 'unauthenticated',
          reason: `no DMARC pass covers example.edu (checked by ${PLATFORM})`,
          mode: 'enforce',
          blocked: true,
        }),
      );
    });

    it('drops a message with no trusted result unless EMAIL_AUTH_UNKNOWN=allow', async () => {
      const payload = commitNew('enforce-unknown');
      const blocked = await deliver(payload);
      expect(JSON.parse(blocked.body)).toMatchObject({
        skipped: true,
        reason: 'sender not authenticated',
      });
      expect(onMessage).not.toHaveBeenCalled();
      expect(audit.logEmailAuthentication.mock.calls[0][0]).toMatchObject({
        verdict: 'unknown',
        blocked: true,
      });

      vi.stubEnv('EMAIL_AUTH_UNKNOWN', 'allow');
      const allowed = await deliver(payload);
      expect(JSON.parse(allowed.body)).not.toHaveProperty('skipped');
      expect(onMessage).toHaveBeenCalledOnce();
    });

    it('sends no access-closed reply to an unauthenticated address that is not on the list', async () => {
      const payload = commitAsWorker('routed-approval');
      payload.from = 'enforce-newcomer@example.edu';
      payload.auth = authFrom({ dmarc: 'fail' });
      const res = await deliver(payload);
      expect(JSON.parse(res.body)).toMatchObject({
        skipped: true,
        reason: 'sender not on allowlist',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mocks.sendOutboundEmail).not.toHaveBeenCalled();
      expect(mocks.sendOutboundEmailResult).not.toHaveBeenCalled();
      expect(audit.logDroppedEmail).toHaveBeenCalledOnce();
    });
  });
});
