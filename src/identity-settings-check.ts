import {
  ADMIN_AUTHOR_EMAILS,
  ADMIN_AUTHOR_EMAILS_IS_SET,
  INSTITUTION_DOMAIN,
  INSTITUTION_DOMAIN_IS_SET,
  PLACEHOLDER_ADMIN_AUTHOR_EMAILS,
  PLACEHOLDER_INSTITUTION_DOMAIN,
} from './instance-identity.js';
import { realProgramRepoReason } from './repo-reader.js';

const WHERE =
  'Set it in the `.env` file in the repo root (or in the process ' +
  'environment). See config/instance.env.example.';

const ADMIN_VALUE =
  "Set ADMIN_AUTHOR_EMAILS to the admin's real git author emails, " +
  'separated by commas.';

const DOMAIN_VALUE =
  "Set INSTITUTION_DOMAIN to the institution's real mail domain.";

/**
 * True when `value` is the placeholder institution domain or a subdomain of
 * it ("mail.example.edu"). The comparison is by whole labels, so a domain
 * that only contains the string ("myexample.edu", "example.edu.org") is not
 * one. Case, surrounding whitespace and one trailing dot are ignored here,
 * so the answer does not depend on how the caller normalised the value;
 * instance-identity.ts already trims and lower-cases the setting, and stops
 * the host on a trailing dot as a malformed domain.
 */
export function isPlaceholderInstitutionDomain(value: string): boolean {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  return (
    domain === PLACEHOLDER_INSTITUTION_DOMAIN ||
    domain.endsWith(`.${PLACEHOLDER_INSTITUTION_DOMAIN}`)
  );
}

/**
 * Startup check, called first in main(). With a real program repo two
 * identity settings must be the deployment's own:
 *
 *  - ADMIN_AUTHOR_EMAILS: the shipped placeholders belong to nobody, and a
 *    git author address is not verified, so a commit that carries one would
 *    pass the protected-file check (G11, G39).
 *  - INSTITUTION_DOMAIN: with the placeholder or a subdomain of it, no
 *    blocked colleague gets the courtesy reply (G17) and no route named in
 *    the allowlist resolves to an approver.
 *
 * ADMIN_AUTHOR_EMAILS entries are compared as whole addresses, so the
 * subdomain rule does not apply to them.
 *
 * Every problem found is named in one error. With the placeholder repo (a
 * fresh clone, the tests) this does nothing.
 */
export function assertIdentitySettingsConfigured(): void {
  const reason = realProgramRepoReason();
  if (!reason) return;

  const problems: string[] = [];
  if (!INSTITUTION_DOMAIN_IS_SET) {
    problems.push(`INSTITUTION_DOMAIN is not set. ${DOMAIN_VALUE}`);
  } else if (INSTITUTION_DOMAIN === PLACEHOLDER_INSTITUTION_DOMAIN) {
    problems.push(
      `INSTITUTION_DOMAIN is the placeholder domain ("${PLACEHOLDER_INSTITUTION_DOMAIN}"). ${DOMAIN_VALUE}`,
    );
  } else if (isPlaceholderInstitutionDomain(INSTITUTION_DOMAIN)) {
    problems.push(
      `INSTITUTION_DOMAIN ("${INSTITUTION_DOMAIN}") is a subdomain of the placeholder domain ("${PLACEHOLDER_INSTITUTION_DOMAIN}"). ${DOMAIN_VALUE}`,
    );
  }
  if (!ADMIN_AUTHOR_EMAILS_IS_SET) {
    problems.push(`ADMIN_AUTHOR_EMAILS is not set. ${ADMIN_VALUE}`);
  } else {
    const placeholders = ADMIN_AUTHOR_EMAILS.filter((email) =>
      PLACEHOLDER_ADMIN_AUTHOR_EMAILS.includes(email),
    );
    if (placeholders.length > 0) {
      problems.push(
        `ADMIN_AUTHOR_EMAILS contains a placeholder address ("${placeholders.join('", "')}"). Remove it. ${ADMIN_VALUE}`,
      );
    }
  }
  if (problems.length === 0) return;

  throw new Error(
    `A real program repo is configured (${reason}), and the host will not ` +
      `start with placeholder identity settings. ${problems.join(' ')} ${WHERE}`,
  );
}
