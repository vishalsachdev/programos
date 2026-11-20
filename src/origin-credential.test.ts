import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasOriginCredential,
  originCredentialEnv,
  originCredentialProblem,
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

describe('redaction of a user name or a token with "@", ":" or "/" in it', () => {
  // Obviously fake, and assembled so that no line holds a URL with a password.
  const SECRET = ['fake', 'tok', '9912'].join('-');
  const HOST = 'git.example.edu';
  const at = String.fromCharCode(64);
  const cases: [string, string, string][] = [
    ['"@" in the user name, as written', `bot${at}corp.example`, SECRET],
    ['"@" in the user name, encoded', 'bot%40corp.example', SECRET],
    ['"@" in the token, as written', 'kb-bot', `${SECRET}${at}v2`],
    ['"@" in the token, encoded', 'kb-bot', `${SECRET}%40v2`],
    ['":" in the token, as written', 'kb-bot', `${SECRET}:part2`],
    ['":" in the token, encoded', 'kb-bot', `${SECRET}%3Apart2`],
    ['":" in the user name, encoded', 'kb%3Abot', SECRET],
    ['"/" in the token, as written', 'kb-bot', `${SECRET}/part2`],
    ['"/" in the token, encoded', 'kb-bot', `${SECRET}%2Fpart2`],
    ['"/" in the user name, as written', 'team/kb-bot', SECRET],
    ['"/" in the user name, encoded', 'team%2Fkb-bot', SECRET],
    ['all three in both', `a${at}b:c/d`, `${SECRET}${at}x:y/z`],
  ];

  it.each(cases)('%s: with the URL known', (_name, user, token) => {
    const url = `https://${user}:${token}${at}${HOST}/team/repo.git`;
    const decodedUser = decodeURIComponent(user);
    const decodedToken = decodeURIComponent(token);
    const said = [
      `Command failed: git clone --mirror -- ${url} /srv/x`,
      `fatal: could not read Password for 'https://${user}${at}${HOST}'`,
      `fatal: Authentication failed for 'https://${decodedUser}:${decodedToken}${at}${HOST}/team/repo.git/'`,
      `remote: token ${decodedToken} is not valid for ${decodedUser}`,
    ].join('\n');
    const out = redactOriginCredential(said, [url]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(token);
    expect(out).not.toContain(decodedToken);
    expect(out).not.toContain(user);
    expect(out).not.toContain(decodedUser);
    expect(out).toContain(`${HOST}`);
  });

  it.each(cases)('%s: with no URL given', (_name, user, token) => {
    const url = `https://${user}:${token}${at}${HOST}/team/repo.git`;
    const out = redactOriginCredential(`unable to access '${url}/'`);
    expect(out).not.toContain(SECRET);
    expect(out).toContain(`***${at}${HOST}/team/repo.git`);
  });

  it('a token written as the user name, with "@" in it and no password', () => {
    const url = `https://${SECRET}${at}v2${at}${HOST}/team/repo.git`;
    expect(redactOriginCredential(`unable to access '${url}/'`)).toBe(
      `unable to access 'https://***${at}${HOST}/team/repo.git/'`,
    );
    expect(redactOriginCredential(`said ${SECRET}${at}v2 again`, [url])).toBe(
      'said *** again',
    );
  });

  it('a URL on a scheme this host refuses is redacted like any other', () => {
    const url = `http://kb-bot:${SECRET}${at}${HOST}/team/repo.git`;
    const out = redactOriginCredential(
      `clone of ${url} failed; token ${SECRET}`,
      [url],
    );
    expect(out).not.toContain(SECRET);
  });

  it('takes out a credential next to a quote or a space, and in each spelling of its escapes', () => {
    const q = String.fromCharCode(34);
    // No URL given: a quote inside the user-info does not end the match.
    for (const userinfo of [
      `kb-bot:${SECRET}${q}x${at}y`,
      `kb-bot:${SECRET}'x`,
    ]) {
      const out = redactOriginCredential(
        `fatal: unable to access 'https://${userinfo}${at}${HOST}/x/'`,
      );
      expect(out, userinfo.replace(SECRET, '…')).not.toContain(SECRET);
    }
    // A space in the token, with the URL known.
    const spaced = `https://kb-bot:${SECRET} part2${at}${HOST}/x`;
    expect(
      redactOriginCredential(`bad token ${SECRET} part2 for ${spaced}`, [
        spaced,
      ]),
    ).not.toContain(SECRET);
    // Written with "@" as is, printed encoded; and escapes in either case.
    expect(
      redactOriginCredential(`bad token ${SECRET}%40v2`, [
        `https://kb-bot:${SECRET}${at}v2${at}${HOST}/x`,
      ]),
    ).toBe('bad token ***');
    expect(
      redactOriginCredential(`bad token ${SECRET}%2fv2`, [
        `https://kb-bot:${SECRET}%2Fv2${at}${HOST}/x`,
      ]),
    ).toBe('bad token ***');
    // An escape that cannot be decoded does not stop the others.
    expect(
      redactOriginCredential(`bad token ${SECRET}/v2%zz`, [
        `https://kb-bot:${SECRET}%2Fv2%zz${at}${HOST}/x`,
      ]),
    ).toBe('bad token ***');
  });

  it('does not blank the user name of an SSH address, which is not a secret', () => {
    const text = 'ssh: connect to host gitlab.example.edu port 22: refused';
    expect(
      redactOriginCredential(text, [
        'ssh://gitlab@gitlab.example.edu/team/repo.git',
      ]),
    ).toBe(text);
  });

  it('leaves a URL with a port and no credential alone', () => {
    const text = `fatal: unable to access 'https://${HOST}:8443/team/repo.git/'`;
    expect(
      redactOriginCredential(text, [`https://${HOST}:8443/team/repo.git`]),
    ).toBe(text);
  });
});

describe('originCredentialProblem', () => {
  const SECRET = ['fake', 'tok', '9913'].join('-');
  const at = String.fromCharCode(64);

  it('refuses a credential on a scheme that is not encrypted, and never quotes it', () => {
    for (const url of [
      `http://kb-bot:${SECRET}${at}git.example.edu/team/repo.git`,
      `http://${SECRET}${at}git.example.edu/team/repo.git`,
      `HTTP://kb-bot:${SECRET}${at}git.example.edu/team/repo.git`,
      `git://kb-bot:${SECRET}${at}git.example.edu/team/repo.git`,
      `ftp://kb-bot:${SECRET}${at}git.example.edu/team/repo.git`,
      `ssh://git:${SECRET}${at}git.example.edu/team/repo.git`,
      `http://kb-bot:${SECRET}/x${at}git.example.edu/team/repo.git`,
    ]) {
      const problem = originCredentialProblem(url);
      expect(problem, url.replace(SECRET, '…')).toBeTruthy();
      expect(problem).not.toContain(SECRET);
      expect(problem).not.toContain('kb-bot');
      expect(problem).not.toContain('git.example.edu');
    }
    expect(
      originCredentialProblem(
        `http://kb-bot:${SECRET}${at}git.example.edu/team/repo.git`,
      ),
    ).toMatch(/http:\/\/.*not encrypted.*https:\/\//);
  });

  it('refuses a URL with spaces in it, and a token in the query string or the fragment on any scheme', () => {
    for (const url of [
      `http://kb bot:${SECRET}${at}git.example.edu/team/repo.git`,
      `http://kb-bot:${SECRET}${at}git.example.edu/team/re po.git`,
      `http://git.example.edu/team/repo.git?private_token=${SECRET}`,
      `https://git.example.edu/team/repo.git?access_token=${SECRET}`,
      `https://git.example.edu/team/repo.git#${SECRET}`,
    ]) {
      const problem = originCredentialProblem(url);
      expect(problem, url.replace(SECRET, '…')).toBeTruthy();
      expect(problem).not.toContain(SECRET);
      expect(problem).not.toContain('git.example.edu');
    }
  });

  it('reads the user part up to the path: an "@" in the path of an SSH address is not a password', () => {
    for (const url of [
      'ssh://git@git.example.edu:2222/team/repo@v2.git',
      'ssh://git.example.edu:2222/team/repo@v2.git',
      'http://git.example.edu:8080/team/repo@v2.git',
      'http://git.example.edu/team/repo@v2.git',
    ]) {
      expect(originCredentialProblem(url), url).toBeNull();
    }
  });

  it('has nothing to say about the forms the host handles', () => {
    for (const url of [
      '',
      undefined,
      null,
      'https://git.example.edu/team/repo.git',
      `https://kb-bot:${SECRET}${at}git.example.edu/team/repo.git`,
      'http://git.example.edu/team/repo.git',
      'ssh://git@git.example.edu/team/repo.git',
      'git@git.example.edu:team/repo.git',
      '/srv/repos/origin.git',
      'file:///srv/repos/origin.git',
    ]) {
      expect(originCredentialProblem(url), String(url)).toBeNull();
    }
  });
});

describe('the start-up step', () => {
  it('main() refuses such an origin before anything talks to git, with a message built from the scheme only', () => {
    const text = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    const main = text.slice(text.indexOf('async function main()'));
    const check = main.indexOf(
      'originCredentialProblem(process.env.PROGRAM_ORIGIN_URL)',
    );
    expect(check).toBeGreaterThan(0);
    expect(main).toMatch(
      /if \(originProblem\) throw new Error\(`PROGRAM_ORIGIN_URL: \$\{originProblem\}`\);/,
    );
    // Before the host repo is created, the mirror is read, or a channel starts.
    for (const later of ['ensureHostRepo()', 'initDatabase()'])
      expect(check).toBeLessThan(main.indexOf(later));
  });
});
