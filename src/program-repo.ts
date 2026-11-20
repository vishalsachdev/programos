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
 *
 * CHECKOUT_OWNER_UID, CHECKOUT_OWNER_GID and CHECKOUT_OWNER_HOME (process
 * environment, read once at start) replace the defaults 1000, 1000 and
 * /home/ubuntu. They matter only when the host runs as root. The container
 * still runs as uid 1000 in that case (container-runner.ts), so the checkout
 * must stay writable by uid 1000 whatever is set here.
 */

const DEFAULT_PROGRAM_REPO = '/srv/program-repo';

export interface CheckoutOwner {
  uid: number;
  gid: number;
  /** HOME for the owner's git and shell children (never root's home). */
  home: string;
}

function ownerId(name: string, raw: string | undefined, dflt: number): number {
  if (!raw) return dflt;
  // Refuse rather than fall back: a typo must not silently pick another user,
  // and 0 would run git in a container-writable tree as root.
  if (!/^[1-9][0-9]{0,9}$/.test(raw))
    throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  return Number(raw);
}

/** The checkout owner from the environment; unset or empty keeps a default. */
export function readCheckoutOwner(
  env: NodeJS.ProcessEnv = process.env,
): CheckoutOwner {
  const home = env.CHECKOUT_OWNER_HOME || '/home/ubuntu';
  if (!home.startsWith('/'))
    throw new Error(
      `CHECKOUT_OWNER_HOME must be an absolute path, got "${home}"`,
    );
  return {
    uid: ownerId('CHECKOUT_OWNER_UID', env.CHECKOUT_OWNER_UID, 1000),
    gid: ownerId('CHECKOUT_OWNER_GID', env.CHECKOUT_OWNER_GID, 1000),
    home,
  };
}

/** uid/gid/home of the checkout owner (by default the container user). */
export const CHECKOUT_OWNER: Readonly<CheckoutOwner> = readCheckoutOwner();

export function getProgramRepoPath(): string {
  return process.env.PROGRAM_REPO || DEFAULT_PROGRAM_REPO;
}

/**
 * execFile options for host git in the checkout: as the checkout owner when
 * the host is root, with HOME pointed at the owner's home so root's gitconfig
 * is not read.
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
  const env = { ...process.env, HOME: CHECKOUT_OWNER.home };
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
