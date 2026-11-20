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
 * `text` with every form of the credentials of `urls` replaced by "***": the
 * whole user-info, the user name and the password each, as written and
 * percent-decoded. Also any other "//user-info@" in the text. For log lines
 * and error messages that quote git or a URL.
 */
export function redactOriginCredential(
  text: string,
  urls: Array<string | null | undefined> = [],
): string {
  const secrets = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    const { userinfo } = splitOriginCredential(url);
    if (!userinfo) continue;
    const colon = userinfo.indexOf(':');
    const parts =
      colon < 0
        ? [userinfo]
        : [userinfo, userinfo.slice(0, colon), userinfo.slice(colon + 1)];
    for (const part of parts) {
      // A very short piece ("x", "git") would blank ordinary words.
      if (part.length >= 4) secrets.add(part);
      if (decoded(part).length >= 4) secrets.add(decoded(part));
    }
  }
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(secret).join('***');
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, '$1***@');
}
