import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CHECKOUT_OWNER,
  checkoutGitOptions,
  getProgramRepoPath,
} from './program-repo.js';

afterEach(() => vi.unstubAllEnvs());

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
