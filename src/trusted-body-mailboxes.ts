/**
 * G59: shared program mailboxes Coordinator may cite in an
 * email body, e.g. the late policy's extensions contact.
 * Body evidence only: never a recipient and never an authorized
 * sender; those still come only from program/EMAIL_ALLOWLIST.md.
 *
 * Admin-only list (Avery). A change here updates the G59 row in
 * program-repo program/kb-governance.md. Host and container keep identical
 * copies (src/ and container/agent-runner/src/); a test fails on drift.
 */
export const TRUSTED_BODY_MAILBOXES: readonly string[] = [
  'program-support@example.edu',
];
