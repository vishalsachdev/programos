import { ADMIN_AUTHOR_EMAILS } from './instance-identity.js';

export type ProtectedGovernanceRule = 'G11' | 'G39';

const ADMIN_AUTHORS = new Set(ADMIN_AUTHOR_EMAILS);

// Must stay in sync with PROTECTED_FILES in
// container/agent-runner/src/protected-write-guard.ts (container deny hook) —
// setup/protected-write-guard.test.ts asserts the two lists agree.
export const PROTECTED_PATH_RULES = new Map<string, ProtectedGovernanceRule>([
  ['program/curriculum.md', 'G11'],
  ['program/email_allowlist.md', 'G39'],
  ['program/roles.md', 'G39'],
]);

export function isAdminAuthorEmail(email: string | undefined): boolean {
  return Boolean(email && ADMIN_AUTHORS.has(email.toLowerCase()));
}

export function protectedGovernanceRule(
  relPath: string,
): ProtectedGovernanceRule | null {
  return (
    PROTECTED_PATH_RULES.get(relPath.replaceAll('\\', '/').toLowerCase()) ??
    null
  );
}
