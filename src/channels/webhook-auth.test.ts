/**
 * Issue 55, the inbound mail listener: WEBHOOK_SECRET is checked with a
 * constant-time comparison. Right secret passes; wrong, empty, missing and
 * different-length headers get 401. Real HTTP requests to the real listener.
 */
import http from 'http';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_PORT = 39348;
const SECRET = 'webhook-auth-test-secret';

vi.hoisted(() => {
  process.env.WEBHOOK_PORT = '39348';
  process.env.WEBHOOK_HOST = '127.0.0.1';
  delete process.env.WEBHOOK_SECRET;
});

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'webhook-auth-test-secret',
    ASSISTANT_NAME: 'Coordinator',
  }),
}));

vi.mock('../repo-reader.js', () => ({
  getRepoReader: () => ({
    mirrorPath: '/tmp/missing-mirror',
    refresh: vi.fn(() => ({ advanced: false, sha: null })),
    refreshAsync: vi.fn(async () => ({ advanced: false, sha: null })),
    readFile: vi.fn(() => null),
    readFileAsync: vi.fn(async () => null),
    readFileAtCreationAsync: vi.fn(async () => null),
    readFileBuffer: vi.fn(() => null),
    commitExists: vi.fn(() => false),
  }),
}));

import './webhook.js';
import { _closeDatabase, _initTestDatabase } from '../db.js';
import { getChannelFactory } from './registry.js';

function post(
  headers: Record<string, string>,
  body = '{}',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: '/',
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

describe('inbound mail webhook: the WEBHOOK_SECRET check', () => {
  const onMessage = vi.fn();
  let disconnect: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    _initTestDatabase();
    const channel = getChannelFactory('webhook')?.({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');
    disconnect = () => channel.disconnect();
    await channel.connect();
  });

  afterAll(async () => {
    await disconnect?.();
    _closeDatabase();
  });

  it('lets the right secret past the check (the body is then read and judged)', async () => {
    // An empty JSON object is refused by the step after the check, with 400.
    expect(await post({ authorization: `Bearer ${SECRET}` })).toEqual({
      status: 400,
      body: 'Missing filename or subject',
    });
  });

  it.each([
    [
      'a wrong secret of the same length',
      { authorization: `Bearer ${'x'.repeat(SECRET.length)}` },
    ],
    ['a shorter secret', { authorization: 'Bearer web' }],
    ['a longer secret', { authorization: `Bearer ${SECRET}-and-more` }],
    ['the secret without "Bearer"', { authorization: SECRET }],
    ['an empty header', { authorization: '' }],
    ['a missing header', {}],
  ])(
    'answers 401 to %s and passes nothing on',
    async (_name, headers: Record<string, string>) => {
      expect(
        await post(
          headers,
          JSON.stringify({ filename: 'a.md', subject: 'Hello' }),
        ),
      ).toEqual({ status: 401, body: 'Unauthorized' });
      expect(onMessage).not.toHaveBeenCalled();
    },
  );
});
