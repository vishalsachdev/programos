import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasOriginCredential,
  originCredentialEnv,
  redactOriginCredential,
  splitOriginCredential,
} from './origin-credential.js';

// Obviously fake, and assembled so that no line holds a URL with a password.
const USER = 'kb-bot';
const TOKEN = ['not', 'a', 'real', 'token', '0000'].join('-');
const HOST_PATH = 'git.example.edu/team/program-repo.git';
const WITH_PASSWORD = `https://${USER}:${TOKEN}@${HOST_PATH}`;
const TOKEN_AS_USER = `https://${TOKEN}@${HOST_PATH}`;
const BARE = `https://${HOST_PATH}`;

describe('splitOriginCredential', () => {
  it('takes a user and password out of an HTTPS URL', () => {
    expect(splitOriginCredential(WITH_PASSWORD)).toEqual({
      bare: BARE,
      full: WITH_PASSWORD,
      userinfo: `${USER}:${TOKEN}`,
    });
  });

  it('takes a token written as the user name out of an HTTPS URL', () => {
    expect(splitOriginCredential(TOKEN_AS_USER).bare).toBe(BARE);
    expect(splitOriginCredential(TOKEN_AS_USER).userinfo).toBe(TOKEN);
  });

  it('keeps a port, and splits at the last @ of the authority', () => {
    expect(
      splitOriginCredential(`https://a:p@ss@git.example.edu:8443/x.git`),
    ).toMatchObject({
      bare: 'https://git.example.edu:8443/x.git',
      userinfo: 'a:p@ss',
    });
  });

  it('does not treat an @ in the path as a credential', () => {
    expect(hasOriginCredential('https://git.example.edu/a@b/x.git')).toBe(
      false,
    );
  });

  it('leaves every other URL shape as it is', () => {
    for (const url of [
      BARE,
      'git@git.example.edu:team/program-repo.git',
      'ssh://git@git.example.edu/team/program-repo.git',
      '/srv/repos/origin.git',
      'file:///srv/repos/origin.git',
    ]) {
      expect(splitOriginCredential(url)).toEqual({
        bare: url,
        full: url,
        userinfo: '',
      });
      expect(originCredentialEnv(url)).toEqual({});
    }
  });
});

describe('originCredentialEnv', () => {
  it('is empty without a URL', () => {
    expect(originCredentialEnv(null)).toEqual({});
    expect(originCredentialEnv('')).toEqual({});
  });

  it('maps the URL without the credential to the URL with it', () => {
    expect(originCredentialEnv(WITH_PASSWORD)).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${WITH_PASSWORD}.insteadOf`,
      GIT_CONFIG_VALUE_0: BARE,
    });
  });

  it('adds its entry after entries the environment already has', () => {
    expect(
      originCredentialEnv(WITH_PASSWORD, { GIT_CONFIG_COUNT: '2' }),
    ).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: `url.${WITH_PASSWORD}.insteadOf`,
      GIT_CONFIG_VALUE_2: BARE,
    });
  });

  describe('with the git on this machine', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-credential-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('git resolves the stored URL to the credentialed one from its environment alone', () => {
      const env = {
        PATH: process.env.PATH,
        HOME: '/nonexistent',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      const run = (args: string[], extra: Record<string, string> = {}) =>
        execFileSync('git', args, {
          cwd: dir,
          encoding: 'utf-8',
          env: { ...env, ...extra },
        }).trim();
      run(['init', '-q', '--template=', '.']);
      run(['config', 'remote.origin.url', BARE]);
      // What is on disk never holds the credential.
      expect(
        fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'),
      ).not.toContain(TOKEN);
      // Without the environment entry git would ask the origin anonymously.
      expect(run(['ls-remote', '--get-url', 'origin'])).toBe(BARE);
      // With it, git addresses the origin exactly as if the full URL were stored.
      for (const full of [WITH_PASSWORD, TOKEN_AS_USER])
        expect(
          run(['ls-remote', '--get-url', 'origin'], originCredentialEnv(full)),
        ).toBe(full);
    });
  });
});

describe('redactOriginCredential', () => {
  it('removes the credential in every form it can appear', () => {
    const said = [
      `Command failed: git clone --mirror -- ${WITH_PASSWORD} /srv/x`,
      `fatal: could not read Password for 'https://${TOKEN}@git.example.edu'`,
      `remote: token ${TOKEN} is not valid for ${USER}`,
    ].join('\n');
    const out = redactOriginCredential(said, [WITH_PASSWORD]);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(`${USER}:`);
    expect(out).toContain('https://***@git.example.edu');
  });

  it('removes a percent-encoded password in its decoded form too', () => {
    const out = redactOriginCredential('git said: p@ss-word-1 was refused', [
      'https://bot:p%40ss-word-1@git.example.edu/x.git',
    ]);
    expect(out).toBe('git said: *** was refused');
  });

  it('hides the user-info of any URL in the text, also with no URL given', () => {
    expect(redactOriginCredential(`unable to access '${TOKEN_AS_USER}/'`)).toBe(
      `unable to access 'https://***@${HOST_PATH}/'`,
    );
  });

  it('does not blank ordinary words for a very short user name', () => {
    expect(
      redactOriginCredential('git: a x b', [`https://x:${TOKEN}@h.example/r`]),
    ).toBe('git: a x b');
  });

  it('leaves text without a credential alone', () => {
    const text = `fatal: unable to access '${BARE}/': Could not resolve host`;
    expect(redactOriginCredential(text, [BARE, null, undefined])).toBe(text);
  });
});
