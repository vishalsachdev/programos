import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { emailProfile } from './delivery-gate.js';
import { TRUSTED_BODY_MAILBOXES } from './trusted-body-mailboxes.js';

const { describeSendPrecheck } = await import(
  new URL('../container/agent-runner/src/allowlist-check.ts', import.meta.url)
    .href
);

const context = {
  allowlist: {
    available: true,
    senders: new Set(['avery@example.edu']),
    source: 'test',
  },
  inboundText: [],
  sendFromEmail: 'program@example.org',
};
const lateRule =
  'Extensions and accommodations go to Program-Support@example.edu.';

// The approved late policy cites this mailbox; a reply citing it must not be refused.
it('host body gate passes a trusted program mailbox in any case', () => {
  expect(emailProfile.validate(`<reply>${lateRule}</reply>`, context).ok).toBe(
    true,
  );
});

// Catches the trusted list widening into a blanket pass for other addresses in the same body.
it('host body gate still refuses an unknown address next to a trusted mailbox', () => {
  expect(
    emailProfile.validate(
      `<reply>${lateRule} Or try help@example.edu.</reply>`,
      context,
    ),
  ).toMatchObject({
    ok: false,
    reason: 'unverified-email-address',
    addresses: ['help@example.edu.'],
  });
});

// Catches the container precheck warning Coordinator about an address the host now accepts.
it('container precheck does not warn about a trusted program mailbox', () => {
  expect(
    describeSendPrecheck({
      to: 'avery@example.edu',
      body: lateRule,
      allowlistText: '| Name | Email |\n| Avery | avery@example.edu |',
    }),
  ).toBe('');
});

// Catches a trusted mailbox becoming a recipient: it must stay body-only.
it('container precheck still refuses a trusted mailbox as a To recipient', () => {
  expect(
    describeSendPrecheck({
      to: 'program-support@example.edu',
      body: 'Hello',
      allowlistText: '| Name | Email |\n| Avery | avery@example.edu |',
    }),
  ).toContain('To recipient(s) not on program/EMAIL_ALLOWLIST.md');
});

// Catches the host and container copies drifting apart.
it('host and container lists are identical files', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  expect(read('../container/agent-runner/src/trusted-body-mailboxes.ts')).toBe(
    read('./trusted-body-mailboxes.ts'),
  );
  expect(TRUSTED_BODY_MAILBOXES.every((a) => a === a.toLowerCase())).toBe(true);
});

// Catches the list leaking into recipient or sender checks (body evidence only).
it('only the two body checks import the trusted list', () => {
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(p);
      } else if (
        p.endsWith('.ts') &&
        !p.endsWith('.test.ts') &&
        !p.endsWith('trusted-body-mailboxes.ts') &&
        readFileSync(p, 'utf8').includes('trusted-body-mailboxes')
      ) {
        importers.push(p);
      }
    }
  };
  walk('src');
  walk('container/agent-runner/src');
  expect(importers.sort()).toEqual([
    'container/agent-runner/src/allowlist-check.ts',
    'src/delivery-gate.ts',
  ]);
});
