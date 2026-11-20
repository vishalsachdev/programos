/**
 * Where the program repo's origin is, as far as the host may believe it.
 *
 * The origin the host fetches from and pushes to comes from the host's own
 * settings or a host-owned repository (host-repo.ts, expectedOriginUrl). The
 * agent-writable checkout is read here as a text file only, and only as a
 * hint that this is a real program repo.
 */
import { execFileSync } from 'child_process';
import path from 'path';

import { readFromCheckout } from './checkout-fs.js';
import { getProgramRepoPath } from './program-repo.js';

/** True for the origin of the placeholder repo, example-org/program-repo. */
export function isPlaceholderOrigin(url: string): boolean {
  if (/^git@github\.com:example-org\/program-repo(\.git)?$/.test(url))
    return true;
  // Parse, don't pattern-match: "https://evil?@github.com/..." must not pass.
  if (!/^https:\/\/[^\s]+$/.test(url)) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === 'github.com' &&
    u.port === '' &&
    u.search === '' &&
    u.hash === '' &&
    !url.includes('?') &&
    !url.includes('#') &&
    /^\/example-org\/program-repo(\.git)?$/.test(u.pathname)
  );
}

/**
 * True for the origin this host expects. The mirror bootstrap and the host
 * repo (host-repo.ts) check their clone URL with it, so a wrong value cannot
 * pick the source or smuggle a git option or ext:: transport. The URL itself
 * comes from PROGRAM_ORIGIN_URL or a host-owned repository, never from the
 * agent-writable checkout.
 * PROGRAM_ORIGIN_PATTERN sets the pattern; without it only the placeholder
 * repository passes.
 */
export function isExpectedOrigin(url: string): boolean {
  const pattern = process.env.PROGRAM_ORIGIN_PATTERN;
  if (pattern) return !url.startsWith('-') && new RegExp(pattern).test(url);
  return isPlaceholderOrigin(url);
}

export function readMirrorPath(): string {
  return process.env.PROGRAM_READ_MIRROR || '/srv/repos/program-repo-read.git';
}

/**
 * The `url` of `[remote "origin"]` in a git config file's text. A plain text
 * scan: no include is followed and nothing is run.
 */
export function originUrlInConfigText(text: string): string {
  let inOrigin = false;
  let url = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]/.test(line);
      continue;
    }
    const m = inOrigin ? /^url\s*=\s*(.*)$/i.exec(line) : null;
    if (m) url = m[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return url;
}

/**
 * Origin URL written in the live checkout's .git/config, read as a file.
 * No git runs in the checkout: its config is container-writable, and git
 * would obey it (see host-repo.ts). The value is a hint only. It is used to
 * notice a real program repo, never as an address to fetch from or push to.
 */
export function checkoutOriginUrl(): string {
  const root = getProgramRepoPath();
  const text = readFromCheckout(root, path.join(root, '.git', 'config'));
  return text ? originUrlInConfigText(text) : '';
}

/** Origin URL of the read mirror (host-owned, so read as the host user). */
export function mirrorOriginUrl(): string {
  return execFileSync(
    'git',
    ['--git-dir', readMirrorPath(), 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}
