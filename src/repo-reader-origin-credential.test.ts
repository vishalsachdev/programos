/**
 * Issue 53, the read mirror: the token of PROGRAM_ORIGIN_URL is not on the
 * clone or fetch command line, not in the mirror's config and not in a log
 * line. A mirror that already stores it is repaired at start.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';
import { RepoReader } from './repo-reader.js';
import { recordGitProcesses } from './test-support/git-argv-recorder.js';
import {
  git,
  makeKbFixture,
  type KbFixture,
} from './test-support/kb-fixture.js';

// Obviously fake, and assembled so that no line holds a URL with a password.
const USER = 'kb-bot';
const TOKEN = ['not', 'a', 'real', 'token', '5354'].join('-');
const ADDRESS = '127.0.0.1:9/team/program-repo.git';
const BARE = `https://${ADDRESS}`;
const FULL = `https://${USER}:${TOKEN}@${ADDRESS}`;
const PATTERN = '^https://([A-Za-z0-9_.~:-]+@)?127[.]0[.]0[.]1:9/team/';

let kb: KbFixture;
let logged: string[];

function mirrorConfig(): string {
  return fs.readFileSync(path.join(kb.mirror, 'config'), 'utf8');
}

/** A mirror as an earlier version or a person made it, with `stored` as origin. */
function makeMirror(stored: string): void {
  git(kb.root, [
    'clone',
    '-q',
    '--mirror',
    '--template=',
    kb.origin,
    kb.mirror,
  ]);
  git(kb.mirror, ['config', 'remote.origin.url', stored]);
  fs.chmodSync(path.join(kb.mirror, 'config'), 0o644);
}

beforeEach(() => {
  kb = makeKbFixture();
  logged = [];
  for (const level of ['debug', 'info', 'warn', 'error', 'fatal'] as const)
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(
        JSON.stringify(args, (_k, v) =>
          v instanceof Error ? `${v.message}\n${v.stack}` : v,
        ),
      );
    });
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'])
    vi.stubEnv(key, '');
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  vi.stubEnv('PROGRAM_ORIGIN_URL', FULL);
  vi.stubEnv('PROGRAM_ORIGIN_PATTERN', PATTERN);
});

afterEach(() => {
  vi.restoreAllMocks();
  kb.cleanup();
});

describe('read mirror and a token in PROGRAM_ORIGIN_URL', () => {
  it('the bootstrap clone has the token in its environment only: not in its arguments, not in a log line', () => {
    const recorder = recordGitProcesses(kb.root);
    const reader = new RepoReader(kb.mirror);

    expect(reader.init()).toBe(false); // the closed port: the clone fails

    const clone = recorder.argv().find((a) => a.startsWith('clone --mirror'));
    expect(clone).toBe(`clone --mirror -- ${BARE} ${kb.mirror}`);
    expect(
      recorder.configKeys().some((k) => k.includes(`url.${FULL}.insteadOf`)),
    ).toBe(true);
    expect(recorder.argvText()).not.toContain(TOKEN);
    expect(logged.join('\n')).toMatch(/mirror bootstrap clone failed/);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('a stored origin equal to the setting is rewritten without the token at start, and the fetch gets it from the environment', () => {
    makeMirror(FULL);
    const recorder = recordGitProcesses(kb.root);
    const reader = new RepoReader(kb.mirror);

    expect(reader.init()).toBe(true);
    expect(mirrorConfig()).not.toContain(TOKEN);
    expect(mirrorConfig()).toContain(`url = ${BARE}`);
    expect(logged.join('\n')).toMatch(/rewritten without it/);

    reader.refresh({ force: true }); // fails at the closed port, as it must
    const fetch = recorder
      .argv()
      .findIndex((a) => a.includes(' fetch origin '));
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(recorder.configKeys()[fetch]).toContain(`url.${FULL}.insteadOf`);
    expect(recorder.argvText()).not.toContain(TOKEN);
    expect(logged.join('\n')).toMatch(/fetch failed; serving last-good SHA/);
    expect(logged.join('\n')).not.toContain(TOKEN);
    // The pinned revision is still served.
    expect(reader.currentSha).toMatch(/^[0-9a-f]{40}$/);
  });

  // Review finding on PR 71 (Codex): the token was rotated in the setting
  // before the first start of this version. The stored URL then differed from
  // the setting, stayed in the config, and git kept fetching with the old one.
  it('a stored origin with an older token than the setting is rewritten without it, and the fetch uses the new token', () => {
    const OLD = ['an', 'older', 'revoked', 'token', '71'].join('-');
    makeMirror(`https://${USER}:${OLD}@${ADDRESS}`);
    const recorder = recordGitProcesses(kb.root);
    const reader = new RepoReader(kb.mirror);

    expect(reader.init()).toBe(true);
    expect(mirrorConfig()).not.toContain(OLD);
    expect(mirrorConfig()).not.toContain(TOKEN);
    expect(mirrorConfig()).toContain(`url = ${BARE}`);
    expect(logged.join('\n')).toMatch(/rewritten without it/);

    reader.refresh({ force: true }); // fails at the closed port, as it must
    const fetch = recorder
      .argv()
      .findIndex((a) => a.includes(' fetch origin '));
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(recorder.configKeys()[fetch]).toContain(`url.${FULL}.insteadOf`);
    expect(recorder.argvText()).not.toContain(OLD);
    expect(recorder.argvText()).not.toContain(TOKEN);
    expect(logged.join('\n')).not.toContain(OLD);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('a stored token is kept when the setting names another address, or the same address with no credential', () => {
    for (const setting of [
      `https://${USER}:${TOKEN}@127.0.0.1:9/other/program-repo.git`,
      BARE,
    ]) {
      fs.rmSync(kb.mirror, { recursive: true, force: true });
      makeMirror(FULL);
      vi.stubEnv('PROGRAM_ORIGIN_URL', setting);
      const reader = new RepoReader(kb.mirror);
      reader.init();
      expect(mirrorConfig(), setting).toContain(TOKEN);
      expect(fs.statSync(path.join(kb.mirror, 'config')).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(logged.join('\n')).toMatch(/holds a credential in its origin URL/);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('a stored token the setting does not have is kept (it has no other home), made private, and reported without being shown', () => {
    makeMirror(FULL);
    vi.stubEnv('PROGRAM_ORIGIN_URL', '');
    const reader = new RepoReader(kb.mirror);

    expect(reader.init()).toBe(true);
    expect(mirrorConfig()).toContain(TOKEN);
    expect(fs.statSync(path.join(kb.mirror, 'config')).mode & 0o777).toBe(
      0o600,
    );
    expect(logged.join('\n')).toMatch(/holds a credential in its origin URL/);
    expect(logged.join('\n')).not.toContain(TOKEN);
  });

  it('a mirror without a credential is left exactly as it is', () => {
    makeMirror(kb.origin);
    vi.stubEnv('PROGRAM_ORIGIN_URL', kb.origin);
    vi.stubEnv('PROGRAM_ORIGIN_PATTERN', '');
    const before = mirrorConfig();
    const reader = new RepoReader(kb.mirror);
    expect(reader.init()).toBe(true);
    expect(reader.refresh({ force: true }).sha).toMatch(/^[0-9a-f]{40}$/);
    expect(mirrorConfig()).toBe(before);
    expect(fs.statSync(path.join(kb.mirror, 'config')).mode & 0o777).toBe(
      0o644,
    );
  });
});
