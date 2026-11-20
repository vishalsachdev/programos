import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKOUT_OWNER,
  checkoutGitOptions,
  getProgramRepoPath,
  readCheckoutOwner,
} from './program-repo.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getProgramRepoPath', () => {
  it('defaults to /srv/program-repo, outside /root', () => {
    vi.stubEnv('PROGRAM_REPO', '');
    expect(getProgramRepoPath()).toBe('/srv/program-repo');
  });

  it('honours PROGRAM_REPO', () => {
    vi.stubEnv('PROGRAM_REPO', '/tmp/kb');
    expect(getProgramRepoPath()).toBe('/tmp/kb');
  });
});

describe('checkoutGitOptions', () => {
  it('runs as the checkout owner (uid 1000) when the host is root', () => {
    const opts = checkoutGitOptions({ isRoot: true });
    expect(opts.uid).toBe(CHECKOUT_OWNER.uid);
    expect(opts.gid).toBe(CHECKOUT_OWNER.gid);
    expect(CHECKOUT_OWNER.uid).toBe(1000);
    expect(opts.cwd).toBe(getProgramRepoPath());
    // Root's HOME (and its ~/.gitconfig) must not leak into the child.
    expect(opts.env.HOME).toBe('/home/ubuntu');
  });

  it('leaves uid/gid unset when not root (dev machines, tests)', () => {
    const opts = checkoutGitOptions({ isRoot: false });
    expect(opts.uid).toBeUndefined();
    expect(opts.gid).toBeUndefined();
  });
});

describe('readCheckoutOwner', () => {
  it('defaults to uid 1000, gid 1000 and /home/ubuntu', () => {
    const dflt = { uid: 1000, gid: 1000, home: '/home/ubuntu' };
    expect(readCheckoutOwner({})).toEqual(dflt);
    expect(
      readCheckoutOwner({
        CHECKOUT_OWNER_UID: '',
        CHECKOUT_OWNER_GID: '',
        CHECKOUT_OWNER_HOME: '',
      }),
    ).toEqual(dflt);
  });

  it('reads the three settings', () => {
    expect(
      readCheckoutOwner({
        CHECKOUT_OWNER_UID: '1001',
        CHECKOUT_OWNER_GID: '1002',
        CHECKOUT_OWNER_HOME: '/home/svc',
      }),
    ).toEqual({ uid: 1001, gid: 1002, home: '/home/svc' });
  });

  it('refuses root, a non-number or a relative home instead of guessing', () => {
    for (const bad of ['0', '-1', '1000x', ' 1000', '1e3', 'ubuntu', '01']) {
      expect(() => readCheckoutOwner({ CHECKOUT_OWNER_UID: bad })).toThrow(
        /CHECKOUT_OWNER_UID/,
      );
      expect(() => readCheckoutOwner({ CHECKOUT_OWNER_GID: bad })).toThrow(
        /CHECKOUT_OWNER_GID/,
      );
    }
    expect(() => readCheckoutOwner({ CHECKOUT_OWNER_HOME: 'home/x' })).toThrow(
      /CHECKOUT_OWNER_HOME/,
    );
  });

  it('feeds host git and the checkout file operations when the host is root', async () => {
    vi.stubEnv('CHECKOUT_OWNER_UID', '1001');
    vi.stubEnv('CHECKOUT_OWNER_GID', '1002');
    vi.stubEnv('CHECKOUT_OWNER_HOME', '/home/svc');
    vi.resetModules();
    const repo = await import('./program-repo.js');
    const fsOps = await import('./checkout-fs.js');

    const git = repo.checkoutGitOptions({ isRoot: true });
    expect([git.uid, git.gid, git.env.HOME]).toEqual([1001, 1002, '/home/svc']);
    // Not root: no uid switch, but HOME still follows the setting.
    const dev = repo.checkoutGitOptions({ isRoot: false });
    expect([dev.uid, dev.gid, dev.env.HOME]).toEqual([
      undefined,
      undefined,
      '/home/svc',
    ]);

    const sh = fsOps.ownerSpawnOptions(true);
    expect([sh.uid, sh.gid]).toEqual([1001, 1002]);
    expect(sh.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/svc' });
  });
});
