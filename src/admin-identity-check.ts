import {
  ADMIN_AUTHOR_EMAILS,
  ADMIN_AUTHOR_EMAILS_IS_SET,
  PLACEHOLDER_ADMIN_AUTHOR_EMAILS,
} from './instance-identity.js';
import { realProgramRepoReason } from './repo-reader.js';

const WHERE =
  'Set ADMIN_AUTHOR_EMAILS in the `.env` file in the repo root (or in the ' +
  "process environment) to the admin's real git author emails, separated " +
  'by commas. See config/instance.env.example.';

/**
 * Startup check, called first in main(). With a real program repo the admin
 * identities must be the deployment's own: the shipped placeholders belong
 * to nobody, and a git author address is not verified, so a commit that
 * carries one would pass the protected-file check (G11, G39).
 *
 * With the placeholder repo (a fresh clone, the tests) this does nothing.
 */
export function assertAdminIdentitiesConfigured(): void {
  const reason = realProgramRepoReason();
  if (!reason) return;
  if (!ADMIN_AUTHOR_EMAILS_IS_SET) {
    throw new Error(
      `ADMIN_AUTHOR_EMAILS is not set, and a real program repo is configured (${reason}). ` +
        'The host will not start with the placeholder admin identities. ' +
        WHERE,
    );
  }
  const placeholders = ADMIN_AUTHOR_EMAILS.filter((email) =>
    PLACEHOLDER_ADMIN_AUTHOR_EMAILS.includes(email),
  );
  if (placeholders.length > 0) {
    throw new Error(
      `ADMIN_AUTHOR_EMAILS contains a placeholder address ("${placeholders.join('", "')}"), ` +
        `and a real program repo is configured (${reason}). Remove it. ` +
        WHERE,
    );
  }
}
