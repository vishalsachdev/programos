/**
 * A credential written inside the origin URL ("https://user:token@host/...").
 *
 * The host keeps such a URL in one place only: the setting it came from
 * (PROGRAM_ORIGIN_URL in the service's environment). Git is given the URL
 * without the credential, on the command line and in a repository's config,
 * and gets the credential through its environment: a `url.<with
 * credential>.insteadOf = <without>` entry passed with GIT_CONFIG_COUNT.
 * Git then talks to the origin exactly as it did when the full URL was in
 * its config, and:
 *
 *  - no git config file holds the credential;
 *  - no process argument holds it (arguments are visible to every local
 *    user; a process's environment only to its own user and root);
 *  - no container can read it (the host's environment is not mounted).
 *
 * Needs git 2.31 or later for GIT_CONFIG_COUNT. An older git ignores the
 * entry and the request goes out without a credential: it fails, and nothing
 * leaks.
 */

export interface SplitOrigin {
  /** The URL without the user-info part. Safe in a config file or a log. */
  bare: string;
  /** The URL as it was set. Differs from `bare` only with a credential. */
  full: string;
  /** The text between "https://" and "@", or '' when there is none. */
  userinfo: string;
}

/**
 * Split an HTTPS URL into the address and the credential. Every other URL
 * shape (ssh, scp-like, file, a path) is returned unchanged: the user name of
 * an SSH address is not a secret, and SSH takes no password from a URL.
 */
export function splitOriginCredential(url: string): SplitOrigin {
  const none = { bare: url, full: url, userinfo: '' };
  const m = /^(https:\/\/)([^/?#]*)(.*)$/i.exec(url);
  if (!m) return none;
  const at = m[2].lastIndexOf('@');
  if (at < 0) return none;
  return {
    bare: `${m[1]}${m[2].slice(at + 1)}${m[3]}`,
    full: url,
    userinfo: m[2].slice(0, at),
  };
}

/**
 * Why this origin URL must not be used, or null. A credential in a URL is
 * handled safely for `https://` only (above): there it leaves the URL before
 * git sees a command line. On any other scheme the whole URL is what git is
 * given, and on `http://`, `git://` and `ftp://` the credential would also
 * cross the network unencrypted. `ssh://user@host` is a user name and is
 * fine; `ssh://user:password@host` is a secret on a command line.
 *
 * The text names the scheme and never the URL: the URL is the secret.
 */
export function originCredentialProblem(
  url: string | null | undefined,
): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^\s]*)$/i.exec((url ?? '').trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === 'https' || scheme === 'file') return null;
  const at = m[2].lastIndexOf('@');
  if (at < 0) return null;
  const userinfo = m[2].slice(0, at);
  if (scheme === 'ssh' && !userinfo.includes(':')) return null;
  return scheme === 'ssh'
    ? 'the origin URL is an ssh:// address with a password in it. SSH takes no password from a URL, and git would be given it on its command line. Remove the password and use an SSH key.'
    : `the origin URL uses ${scheme}:// and carries a user name, password or token. That scheme is not encrypted, and the credential would reach git's command line and the log. Use an https:// URL for an origin that needs a credential.`;
}

/** True when the URL carries a user name, a password or a token. */
export function hasOriginCredential(url: string): boolean {
  return splitOriginCredential(url).userinfo !== '';
}

/**
 * Environment entries that hand git the credential of `url`, added after any
 * GIT_CONFIG_COUNT entries already in `base`. Empty when the URL has none.
 */
export function originCredentialEnv(
  url: string | null | undefined,
  base: NodeJS.ProcessEnv = {},
): Record<string, string> {
  if (!url) return {};
  const { bare, full, userinfo } = splitOriginCredential(url);
  if (!userinfo) return {};
  const count = /^\d+$/.test(base.GIT_CONFIG_COUNT || '')
    ? Number(base.GIT_CONFIG_COUNT)
    : 0;
  return {
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: `url.${full}.insteadOf`,
    [`GIT_CONFIG_VALUE_${count}`]: bare,
  };
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Every reading of the user-info of `url`, for redaction only. Two readings
 * are needed because the characters "@" and "/" may stand unencoded in a
 * user name or a token somebody pasted:
 *  - up to the last "@" before the first "/" (how git and this file split
 *    a well-formed URL);
 *  - up to the last "@" of the whole URL, for a token with a "/" in it.
 * Any scheme, so a URL this host refuses to use is still taken out of text
 * that quotes it.
 */
function userinfoReadings(url: string): string[] {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^\s]*)$/i.exec(url.trim());
  if (!m) return [];
  const rest = m[1];
  const out = new Set<string>();
  const authority = rest.split(/[/?#]/)[0];
  if (authority.includes('@'))
    out.add(authority.slice(0, authority.lastIndexOf('@')));
  if (rest.includes('@')) out.add(rest.slice(0, rest.lastIndexOf('@')));
  return [...out].filter(Boolean);
}

/**
 * `text` with every form of the credentials of `urls` replaced by "***": the
 * whole user-info, the user name and the password each, as written and
 * percent-decoded. Also any other "//user-info@" in the text, up to the last
 * "@" before the path. For log lines and error messages that quote git or a
 * URL.
 */
export function redactOriginCredential(
  text: string,
  urls: Array<string | null | undefined> = [],
): string {
  const secrets = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    for (const userinfo of userinfoReadings(url)) {
      // Every split at a ":": a user name ends at the first one, but a
      // name or a token pasted with a ":" in it makes any of them the
      // boundary, and git may print either side alone.
      const parts = [userinfo];
      for (let colon = userinfo.indexOf(':'); colon >= 0; ) {
        parts.push(userinfo.slice(0, colon), userinfo.slice(colon + 1));
        colon = userinfo.indexOf(':', colon + 1);
      }
      for (const part of parts) {
        // A very short piece ("x", "git") would blank ordinary words.
        if (part.length >= 4) secrets.add(part);
        if (decoded(part).length >= 4) secrets.add(decoded(part));
      }
    }
  }
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(secret).join('***');
  // Any "scheme://...@" left in the text: everything up to the last "@" of
  // the word goes. A user name or a token may hold "@", ":" and "/" as
  // written, so no shorter match is safe. The cost: a URL with no
  // credential and an "@" in its path loses its host in the log line.
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s'"]*@/gi, '$1***@');
}
