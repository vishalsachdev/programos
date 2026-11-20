/**
 * Issue 53: a token written in PROGRAM_ORIGIN_URL is never stored in a git
 * config file, never on a git command line, and never in a log line, an
 * alert or a result. The host repo is private to its owner. A host repo made
 * by an earlier version is repaired at the first start.
 *
 * The origin here is an HTTPS address on a closed local port: git is really
 * started and really tries, and nothing leaves the machine.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetHostRepoStateForTests,
  ensureHostRepo,
  expectedOriginUrl,
  hostGitEnv,
  setHostRepoAlerter,
  syncHostRepo,
} from './host-repo.js';
import { logger } from './logger.js';
import { recordGitProcesses } from './test-support/git-argv-recorder.js';
import {
  git,
  makeKbFixture,
  type KbFixture,
} from './test-support/kb-fixture.js';

// Obviously fake, and assembled so that no line holds a URL with a password.
const USER = 'kb-bot';
const TOKEN = ['not', 'a', 'real', 'token', '5353'].join('-');
const ADDRESS = '127.0.0.1:9/team/program-repo.git';
const BARE = `https://${ADDRESS}`;
const WITH_PASSWORD = `https://${USER}:${TOKEN}@${ADDRESS}`;
const TOKEN_AS_USER = `https://${TOKEN}@${ADDRESS}`;
const PATTERN = '^https://([A-Za-z0-9_.~:-]+@)?127[.]0[.]0[.]1:9/team/';

let kb: KbFixture;
let alerts: string[];
let logged: string[];

function useOrigin(url: string): void {
  vi.stubEnv('PROGRAM_ORIGIN_URL', url);
  vi.stubEnv('PROGRAM_ORIGIN_PATTERN', PATTERN);
}

function storedConfig(): string {
  return fs.readFileSync(path.join(kb.host, '.git', 'config'), 'utf8');
}

function mode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

beforeEach(() => {
  _resetHostRepoStateForTests();
  kb = makeKbFixture();
  alerts = [];
  logged = [];
  setHostRepoAlerter(async (text) => {
    alerts.push(text);
  });
  for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const)
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        JSON.stringify(args, (_k, v) =>
          v instanceof Error ? `${v.message}\n${v.stack}` : v,
        ),
      );
    });
  // No proxy between git and the closed port, whatever this machine sets.
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'])
    vi.stubEnv(key, '');
});

afterEach(() => {
  vi.restoreAllMocks();
  kb.cleanup();
});

describe.each([
  ['a user and a token', WITH_PASSWORD],
  ['a token as the user name', TOKEN_AS_USER],
])('origin URL with %s', (_name, url) => {
  it('gives callers the URL without the credential, and checks the pattern on the URL as set', () => {
    useOrigin(url);
    expect(expectedOriginUrl()).toEqual({ url: BARE });
    // A pattern that requires the credential still passes.
    vi.stubEnv('PROGRAM_ORIGIN_PATTERN', '^https://[^/@]+@127[.]0[.]0[.]1:9/');
    expect(expectedOriginUrl()).toEqual({ url: BARE });
    vi.stubEnv('PROGRAM_ORIGIN_PATTERN', '^https://git[.]example[.]edu/');
    expect(expectedOriginUrl().url).toBeNull();
    expect(expectedOriginUrl().problem).toMatch(/PROGRAM_ORIGIN_PATTERN/);
  });

  it('hands the credential to credentialed git through its environment only', () => {
    useOrigin(url);
    const env = hostGitEnv({ credentialed: true });
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe(`url.${url}.insteadOf`);
    expect(env.GIT_CONFIG_VALUE_0).toBe(BARE);
    // Local git (commit, import from the checkout) never gets it.
    expect(JSON.stringify(hostGitEnv({ credentialed: false }))).not.toContain(
      TOKEN,
    );
  });

  it('a sync puts the token in no config file, no process argument, no log line, no alert and no result', async () => {
    useOrigin(url);
    const recorder = recordGitProcesses(kb.root);
    const result = await syncHostRepo({ count: 1, fetchOrigin: true });

    // git was really asked to fetch, and could not reach the closed port.
    expect(result.failed).toMatch(/^fetch: /);
    expect(recorder.argv().some((a) => / fetch .*\borigin$/.test(a))).toBe(
      true,
    );
    // The fetch had the credential in its environment...
    expect(
      recorder.configKeys().some((k) => k.includes(`url.${url}.insteadOf`)),
    ).toBe(true);
    // ...and nothing else had it anywhere.
    expect(recorder.argvText()).not.toContain(TOKEN);
    expect(recorder.argvText()).toContain(`remote.origin.url ${BARE}`);
    expect(storedConfig()).not.toContain(TOKEN);
    expect(storedConfig()).toContain(`url = ${BARE}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(alerts.join('\n')).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(TOKEN);
    // No file of the host repo or its export holds it.
    const holds: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && fs.readFileSync(file).includes(TOKEN))
          holds.push(file);
      }
    };
    walk(kb.host);
    walk(`${kb.host}-export.git`);
    expect(holds).toEqual([]);
  });

  it('an error text that quotes the token is redacted before it is logged or returned', async () => {
    useOrigin(url);
    // A stand-in git that fails every fetch the way git and Node can: with
    // the URL as set in the message.
    const bin = path.join(kb.root, 'failing-bin');
    const realPath = process.env.PATH;
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'git'),
      [
        '#!/bin/sh',
        'for a in "$@"; do if [ "$a" = fetch ] && [ -n "$GIT_CONFIG_KEY_0" ]; then',
        `  echo "fatal: could not read Password for '$GIT_CONFIG_KEY_0': terminal prompts disabled" >&2; exit 128`,
        'fi; done',
        `PATH='${realPath}' exec git "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    vi.stubEnv('PATH', `${bin}:${realPath}`);
    const result = await syncHostRepo({ count: 1, fetchOrigin: true });
    expect(result.failed).toMatch(/could not read Password/);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(logged.join('\n')).toMatch(/could not read Password/);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });
});

describe('the host repo is private to its owner', () => {
  it('is created with mode 0700 and its config with 0600, under a permissive umask', () => {
    let previous: number | null = null;
    try {
      previous = process.umask(0);
    } catch {
      /* a worker thread cannot change the umask; the modes are checked as is */
    }
    try {
      ensureHostRepo();
    } finally {
      if (previous !== null) process.umask(previous);
    }
    expect(mode(kb.host)).toBe(0o700);
    expect(mode(path.join(kb.host, '.git', 'config'))).toBe(0o600);
  });

  it('git rewriting the config keeps it private', async () => {
    useOrigin(WITH_PASSWORD);
    await syncHostRepo({ count: 1 });
    expect(storedConfig()).toContain(`url = ${BARE}`);
    expect(mode(path.join(kb.host, '.git', 'config'))).toBe(0o600);
    expect(mode(kb.host)).toBe(0o700);
  });
});

