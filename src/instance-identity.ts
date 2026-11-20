import { readEnvFile } from './env.js';

/**
 * Identity settings for one deployment: the mail domains and git author
 * identities that code compares against. Each is read from `.env` or the
 * process environment (the process environment wins, as in config.ts) and
 * defaults to the repo's placeholder. Values are fixed at import.
 * INSTITUTION_DOMAIN and ADMIN_AUTHOR_EMAILS have no usable default on a
 * real program repo; see identity-settings-check.ts.
 *
 * A value that is set but malformed throws at startup: these settings feed
 * access decisions, and a silent fallback to a placeholder would be worse
 * than a host that refuses to start.
 */
const envConfig = readEnvFile([
  'INSTITUTION_DOMAIN',
  'BOT_MAIL_DOMAIN',
  'INTAKE_GIT_AUTHOR_EMAIL',
  'ADMIN_AUTHOR_EMAILS',
]);

const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+$/;

function raw(key: string): string {
  return (process.env[key] || envConfig[key] || '').trim().toLowerCase();
}

function domainSetting(key: string, fallback: string): string {
  const value = raw(key);
  if (!value) return fallback;
  if (!DOMAIN_RE.test(value)) {
    throw new Error(
      `${key} must be a bare mail domain such as "example.edu" (got "${value}")`,
    );
  }
  return value;
}

function emailSetting(key: string, fallback: string): string {
  const value = raw(key);
  if (!value) return fallback;
  if (!EMAIL_RE.test(value)) {
    throw new Error(`${key} must be one email address (got "${value}")`);
  }
  return value;
}

function emailListSetting(key: string, fallback: string[]): string[] {
  const value = raw(key);
  if (!value) return fallback;
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const bad = items.filter((item) => !EMAIL_RE.test(item));
  if (items.length === 0 || bad.length > 0) {
    throw new Error(
      `${key} must be a comma-separated list of email addresses` +
        (bad.length ? ` (not an address: "${bad.join('", "')}")` : ''),
    );
  }
  return items;
}

/** The institution domain this repo ships with. It is nobody's. */
export const PLACEHOLDER_INSTITUTION_DOMAIN = 'example.edu';

/**
 * The institution's mail domain. A blocked sender on this domain (or a
 * subdomain) gets the one-time "access closed" reply, and a route named in
 * an allowlist row resolves to `<name>@<this domain>`. With a real program
 * repo the setting is required and must not be the placeholder or a
 * subdomain of it: identity-settings-check.ts stops the host at startup.
 */
export const INSTITUTION_DOMAIN = domainSetting(
  'INSTITUTION_DOMAIN',
  PLACEHOLDER_INSTITUTION_DOMAIN,
);

/** False when INSTITUTION_DOMAIN fell back to the placeholder. */
export const INSTITUTION_DOMAIN_IS_SET = raw('INSTITUTION_DOMAIN') !== '';

/**
 * The bot's own mail domain: the default bot mailbox, the Message-ID
 * domain of outbound mail and the bot's git author address.
 */
export const BOT_MAIL_DOMAIN = domainSetting('BOT_MAIL_DOMAIN', 'example.org');

/**
 * Git author of the host's own commits. The prompts and skills tell the
 * agent to commit with this address too; they carry it as text.
 */
export const BOT_GIT_AUTHOR_EMAIL = `program-bot@${BOT_MAIL_DOMAIN}`;

/**
 * Git author of the inbound mail intake service. An original `.eml` is
 * accepted only when this author first committed it, and its pushes are
 * treated as bot pushes.
 */
export const INTAKE_GIT_AUTHOR_EMAIL = emailSetting(
  'INTAKE_GIT_AUTHOR_EMAIL',
  'email-inbox@example.org',
);

/**
 * The admin identities this repo ships with. They belong to nobody, and a
 * git author address is not verified, so on a real program repo anyone with
 * push access could commit as one of them.
 */
export const PLACEHOLDER_ADMIN_AUTHOR_EMAILS: readonly string[] = [
  'avery.personal@gmail.com',
  'avery@example.edu',
  '1000001+example-org@users.noreply.github.com',
];

/**
 * Git author identities allowed to change protected governance files.
 * Setting ADMIN_AUTHOR_EMAILS replaces the placeholder list; it does not
 * add to it. With a real program repo the setting is required and must not
 * name a placeholder: identity-settings-check.ts stops the host at startup.
 */
export const ADMIN_AUTHOR_EMAILS: readonly string[] = emailListSetting(
  'ADMIN_AUTHOR_EMAILS',
  [...PLACEHOLDER_ADMIN_AUTHOR_EMAILS],
);

/** False when ADMIN_AUTHOR_EMAILS fell back to the placeholder list. */
export const ADMIN_AUTHOR_EMAILS_IS_SET = raw('ADMIN_AUTHOR_EMAILS') !== '';
