/**
 * Shared location of the `program-repo` curriculum repository on the host.
 *
 * Centralizing the path keeps the default in one place while preserving the lazy
 * read: callers (and tests via vi.stubEnv) can override PROGRAM_REPO at
 * runtime, after this module is imported.
 *
 * The checkout is owned by uid 1000 (the container user). Agent containers can write this whole tree, including .git/hooks
 * and .git/config, so the host must never run git here as root: a planted
 * hook would run with root's privileges. Host git runs as CHECKOUT_OWNER via
 * checkoutGitOptions(), and host file writes go through host-fs-safety.ts.
 */

const DEFAULT_PROGRAM_REPO = '/srv/program-repo';

/** uid/gid of the container user, which owns the checkout. */
export const CHECKOUT_OWNER = { uid: 1000, gid: 1000 } as const;

export function getProgramRepoPath(): string {
  return process.env.PROGRAM_REPO || DEFAULT_PROGRAM_REPO;
}

/**
 * execFile options for host git in the checkout: as the checkout owner when
 * the host is root, with HOME pointed away from /root so root's gitconfig is
 * not read.
 */
export function checkoutGitOptions(
  { isRoot }: { isRoot: boolean } = { isRoot: process.getuid?.() === 0 },
): {
  cwd: string;
  uid?: number;
  gid?: number;
  env: NodeJS.ProcessEnv;
  timeout: number;
} {
  const env = { ...process.env, HOME: '/home/ubuntu' };
  return isRoot
    ? {
        cwd: getProgramRepoPath(),
        uid: CHECKOUT_OWNER.uid,
        gid: CHECKOUT_OWNER.gid,
        env,
        timeout: 30_000,
      }
    : { cwd: getProgramRepoPath(), env, timeout: 30_000 };
}
