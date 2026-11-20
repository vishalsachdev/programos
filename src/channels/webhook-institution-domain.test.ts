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

// A sender who is not on the allowlist is dropped silently, except that a
// sender on the institution's mail domain gets one "access closed" reply.
// INSTITUTION_DOMAIN decides which domain that is.

const TEST_PORT = 39345;

vi.hoisted(() => {
  process.env.WEBHOOK_PORT = '39345';
  process.env.WEBHOOK_HOST = '127.0.0.1';
  process.env.INSTITUTION_DOMAIN = 'uni.test';
});

const mocks = vi.hoisted(() => ({
  sendOutboundEmail: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
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
        ? '| Listed Person | listed@uni.test | Professor | read-only | Research observer · **coordinator-cohort: observer** |'
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
import { getChannelFactory } from './registry.js';

function postFrom(from: string, tag: string): Promise<string> {
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
        res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    req.on('error', reject);
    req.end(
      JSON.stringify({
        filename: `2026-10-23-${tag}.md`,
        subject: 'A question',
        from,
        to: 'program@example.org',
        cc: '',
        date: '2026-10-23T15:00:00Z',
        message_id: `<${tag}@mail.test>`,
      }),
    );
  });
}

describe('access-closed reply follows INSTITUTION_DOMAIN', () => {
  let repo: string;
  let disconnect: (() => Promise<void>) | undefined;
  const onMessage = vi.fn();

  beforeAll(async () => {
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
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'institution-domain-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    vi.stubEnv('PROGRAM_REPO', repo);
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
  });

  it('replies once to a blocked sender on the configured domain or a subdomain', async () => {
    expect(await postFrom('Stranger <stranger@uni.test>', 'a1')).toContain(
      'sender not on allowlist',
    );
    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmail).toHaveBeenCalledOnce(),
    );
    const [message, options] = mocks.sendOutboundEmail.mock.calls[0] as [
      { to: string },
      { sourceGroup: string; toAllowlistExemption?: unknown },
    ];
    expect(message.to).toBe('stranger@uni.test');
    expect(options.sourceGroup).toBe('webhook-access-closed');
    expect(options.toAllowlistExemption).toBeTruthy();

    await postFrom('Stranger <stranger@uni.test>', 'a2');
    await postFrom('other@dept.uni.test', 'a3');
    await vi.waitFor(() =>
      expect(mocks.sendOutboundEmail).toHaveBeenCalledTimes(2),
    );
    expect(
      (mocks.sendOutboundEmail.mock.calls[1][0] as { to: string }).to,
    ).toBe('other@dept.uni.test');
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('stays silent for the placeholder domain and for look-alike domains', async () => {
    for (const [from, tag] of [
      ['stranger@example.edu', 'b1'],
      ['stranger@notuni.test', 'b2'],
      ['stranger@uni.test.evil.test', 'b3'],
      ['stranger@unixtest', 'b4'],
    ]) {
      expect(await postFrom(from, tag)).toContain('sender not on allowlist');
    }
    // Let any wrongly started reply land before the count is read.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mocks.sendOutboundEmail).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
