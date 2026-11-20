import { describe, expect, it } from 'vitest';

import { commitFiles } from '../src/github.js';
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
  readSettings,
} from '../src/settings.js';
import { FakeNet, MemoryKV, contract, testEnv } from './helpers.js';

const when = new Date(contract.receivedAt);
const files = [
  {
    path: 'discussions/raw/a.eml',
    bytes: new Uint8Array([0, 255, 13, 10, 200]),
  },
  {
    path: 'discussions/raw/a.md',
    bytes: new TextEncoder().encode('# Réunion\n'),
  },
];

describe('commit', () => {
  it('defaults to the author the host accepts today', () => {
    // contract.json is the value the host test commits with and the host
    // code accepts. If one side changes, one of the two tests fails.
    expect(DEFAULT_GIT_AUTHOR_EMAIL).toBe(contract.gitAuthorEmail);
    expect(DEFAULT_GIT_AUTHOR_NAME).toBe(contract.gitAuthorName);
    expect(readSettings(testEnv(new MemoryKV())).gitAuthorEmail).toBe(
      'email-inbox@example.org',
    );
  });

  it('adds both files in one commit, as author and committer, without force', async () => {
    const net = new FakeNet();
    const settings = readSettings(testEnv(new MemoryKV()));
    expect(
      await commitFiles(
        settings,
        files,
        'Inbound email: a.md',
        when,
        net.fetch,
      ),
    ).toBe('committed');
    expect(net.landed).toHaveLength(1);
    const identity = {
      name: 'Email Inbox',
      email: 'email-inbox@example.org',
      date: contract.receivedAt,
    };
    expect(net.landed[0]).toMatchObject({
      message: 'Inbound email: a.md',
      parents: ['tip'],
      author: identity,
      committer: identity,
      paths: ['discussions/raw/a.eml', 'discussions/raw/a.md'],
    });
    const update = net.calls.find((c) => c.method === 'PATCH')!;
    expect(update.body.force).toBe(false);

    // Bytes survive the base64 step, binary and UTF-8 alike.
    const blobs = net
      .blobCalls()
      .map((c) => Buffer.from(c.body.content, 'base64'));
    expect([...blobs[0]]).toEqual([0, 255, 13, 10, 200]);
    expect(blobs[1].toString('utf-8')).toBe('# Réunion\n');

    for (const call of net.calls) {
      expect(call.headers.Authorization).toBe('Bearer test-github-token');
      expect(
        call.url.startsWith(
          'https://api.github.com/repos/example-org/program-repo/',
        ),
      ).toBe(true);
    }
  });

  it('takes the author from the settings', async () => {
    const net = new FakeNet();
    const settings = readSettings(
      testEnv(new MemoryKV(), {
        GIT_AUTHOR_NAME: 'Mail Intake',
        GIT_AUTHOR_EMAIL: 'intake@example.org',
      }),
    );
    await commitFiles(settings, files, 'm', when, net.fetch);
    expect(net.landed[0].author).toMatchObject({
      name: 'Mail Intake',
      email: 'intake@example.org',
    });
  });

  it('writes nothing when the original is already on the branch', async () => {
    const net = new FakeNet();
    net.existing.add('discussions/raw/a.eml');
    const settings = readSettings(testEnv(new MemoryKV()));
    expect(await commitFiles(settings, files, 'm', when, net.fetch)).toBe(
      'already-present',
    );
    expect(net.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('rebuilds the commit when the branch moved, and gives up after four tries', async () => {
    const net = new FakeNet();
    const settings = readSettings(testEnv(new MemoryKV()));
    net.refRaces = 2;
    expect(await commitFiles(settings, files, 'm', when, net.fetch)).toBe(
      'committed',
    );
    expect(net.calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
    // Blobs are uploaded once, not once per try.
    expect(net.blobCalls()).toHaveLength(2);

    const stuck = new FakeNet();
    stuck.refRaces = 99;
    await expect(
      commitFiles(settings, files, 'm', when, stuck.fetch),
    ).rejects.toThrow('GitHub branch update failed with HTTP 422');
    expect(stuck.calls.filter((c) => c.method === 'PATCH')).toHaveLength(4);
    expect(stuck.landed).toEqual([]);
  });

  it('throws when GitHub is down, without the token in the message', async () => {
    const net = new FakeNet();
    net.githubDown = true;
    const settings = readSettings(testEnv(new MemoryKV()));
    const err = await commitFiles(settings, files, 'm', when, net.fetch).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('GitHub file check failed with HTTP 503');
  });
});

describe('settings', () => {
  it('refuses unsafe or missing values', () => {
    const kv = new MemoryKV();
    expect(() => readSettings(testEnv(kv, { GITHUB_TOKEN: '' }))).toThrow(
      'Missing setting GITHUB_TOKEN',
    );
    expect(() =>
      readSettings(testEnv(kv, { WEBHOOK_SECRET: undefined })),
    ).toThrow('WEBHOOK_SECRET');
    expect(() =>
      readSettings(testEnv(kv, { GITHUB_REPO: 'no-slash' })),
    ).toThrow('owner/name');
    expect(() =>
      readSettings(
        testEnv(kv, { HOST_WEBHOOK_URL: 'http://bot.example.org/' }),
      ),
    ).toThrow('https://');
    for (const dir of ['../x', '/abs', 'a//b', 'a/../b']) {
      expect(() => readSettings(testEnv(kv, { INBOX_DIR: dir })), dir).toThrow(
        'INBOX_DIR',
      );
    }
    expect(() =>
      readSettings(testEnv(kv, { GIT_AUTHOR_EMAIL: 'not an address' })),
    ).toThrow('GIT_AUTHOR_EMAIL');
    expect(() => readSettings(testEnv(kv, { MAX_ATTEMPTS: 'many' }))).toThrow(
      'whole number',
    );
    expect(readSettings(testEnv(kv, { INBOX_DIR: 'mail/in/' })).inboxDir).toBe(
      'mail/in',
    );
  });
});
