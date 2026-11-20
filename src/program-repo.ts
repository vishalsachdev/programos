/**
 * Shared location of the `program-repo` curriculum repository on the host.
 *
 * Centralizing the path keeps the default in one place while preserving the lazy
 * read: callers (and tests via vi.stubEnv) can override PROGRAM_REPO at
 * runtime, after this module is imported.
 *
 * The checkout is owned by uid 1000 (the container user). Agent containers
 * can write this whole tree, including .git/hooks and .git/config, and git
 * obeys both. So the host runs NO git command with this checkout as its
 * repository, as any user. Host git runs in the host-owned repository
 * (host-repo.ts), which takes commits out of the checkout with a fetch.
 * host-git-guard.test.ts fails when a new host git call appears outside the
 * reviewed list. Host file reads and writes here go through checkout-fs.ts.
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

const MAX_OWNER_ID = 2 ** 31 - 1;

function ownerId(name: string, raw: string | undefined, dflt: number): number {
  if (!raw) return dflt;
  // Refuse rather than fall back: a typo must not silently pick another user,
  // and 0 would run git in a container-writable tree as root.
  if (!/^[1-9][0-9]{0,9}$/.test(raw))
    throw new Error(`${name} must be a positive whole number, got "${raw}"`);
  // Node takes a uid or gid for a child process as a signed 32-bit number
  // only. A larger id would load here and then fail at the first git or file
  // operation in the checkout, so it is refused at start.
  if (Number(raw) > MAX_OWNER_ID)
    throw new Error(`${name} must be at most ${MAX_OWNER_ID}, got "${raw}"`);
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
