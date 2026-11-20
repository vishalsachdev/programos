import crypto from 'crypto';
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

// The host's half of the contract with the intake worker in `inbound/`.
//
// `inbound/fixtures/` holds, for each synthetic message, the original
// (`*.eml`) and what the worker builds from it: the Markdown copy
// (`*.expected.md`) and the webhook payload (`*.expected.json`). The worker's
// own tests prove it builds exactly those files. Here the same files go
// through the real webhook handler and a real RepoReader over a git mirror,
// committed the way the worker commits them: both files in one commit, by
// the author in `contract.json`.

const TEST_PORT = 39345;

const hoisted = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR || '/tmp'}/programos-inbound-intake-${process.pid}`;
  process.env.WEBHOOK_PORT = '39345';
  process.env.WEBHOOK_HOST = '127.0.0.1';
  // The real reader is used, pointed at a mirror this test creates.
  process.env.PROGRAM_READ_MIRROR = `${dir}/mirror.git`;
  return { dir };
});

const mocks = vi.hoisted(() => ({
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
import { isAutoReplyEml } from '../email-loop-detection.js';
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
    '-m',
    `Inbound email: ${payload.filename}`,
  );
  return payload;
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

function pushEvent(): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ ref: 'refs/heads/main', commits: [] });
  const sig = `sha256=${crypto.createHmac('sha256', 'push-secret').update(body).digest('hex')}`;
  return post('/api/github-push', body, { 'x-hub-signature-256': sig });
}

describe('mail filed by the intake worker in inbound/', () => {
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
    checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-intake-'));
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

  it('accepts the payload for a plain question, points the agent at the Markdown copy, and skips a repeat', async () => {
    const payload = commitAsWorker('plain-question');
    const res = await deliver(payload);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
    expect(JSON.parse(res.body)).not.toHaveProperty('skipped');

    expect(onMessage).toHaveBeenCalledOnce();
    const content: string = onMessage.mock.calls[0][1].content;
    expect(content).toContain(`**File:** ${payload.raw_file_path}`);
    expect(payload.raw_file_path).toMatch(/^discussions\/raw\/.+\.md$/);
    expect(content).toContain(
      '**Subject:** When is the capstone proposal due?',
    );
    expect(content).toContain('**From:** praman@example.edu');
    expect(content).toContain('**Message-ID:** plain-1119@example.edu');
    expect(onMessage.mock.calls[0][1].sender).toBe('praman@example.edu');

    // A repeated POST of the same payload (the worker retries when it did
    // not see an answer) is recognised by its Message-ID and not processed
    // again. The host keeps this memory in the process only.
    const again = await deliver(payload);
    expect(again.status).toBe(200);
    expect(JSON.parse(again.body)).toMatchObject({
      ok: true,
      skipped: true,
      reason: 'duplicate',
    });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('accepts a multipart message with an attachment and a non-ASCII subject', async () => {
    const payload = commitAsWorker('multipart-attachment');
    const res = await deliver(payload);
    expect(res.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
    const content: string = onMessage.mock.calls[0][1].content;
    // The host takes the subject from the committed original; it agrees
    // with the one the worker decoded.
    expect(payload.subject).toBe('Réunion du comité — budget 2027');
    expect(content).toContain(`**Subject:** ${payload.subject}`);
    // To and Cc come from the headers of the committed original.
    expect(content).toContain('**To:** Program Inbox <program@example.org>');
    expect(content).toContain(
      '**CC:** "Raman, Priya" <praman@example.edu>, dean-office@example.edu',
    );
    // One attachment is under the high-attachment threshold: no receipt
    // step, no "manifest not terminal" retry.
    expect(content).not.toContain('High-attachment handling');
  });

  it('stops an auto-reply: the loop guard reads the headers in the Markdown copy', async () => {
    expect(
      await isAutoReplyEml(path.join(FIXTURES, 'auto-reply.expected.md')),
    ).toMatchObject({ isAutoReply: true });
    expect(
      await isAutoReplyEml(path.join(FIXTURES, 'plain-question.expected.md')),
    ).toEqual({ isAutoReply: false });

    const res = await deliver(commitAsWorker('auto-reply'));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, skipped: true });
    expect(JSON.parse(res.body).reason).toMatch(/^auto-reply: /);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('passes a routed-approval exchange using the original the worker committed', async () => {
    const payload = commitAsWorker('routed-approval');
    // The payload carries no body. The quoted sentence below is split by a
    // quoted-printable soft line break in the committed .eml, so the host
    // can only have it by reading and decoding that file.
    expect(payload).not.toHaveProperty('inbound_text');
    expect(payload).not.toHaveProperty('raw_email');
    const words = 'The webinar series moves to Thursdays starting in November.';
    expect(
      fs.readFileSync(path.join(FIXTURES, 'routed-approval.eml'), 'utf-8'),
    ).not.toContain(words);

    const intake = await deliver(payload);
    expect(intake.status).toBe(200);
    const evidence = getRoutedApprovalEvidence(payload.raw_file_path);
    expect(evidence).toMatchObject({
      sender: 'jhl@example.edu',
      subject: 'Re: Admissions updates',
      messageId: 'june-1024@example.edu',
    });
    expect(evidence?.texts.join('\n')).toContain(words);

    // The agent's turn: it files the entry, citing the **File:** path.
    fs.writeFileSync(
      path.join(upstream, 'discussions', 'OPEN_QUESTIONS.md'),
      [
        '# Open questions',
        '',
        '## Routed Approvals',
        '',
        `- [ ] **Routed to Omar Haddad (ohaddad): admissions updates** (Sender: jhl@example.edu; Approver: ohaddad@example.edu; Raw: ${payload.raw_file_path}) (Added: 2026-10-24)`,
        `  - Sender's words: "${words}"`,
        '',
      ].join('\n'),
    );
    git(upstream, 'add', '-A');
    git(
      upstream,
      '-c',
      'user.email=program-bot@example.org',
      'commit',
      '-m',
      'Route admissions update for approval',
    );
    expect((await pushEvent()).status).toBe(200);

    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmailResult).toHaveBeenCalledOnce(),
    );
    const [email, opts] = mocks.sendOutboundEmailResult.mock.calls[0] as [
      { to: string; cc?: string; subject: string; body: string },
      { sourceGroup: string },
    ];
    expect(email).toMatchObject({
      to: 'ohaddad@example.edu',
      cc: 'jhl@example.edu',
      subject: 'For your approval: Admissions updates',
    });
    expect(email.body).toContain(`"${words}"`);
    expect(opts.sourceGroup).toBe('routed-approval');
    // The operator notice is the last step of the relay.
    await vi.waitFor(() => expect(mocks.telegramFetch).toHaveBeenCalled());
    const notice = JSON.parse(
      (mocks.telegramFetch.mock.calls[0][1] as RequestInit).body as string,
    ).text;
    expect(notice).toContain('Coordinator routed approval (G42)');
  });

  it('does not use an original committed by another author as evidence', async () => {
    // Why the worker's GIT_AUTHOR_EMAIL must equal the author the host
    // accepts: with any other author the host has no copy of the words.
    const name = 'routed-approval';
    const original = fs.readFileSync(path.join(FIXTURES, `${name}.eml`));
    const payload = {
      ...payloadOf(name),
      filename: 'other-author.md',
      message_id: '<other-author@example.edu>',
      raw_file_path: 'discussions/raw/other-author.md',
      eml_file_path: 'discussions/raw/other-author.eml',
    };
    fs.writeFileSync(
      path.join(upstream, payload.eml_file_path),
      original
        .toString('utf-8')
        .replace('<june-1024@example.edu>', payload.message_id),
    );
    fs.writeFileSync(path.join(upstream, payload.raw_file_path), '# copy\n');
    git(upstream, 'add', '-A');
    git(
      upstream,
      '-c',
      'user.email=someone-else@example.org',
      'commit',
      '-m',
      'Inbound email: other-author.md',
    );
    expect((await deliver(payload)).status).toBe(200);
    expect(
      getRoutedApprovalEvidence(payload.raw_file_path)?.texts ?? [],
    ).toEqual([]);
  });
});
