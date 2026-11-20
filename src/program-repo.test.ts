import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKOUT_OWNER,
  getProgramRepoPath,
  readCheckoutOwner,
} from './program-repo.js';
import { getHostRepoPath, hostGitOptions } from './host-repo.js';

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

// Host git no longer runs in the checkout (host-repo.ts). The same
// guarantees are asserted on the options of the git that replaced it.
describe('hostGitOptions', () => {
  it('runs as the checkout owner (uid 1000) when the host is root', () => {
    const opts = hostGitOptions({ credentialed: true }, { isRoot: true });
    expect(opts.uid).toBe(CHECKOUT_OWNER.uid);
    expect(opts.gid).toBe(CHECKOUT_OWNER.gid);
    expect(CHECKOUT_OWNER.uid).toBe(1000);
    // In the host-owned repository, never in the agent's checkout.
    expect(opts.cwd).toBe(getHostRepoPath());
    expect(opts.cwd).not.toBe(getProgramRepoPath());
    // Root's HOME (and its ~/.gitconfig) must not leak into the child.
    expect(opts.env.HOME).toBe('/home/ubuntu');
  });

  it('leaves uid/gid unset when not root (dev machines, tests)', () => {
    const opts = hostGitOptions({ credentialed: true }, { isRoot: false });
    expect(opts.uid).toBeUndefined();
    expect(opts.gid).toBeUndefined();
  });

  it('gives git no variable of the host process, and no user config unless it needs the credential', () => {
    vi.stubEnv('GIT_DIR', '/tmp/elsewhere');
    vi.stubEnv('GIT_INDEX_FILE', '/tmp/index');
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh -i /host/key');
    const local = hostGitOptions({ credentialed: false }).env;
    expect(local.GIT_DIR).toBeUndefined();
    expect(local.GIT_INDEX_FILE).toBeUndefined();
    expect(local.GIT_SSH_COMMAND).toBeUndefined();
    expect(local.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(local.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(local.HOME).toBe('/nonexistent');
    const remote = hostGitOptions({ credentialed: true }).env;
    expect(remote.GIT_DIR).toBeUndefined();
    expect(remote.GIT_SSH_COMMAND).toBe('ssh -i /host/key');
    expect(remote.GIT_CONFIG_GLOBAL).toBeUndefined();
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

  // Review finding on PR 29 (Codex): Node accepts a uid or gid up to
  // 2^31 - 1 only; a larger one failed at the first checkout operation.
  it('refuses an owner id above what a child process can take', () => {
    expect(readCheckoutOwner({ CHECKOUT_OWNER_UID: '2147483647' }).uid).toBe(
      2147483647,
    );
    for (const bad of ['2147483648', '4294967295', '9999999999']) {
      expect(() => readCheckoutOwner({ CHECKOUT_OWNER_UID: bad })).toThrow(
        /CHECKOUT_OWNER_UID must be at most 2147483647/,
      );
      expect(() => readCheckoutOwner({ CHECKOUT_OWNER_GID: bad })).toThrow(
        /CHECKOUT_OWNER_GID must be at most 2147483647/,
      );
    }
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

    const hostRepo = await import('./host-repo.js');
    const remote = { credentialed: true };

    const git = hostRepo.hostGitOptions(remote, { isRoot: true });
    expect([git.uid, git.gid, git.env.HOME]).toEqual([1001, 1002, '/home/svc']);
    // Not root: no uid switch, but HOME still follows the setting.
    const dev = hostRepo.hostGitOptions(remote, { isRoot: false });
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
