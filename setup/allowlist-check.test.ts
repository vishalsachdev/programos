import { describe, it, expect } from 'vitest';

import {
  addressesNotOnAllowlist,
  describeSendPrecheck,
  extractAllowlistAddresses,
} from '../container/agent-runner/src/allowlist-check.js';

// Mirrors the shape of program/EMAIL_ALLOWLIST.md: enforced table rows, plus
// prose that mentions a revoked address (which the host parser ignores).
const ALLOWLIST = `
| Name | Email | Title |
|------|-------|-------|
| Avery Morgan | avery@example.edu | Faculty |
| Sam Rivera | srivera@example.edu | Faculty |

## Retired access
Greta Nash (user106@example.edu) — revoked.
`;

describe('extractAllowlistAddresses', () => {
  it('collects addresses from table rows only, lower-cased, like the host parser', () => {
    const set = extractAllowlistAddresses(ALLOWLIST);
    expect(set.has('avery@example.edu')).toBe(true);
    expect(set.has('srivera@example.edu')).toBe(true);
    expect(set.has('user106@example.edu')).toBe(false);
  });
});

describe('addressesNotOnAllowlist', () => {
  it('returns the addresses missing from the table, in input order', () => {
    expect(
      addressesNotOnAllowlist(
        ['srivera@example.edu', 'morgan@example.edu'],
        ALLOWLIST,
      ),
    ).toEqual(['morgan@example.edu']);
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    expect(
      addressesNotOnAllowlist([' Avery@example.edu '], ALLOWLIST),
    ).toEqual([]);
  });

  it('treats an unreadable allowlist as unknown, not as absent', () => {
    expect(addressesNotOnAllowlist(['anyone@example.edu'], null)).toBeNull();
  });
});

describe('describeSendPrecheck', () => {
  it('is empty when every To and CC address is on the table', () => {
    expect(
      describeSendPrecheck({
        to: 'srivera@example.edu',
        cc: 'avery@example.edu',
        allowlistText: ALLOWLIST,
      }),
    ).toBe('');
  });

  it('a missing To address means the whole send is refused', () => {
    const text = describeSendPrecheck({
      to: 'srivera@example.edu, morgan@example.edu',
      allowlistText: ALLOWLIST,
    });
    expect(text).toContain('morgan@example.edu');
    expect(text).toMatch(/whole send|nobody/i);
    expect(text).toMatch(/srivera@example.edu/);
  });

  it('a missing CC address is dropped while the To recipients still get the email', () => {
    const text = describeSendPrecheck({
      to: 'srivera@example.edu',
      cc: 'morgan@example.edu',
      allowlistText: ALLOWLIST,
    });
    expect(text).toContain('morgan@example.edu');
    expect(text).toMatch(/NOT be sent|not sent/i);
    expect(text).not.toMatch(/whole send|nobody/i);
  });

  it('an unreadable allowlist yields an explicit unverified warning', () => {
    const text = describeSendPrecheck({
      to: 'srivera@example.edu',
      allowlistText: null,
    });
    expect(text).toMatch(/could not be read|unverified/i);
  });

  it('with one allowed CC and one rejected CC, names every surviving recipient', () => {
    const text = describeSendPrecheck({
      to: 'srivera@example.edu',
      cc: 'avery@example.edu, morgan@example.edu',
      allowlistText: ALLOWLIST,
    });
    expect(text).toContain('morgan@example.edu');
    expect(text).toMatch(/avery@example\.edu/);
    expect(text).not.toMatch(/only srivera@example\.edu receives/);
  });
});
