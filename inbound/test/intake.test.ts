import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backoffMs, type PendingRecord } from '../src/buffer.js';
import { receive, retryPending } from '../src/intake.js';
import {
  FIXTURES,
  FakeNet,
  MemoryKV,
  contract,
  fixture,
  inboundMessage,
  testEnv,
} from './helpers.js';

const expected = (name: string) =>
  JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.expected.json`), 'utf-8'),
  );

const MIN = 60_000;

describe('intake', () => {
  let kv: MemoryKV;
  let net: FakeNet;
  let clock: number;
  const deps = () => ({ fetch: net.fetch, now: () => new Date(clock) });
  const pending = (): PendingRecord[] =>
    kv.keys('pending:').map((k) => JSON.parse(kv.data.get(k) as string));
  const tick = (ms: number) => {
    clock += ms;
  };

  beforeEach(() => {
    kv = new MemoryKV();
    net = new FakeNet();
    clock = Date.parse(contract.receivedAt);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('commits the Markdown copy and the original, then tells the host', async () => {
    const raw = fixture('multipart-attachment.eml');
    const message = inboundMessage(raw);
    expect(await receive(message, testEnv(kv), deps())).toBe('delivered');

    const want = expected('multipart-attachment');
    expect(net.landed).toHaveLength(1);
    expect(net.landed[0].paths).toEqual([
      want.eml_file_path,
      want.raw_file_path,
    ]);
    expect(net.landed[0].author.email).toBe(contract.gitAuthorEmail);
    expect(net.landed[0].message).toBe(`Inbound email: ${want.filename}`);
    // The committed original is the received bytes, unchanged.
    const blobs = net
      .blobCalls()
      .map((c) => Buffer.from(c.body.content, 'base64'));
    expect(blobs[0].equals(Buffer.from(raw))).toBe(true);
    expect(blobs[1].toString('utf-8')).toBe(
      fs.readFileSync(
        path.join(FIXTURES, 'multipart-attachment.expected.md'),
        'utf-8',
      ),
    );

    // The POST comes after the commit and carries the Bearer secret.
    const [post] = net.hostCalls();
    expect(net.hostCalls()).toHaveLength(1);
    expect(net.calls.indexOf(post)).toBe(net.calls.length - 1);
    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://bot.example.org/');
    expect(post.headers.Authorization).toBe('Bearer test-webhook-secret');
    expect(post.headers['Content-Type']).toBe('application/json');
    expect(post.body).toEqual(want);

    expect(message.rejected).toBeNull();
    expect(kv.data.size).toBe(0);
  });

  it('refuses a message over the size limit at SMTP, before any write', async () => {
    const raw = fixture('plain-question.eml');
    const message = inboundMessage(raw);
    const env = testEnv(kv, { MAX_MESSAGE_BYTES: String(raw.byteLength - 1) });
    expect(await receive(message, env, deps())).toBe('rejected-too-large');
    expect(message.rejected).toBe(
      `Message too large. The limit is ${raw.byteLength - 1} bytes.`,
    );
    expect(net.calls).toEqual([]);
    expect(kv.data.size).toBe(0);

    // A platform that under-reports the size is caught by the real length.
    const liar = { ...inboundMessage(raw), rawSize: 1 };
    expect(await receive(liar, env, deps())).toBe('rejected-too-large');

    // Exactly at the limit is accepted.
    const atLimit = testEnv(kv, { MAX_MESSAGE_BYTES: String(raw.byteLength) });
    expect(await receive(inboundMessage(raw), atLimit, deps())).toBe(
      'delivered',
    );
  });

  describe('failure path 1: the commit fails', () => {
    it('parks the raw message, does not tell the host, and commits on a later run', async () => {
      const raw = fixture('routed-approval.eml');
      const message = inboundMessage(raw);
      net.githubDown = true;
      expect(await receive(message, testEnv(kv), deps())).toBe('parked-commit');

      // Accepted, not bounced: the buffer now holds the only copy.
      expect(message.rejected).toBeNull();
      expect(net.hostCalls()).toEqual([]);
      const [record] = pending();
      expect(record).toMatchObject({
        stage: 'commit',
        attempts: 1,
        receivedAt: contract.receivedAt,
        envelope: contract.envelope,
        lastError: 'GitHub file check failed with HTTP 503',
      });
      expect(
        Buffer.from(kv.data.get(`raw:${record.id}`) as ArrayBuffer).equals(
          Buffer.from(raw),
        ),
      ).toBe(true);

      // Not due yet: the cron run leaves it alone.
      tick(backoffMs(1) - 1);
      expect(await retryPending(testEnv(kv), deps())).toEqual({
        delivered: 0,
        waiting: 0,
        failed: 0,
      });
      expect(net.landed).toEqual([]);

      // Due, GitHub still down: counted and rescheduled further out.
      tick(1);
      expect(await retryPending(testEnv(kv), deps())).toEqual({
        delivered: 0,
        waiting: 1,
        failed: 0,
      });
      expect(pending()[0]).toMatchObject({
        stage: 'commit',
        attempts: 2,
        nextAttemptAt: clock + 10 * MIN,
      });

      // GitHub is back a day later: same file names and payload as a
      // first-time delivery, because the receipt time was kept.
      net.githubDown = false;
      tick(10 * MIN);
      expect(await retryPending(testEnv(kv), deps())).toEqual({
        delivered: 1,
        waiting: 0,
        failed: 0,
      });
      const want = expected('routed-approval');
      expect(net.landed).toHaveLength(1);
      expect(net.landed[0].paths).toEqual([
        want.eml_file_path,
        want.raw_file_path,
      ]);
      expect(net.landed[0].author.date).toBe(contract.receivedAt);
      expect(net.hostCalls()).toHaveLength(1);
      expect(net.hostCalls()[0].body).toEqual(want);
      expect(kv.data.size).toBe(0);
    });

    it('refuses the message at SMTP when the buffer cannot take it either', async () => {
      const message = inboundMessage(fixture('plain-question.eml'));
      net.githubDown = true;
      kv.failPuts = true;
      expect(await receive(message, testEnv(kv), deps())).toBe(
        'rejected-buffer-unavailable',
      );
      expect(message.rejected).toBe(
        'Temporary failure storing the message. Please send it again later.',
      );
      expect(net.hostCalls()).toEqual([]);
    });

    it('parks the message when a setting is missing', async () => {
      const message = inboundMessage(fixture('plain-question.eml'));
      const broken = testEnv(kv, { GITHUB_TOKEN: undefined });
      expect(await receive(message, broken, deps())).toBe('parked-commit');
      expect(message.rejected).toBeNull();
      expect(pending()[0].lastError).toBe('Missing setting GITHUB_TOKEN');
      expect(net.calls).toEqual([]);
      // Fixed setting, next run: delivered.
      tick(backoffMs(1));
      expect((await retryPending(testEnv(kv), deps())).delivered).toBe(1);
    });

    it('does not commit twice when the first attempt landed but its answer was lost', async () => {
      const raw = fixture('plain-question.eml');
      const realFetch = net.fetch;
      let cut = true;
      const flaky = {
        fetch: async (url: string, init?: RequestInit) => {
          const res = await realFetch(url, init);
          if (cut && init?.method === 'PATCH') {
            cut = false;
            throw new TypeError('connection reset');
          }
          return res;
        },
        now: () => new Date(clock),
      };
      expect(await receive(inboundMessage(raw), testEnv(kv), flaky)).toBe(
        'parked-commit',
      );
      expect(net.landed).toHaveLength(1);
      tick(backoffMs(1));
      expect((await retryPending(testEnv(kv), flaky)).delivered).toBe(1);
      expect(net.landed).toHaveLength(1);
      expect(net.hostCalls()).toHaveLength(1);
    });

    it('moves the record to "failed" with its raw message after the last attempt', async () => {
      const raw = fixture('plain-question.eml');
      net.githubDown = true;
      const env = testEnv(kv, { MAX_ATTEMPTS: '3' });
      await receive(inboundMessage(raw), env, deps());
      // Three attempts in all: on receipt, and two cron runs.
      tick(backoffMs(1));
      expect(await retryPending(env, deps())).toEqual({
        delivered: 0,
        waiting: 1,
        failed: 0,
      });
      tick(backoffMs(2));
      expect(await retryPending(env, deps())).toEqual({
        delivered: 0,
        waiting: 0,
        failed: 1,
      });
      expect(
        net.calls.filter((c) => c.url.includes('/contents/')),
      ).toHaveLength(3);
      expect(kv.keys('pending:')).toEqual([]);
      const [failedKey] = kv.keys('failed:');
      const id = failedKey.slice('failed:'.length);
      expect(JSON.parse(kv.data.get(failedKey) as string)).toMatchObject({
        id,
        stage: 'commit',
      });
      expect(
        Buffer.from(kv.data.get(`raw:${id}`) as ArrayBuffer).equals(
          Buffer.from(raw),
        ),
      ).toBe(true);
    });
  });

  describe('failure path 2: the commit succeeds and the POST fails', () => {
    it('retries the same payload with growing delays until the host answers', async () => {
      const want = expected('plain-question');
      const answers: Array<() => Response> = [
        () => new Response('Email processing failed', { status: 503 }),
        () => {
          throw new TypeError('fetch failed');
        },
        () =>
          Response.json(
            { ok: false, reason: 'email-processing-in-progress' },
            { status: 503 },
          ),
        () => Response.json({ ok: true, skipped: true, reason: 'duplicate' }),
      ];
      net.host = () => answers.shift()!();

      const message = inboundMessage(fixture('plain-question.eml'));
      expect(await receive(message, testEnv(kv), deps())).toBe('parked-post');
      expect(message.rejected).toBeNull();
      expect(net.landed).toHaveLength(1);
      // Only the small payload waits; the raw message is in the repo.
      expect(kv.keys('raw:')).toEqual([]);
      expect(pending()[0]).toMatchObject({
        stage: 'post',
        attempts: 1,
        payload: want,
        lastError: 'host answered HTTP 503',
        nextAttemptAt: clock + 5 * MIN,
      });

      tick(5 * MIN);
      expect(await retryPending(testEnv(kv), deps())).toEqual({
        delivered: 0,
        waiting: 1,
        failed: 0,
      });
      expect(pending()[0]).toMatchObject({
        attempts: 2,
        lastError: 'host unreachable: TypeError',
        nextAttemptAt: clock + 10 * MIN,
      });

      // Before the delay is over nothing is sent.
      tick(10 * MIN - 1);
      await retryPending(testEnv(kv), deps());
      expect(net.hostCalls()).toHaveLength(2);

      tick(1);
      expect(await retryPending(testEnv(kv), deps())).toEqual({
        delivered: 0,
        waiting: 1,
        failed: 0,
      });
      expect(pending()[0]).toMatchObject({
        attempts: 3,
        nextAttemptAt: clock + 20 * MIN,
      });

      // The host's own "duplicate" answer is a 200: the worker stops.
      tick(20 * MIN);
      expect(await retryPending(testEnv(kv), deps())).toEqual({
        delivered: 1,
        waiting: 0,
        failed: 0,
      });
      expect(kv.data.size).toBe(0);

      // Every POST was the same bytes with the same Message-ID, which is
      // what the host deduplicates on. One commit throughout.
      const posts = net.hostCalls();
      expect(posts).toHaveLength(4);
      expect(new Set(posts.map((p) => p.rawBody)).size).toBe(1);
      for (const post of posts) {
        expect(post.body.message_id).toBe('<plain-1119@example.edu>');
        expect(post.headers.Authorization).toBe('Bearer test-webhook-secret');
      }
      expect(net.landed).toHaveLength(1);
    });

    it('keeps retrying a wrong secret (401), then stops at the attempt limit', async () => {
      net.host = () => new Response('Unauthorized', { status: 401 });
      const env = testEnv(kv, { MAX_ATTEMPTS: '3' });
      expect(
        await receive(
          inboundMessage(fixture('plain-question.eml')),
          env,
          deps(),
        ),
      ).toBe('parked-post');
      tick(backoffMs(1));
      expect(await retryPending(env, deps())).toEqual({
        delivered: 0,
        waiting: 1,
        failed: 0,
      });
      tick(backoffMs(2));
      expect(await retryPending(env, deps())).toEqual({
        delivered: 0,
        waiting: 0,
        failed: 1,
      });
      const [failedKey] = kv.keys('failed:');
      expect(JSON.parse(kv.data.get(failedKey) as string)).toMatchObject({
        stage: 'post',
        payload: expected('plain-question'),
        lastError: 'host answered HTTP 401',
      });
      expect(net.hostCalls()).toHaveLength(3);
    });

    it('does not retry a payload the host refuses (400), and keeps a record', async () => {
      net.host = () =>
        new Response('Missing filename or subject', { status: 400 });
      const message = inboundMessage(fixture('plain-question.eml'));
      expect(await receive(message, testEnv(kv), deps())).toBe(
        'refused-by-host',
      );
      expect(message.rejected).toBeNull();
      expect(kv.keys('pending:')).toEqual([]);
      expect(kv.keys('failed:')).toHaveLength(1);
      tick(24 * 60 * MIN);
      await retryPending(testEnv(kv), deps());
      expect(net.hostCalls()).toHaveLength(1);
    });

    it('refuses at SMTP when the POST fails and the buffer is down', async () => {
      net.host = () => new Response('', { status: 502 });
      kv.failPuts = true;
      const message = inboundMessage(fixture('plain-question.eml'));
      expect(await receive(message, testEnv(kv), deps())).toBe(
        'rejected-buffer-unavailable',
      );
      expect(message.rejected).toContain('Please send it again later');
    });
  });

  it('caps the delay at six hours and one run at five records', async () => {
    expect([1, 2, 3, 7, 8, 30].map((n) => backoffMs(n) / MIN)).toEqual([
      5, 10, 20, 320, 360, 360,
    ]);

    net.host = () => new Response('', { status: 503 });
    for (let i = 0; i < 7; i++) {
      const raw = new TextEncoder().encode(
        `Subject: Note ${i}\r\nFrom: a@example.edu\r\n\r\nbody ${i}\r\n`,
      );
      await receive(inboundMessage(raw), testEnv(kv), deps());
    }
    expect(net.hostCalls()).toHaveLength(7);
    tick(backoffMs(1));
    await retryPending(testEnv(kv), deps());
    expect(net.hostCalls()).toHaveLength(12);
  });
});
