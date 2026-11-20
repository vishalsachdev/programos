import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CHECKOUT_OWNER } from './program-repo.js';

/**
 * File operations on the container-writable program-repo checkout, run as the
 * checkout owner (CHECKOUT_OWNER in program-repo.ts; uid 1000 by default)
 * instead of root.
 *
 * Why not in-process: any root path operation there can be redirected. A
 * container can swap a parent directory for a symlink between a check and
 * the open (O_NOFOLLOW covers only the last component), so root would write,
 * create or read outside the tree. Done as uid 1000, a redirected operation
 * has the container's own privileges and nothing more, and new directories
 * come out owned by uid 1000. Small `sh`/`cat`/`mv` children keep it cheap.
 *
 * When the host is not root (dev machines, tests) the same commands run as
 * the current user.
 */

const SH = '/bin/sh';
const MAX_READ = 64 * 1024 * 1024;

/**
 * Shell prelude shared by every operation. $1 = target, $2 = checkout root.
 * - Refuse unless $2/.git exists (a missing or wrong root must not get a
 *   fresh plain directory tree that appends succeed into and commits miss).
 * - GNU=1 on Linux (production): coreutils dd opens the file itself with
 *   O_NOFOLLOW|O_NONBLOCK, so a link or FIFO swapped in after any check can
 *   neither redirect nor block the open; mv -T never moves into a directory.
 *   Elsewhere (dev) fall back to check-then-act, which is racy but runs as
 *   the developer anyway.
 */
const PRELUDE =
  '[ -d "$2/.git" ] || { echo "refused: $2 is not a checkout" >&2; exit 5; }; ' +
  'GNU=0; dd --version >/dev/null 2>&1 && GNU=1; ';

/** Relative path of `target` inside `root`, or throw if it is not inside. */
export function checkoutRelPath(root: string, target: string): string {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (
    !rel ||
    path.isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${path.sep}`)
  )
    throw new Error(`refused: ${target} is not inside ${root}`);
  return rel;
}

export function ownerSpawnOptions(isRoot = process.getuid?.() === 0): {
  uid?: number;
  gid?: number;
  env: Record<string, string>;
  timeout: number;
} {
  const env = { PATH: '/usr/bin:/bin', HOME: CHECKOUT_OWNER.home };
  // Short timeout: these run synchronously on the message path.
  return isRoot
    ? { uid: CHECKOUT_OWNER.uid, gid: CHECKOUT_OWNER.gid, env, timeout: 5_000 }
    : { env, timeout: 5_000 };
}

function runRaw(
  script: string,
  root: string,
  target: string,
  input?: string,
): Buffer {
  checkoutRelPath(root, target);
  // Cheap in-process refusal first (a stat, harmless as root): with no
  // checkout there is nothing to protect, and every audit write would
  // otherwise pay a process spawn just to be refused. The child re-checks.
  if (!fs.existsSync(path.join(root, '.git')))
    throw new Error(`refused: ${root} has no .git (not a checkout)`);
  return execFileSync(
    SH,
    ['-c', PRELUDE + script, 'sh', path.resolve(target), path.resolve(root)],
    { ...ownerSpawnOptions(), input, maxBuffer: MAX_READ },
  );
}

/** Append `content` to `target`, creating parent directories. */
export function appendToCheckout(
  root: string,
  target: string,
  content: string,
): void {
  runRaw(
    'mkdir -p "$(dirname "$1")" || exit 1; ' +
      'if [ $GNU = 1 ]; then ' +
      'exec dd of="$1" oflag=append,nofollow,nonblock conv=notrunc status=none; fi; ' +
      'if [ -L "$1" ] || { [ -e "$1" ] && [ ! -f "$1" ]; }; then ' +
      'echo "refused: $1 is not a regular file" >&2; exit 4; fi; ' +
      'cat >> "$1"',
    root,
    target,
    content,
  );
}

/** Replace `target` with `content` (temp file + rename in the same dir). */
export function writeToCheckout(
  root: string,
  target: string,
  content: string,
): void {
  runRaw(
    'd=$(dirname "$1") && mkdir -p "$d" && t=$(mktemp "$d/.host-write.XXXXXX") || exit 1; ' +
      // Write the temp through dd too: a FIFO or link swapped in for it after
      // mktemp must neither block nor redirect the write.
      'if [ $GNU = 1 ]; then dd of="$t" oflag=nofollow,nonblock conv=notrunc status=none; ' +
      'else cat > "$t"; fi || { rm -f "$t"; exit 1; }; ' +
      'if [ $GNU = 1 ]; then mv -fT "$t" "$1" && exit 0; rm -f "$t"; exit 1; fi; ' +
      'if [ -d "$1" ] && [ ! -L "$1" ]; then rm -f "$t"; ' +
      'echo "refused: $1 is a directory" >&2; exit 4; fi; ' +
      'mv -f "$t" "$1" || { rm -f "$t"; exit 1; }',
    root,
    target,
    content,
  );
}

/** Read `target`'s bytes; null if it is missing, a link, or not a regular file. */
export function readFromCheckoutBuffer(
  root: string,
  target: string,
): Buffer | null {
  try {
    // A link is treated as absent: as uid 1000 it could still point at a
    // world-readable file outside the checkout, whose content would then be
    // written back into the repo and pushed.
    return runRaw(
      '[ -f "$1" ] && [ ! -L "$1" ] || exit 3; ' +
        // A real dd failure propagates (not 3): only the explicit checks
        // above mean "absent".
        'if [ $GNU = 1 ]; then exec dd if="$1" iflag=nofollow,nonblock status=none; fi; ' +
        'exec cat "$1"',
      root,
      target,
    );
  } catch (err) {
    if ((err as { status?: number }).status === 3) return null;
    throw err;
  }
}

/** Read `target` as UTF-8; null if it is missing or not a regular file. */
export function readFromCheckout(root: string, target: string): string | null {
  return readFromCheckoutBuffer(root, target)?.toString('utf8') ?? null;
}

/**
 * True if `target` (a file, or a directory searched for *.md files) has a
 * line exactly equal to `line`. One grep as the checkout owner: FIFOs and
 * devices are skipped (-D skip) and symlinks are not followed (-r, not -R).
 */
export function checkoutHasLine(
  root: string,
  target: string,
  line: string,
): boolean {
  checkoutRelPath(root, target);
  try {
    execFileSync(
      'grep',
      [
        '-qxF',
        '-D',
        'skip',
        '-r',
        '--include=*.md',
        '-e',
        line,
        path.resolve(target),
      ],
      { ...ownerSpawnOptions(), stdio: ['ignore', 'ignore', 'pipe'] },
    );
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 1 = no match; 2 with a missing path = nothing recorded yet.
    if (status === 1) return false;
    if (
      status === 2 &&
      /No such file/.test(String((err as { stderr?: Buffer }).stderr))
    )
      return false;
    throw err;
  }
}
