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
  // Anything after "://" counts, spaces included: a URL git would refuse
  // still reaches a log line first.
  const m = /^([a-z][a-z0-9+.-]*):\/\/([\s\S]*)$/i.exec((url ?? '').trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === 'file') return null;
  // A token in the query string or the fragment is part of the address on
  // every scheme: it cannot be handed to git apart from the URL.
  if (/[?#]/.test(m[2]))
    return `the origin URL has a "?" or a "#" part. A token written there is part of the address and would reach git's command line and the log. Put the credential before the host name of an https:// URL (https://user:token@host/...), or use an SSH key.`;
  if (scheme === 'https') return null;
  // The user-info ends at the last "@" before the path. A password pasted
  // with a "/" in it cuts the host part short: then what stands before the
  // first "/" has a ":" that is not followed by a port number, and an "@"
  // comes later.
  const slash = m[2].indexOf('/');
  const authority = slash < 0 ? m[2] : m[2].slice(0, slash);
  let userinfo = authority.includes('@')
    ? authority.slice(0, authority.lastIndexOf('@'))
    : '';
  if (!userinfo && m[2].includes('@') && /:(?!\d*$)/.test(authority))
    userinfo = m[2].slice(0, m[2].lastIndexOf('@'));
  if (!userinfo) return null;
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

/** Percent-decoded, one escape at a time: a bad escape stays as written. */
function decoded(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Every spelling of one piece of a credential that a program may print: as
 * written, decoded, and encoded again with the escapes in either letter
 * case.
 */
function spellings(part: string): string[] {
  const plain = decoded(part);
  const encoded = encodeURIComponent(plain);
  const lower = encoded.replace(/%[0-9A-F]{2}/g, (e) => e.toLowerCase());
  const asWrittenUpper = part.replace(/%[0-9a-f]{2}/gi, (e) => e.toUpperCase());
  const asWrittenLower = part.replace(/%[0-9a-f]{2}/gi, (e) => e.toLowerCase());
  return [part, plain, encoded, lower, asWrittenUpper, asWrittenLower];
}

/**
 * Every reading of the user-info of `url`, for redaction only. Two readings
 * are needed because the characters "@" and "/" may stand unencoded in a
 * user name or a token somebody pasted:
 *  - up to the last "@" before the first "/" (how git and this file split
 *    a well-formed URL);
 *  - up to the last "@" of the whole URL, for a token with a "/" in it.
 * Any scheme, so a URL this host refuses to use is still taken out of text
 * that quotes it. The one exception: the user name of an SSH address with
 * no password is not a secret ("git"), and taking it out would blank that
 * word wherever it stands.
 */
function userinfoReadings(url: string): string[] {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([\s\S]*)$/i.exec(url.trim());
  if (!m) return [];
  const rest = m[2];
  const out = new Set<string>();
  const authority = rest.split(/[/?#]/)[0];
  if (authority.includes('@'))
    out.add(authority.slice(0, authority.lastIndexOf('@')));
  if (rest.includes('@')) out.add(rest.slice(0, rest.lastIndexOf('@')));
  const readings = [...out].filter(Boolean);
  if (m[1].toLowerCase() === 'ssh' && authority.includes('@'))
    return readings.filter(
      (r) =>
        r.includes(':') && r === authority.slice(0, authority.lastIndexOf('@')),
    );
  return readings;
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
        for (const form of spellings(part))
          if (form.length >= 4) secrets.add(form);
      }
    }
  }
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    out = out.split(secret).join('***');
  // Any "scheme://...@" left in the text: everything up to the last "@" of
  // the word goes. A user name or a token may hold "@", ":", "/" and quotes
  // as written, so no shorter match is safe. The cost: a URL with no
  // credential and an "@" in its path loses its host in the log line.
  return out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s]*@/gi, '$1***@');
}