describe('a host repo made by an earlier version', () => {
  /** As the earlier version left it: open modes, the token in the config. */
  function makeOldHostRepo(stored: string): void {
    vi.stubEnv('PROGRAM_ORIGIN_URL', kb.origin);
    ensureHostRepo();
    fs.chmodSync(kb.host, 0o755);
    fs.chmodSync(path.join(kb.host, '.git', 'config'), 0o644);
    git(kb.host, ['config', 'remote.origin.url', stored]);
    git(kb.host, [
      'config',
      'remote.origin.fetch',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    expect(storedConfig()).toContain(TOKEN);
    _resetHostRepoStateForTests(); // a new process
  }

  it.each([
    ['a user and a token', WITH_PASSWORD],
    ['a token as the user name', TOKEN_AS_USER],
  ])(
    'is repaired at start: %s leaves the stored URL, and the modes are tightened',
    (_name, url) => {
      makeOldHostRepo(url);
      useOrigin(url);
      const recorder = recordGitProcesses(kb.root);

      ensureHostRepo(); // what main() calls at start; no network

      expect(storedConfig()).not.toContain(TOKEN);
      expect(storedConfig()).toContain(`url = ${BARE}`);
      expect(storedConfig()).toContain(
        'fetch = +refs/heads/main:refs/remotes/origin/main',
      );
      expect(mode(kb.host)).toBe(0o700);
      expect(mode(path.join(kb.host, '.git', 'config'))).toBe(0o600);
      // The repair itself shows the token to nobody.
      expect(recorder.argvText()).not.toContain(TOKEN);
      expect(logged.join('\n')).not.toContain(TOKEN);
      expect(logged.join('\n')).toMatch(/rewritten without it/);
      expect(logged.join('\n')).toMatch(/now private to its owner/);
      // Git still gets the credential, from the setting.
      expect(hostGitEnv({ credentialed: true }).GIT_CONFIG_KEY_0).toBe(
        `url.${url}.insteadOf`,
      );
    },
  );

  it('is repaired even when the origin setting is now missing or refused', () => {
    makeOldHostRepo(WITH_PASSWORD);
    vi.stubEnv('PROGRAM_ORIGIN_URL', '');
    vi.stubEnv('PROGRAM_ORIGIN_PATTERN', '^https://git[.]example[.]edu/');
    ensureHostRepo();
    expect(storedConfig()).not.toContain(TOKEN);
    expect(storedConfig()).toContain(`url = ${BARE}`);
  });

  it('is repaired once per process, and a sync repeats the check', async () => {
    makeOldHostRepo(WITH_PASSWORD);
    useOrigin(WITH_PASSWORD);
    ensureHostRepo();
    // Something puts the full URL back while the host runs.
    git(kb.host, ['config', 'remote.origin.url', WITH_PASSWORD]);
    const result = await syncHostRepo({ count: 1 });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(storedConfig()).not.toContain(TOKEN);
  });

  it('keeps working with its local history: entries are committed, and nothing is lost', async () => {
    // The fixture origin is a local path (no credential): the upgrade changes
    // nothing for it but the modes.
    vi.stubEnv('PROGRAM_ORIGIN_URL', kb.origin);
    ensureHostRepo();
    fs.chmodSync(kb.host, 0o755);
    _resetHostRepoStateForTests();
    const before = storedConfig();
    const result = await syncHostRepo({ count: 0, fetchOrigin: true });
    expect(result.failed).toBeUndefined();
    expect(mode(kb.host)).toBe(0o700);
    expect(storedConfig()).toContain(before.trim().split('\n')[0]);
    expect(storedConfig()).toContain(`url = ${kb.origin}`);
  });
});
