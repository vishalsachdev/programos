import { describe, expect, it } from 'vitest';

import {
  canProcessTelegramSender,
  loadTelegramAllowlistFrom,
  normalizeTelegramAllowlistFallbackMode,
  parseTelegramAllowlist,
  type TelegramAllowlistState,
} from './telegram-allowlist.js';

// Mirrors the real EMAIL_ALLOWLIST.md shape: an email table first, then the
// Telegram Handles section, then a Notes section. The parser must pick up only
// the handles — not the `@example.edu` fragments in the email table.
const FIXTURE = `# Program Knowledge Base — Email Allowlist

## Authorized Senders

| Name | Email | Title |
|------|-------|-------|
| Avery Morgan | avery@example.edu | Program Director |
| Sam Rivera | srivera@example.edu | Faculty |

## Telegram Handles

| Name | Telegram Username |
|------|------------------|
| Avery Morgan | @Avery_personal |
| Samuel Caleb Rivera | @SamRivera |

*Phone on file for Sam: 555-555-0142.*

## Notes

- To add or remove someone, edit this file.
`;

describe('parseTelegramAllowlist', () => {
  it('parses handles from the Telegram Handles section only', () => {
    expect([...parseTelegramAllowlist(FIXTURE)]).toEqual([
      'avery_personal',
      'samrivera',
    ]);
  });

  it('does not pick up email addresses from other sections', () => {
    const handles = parseTelegramAllowlist(FIXTURE);
    expect(handles.has('example')).toBe(false);
    expect(handles.has('avery')).toBe(false);
  });

  it('returns an empty set when there is no Telegram Handles section', () => {
    expect(parseTelegramAllowlist('# Only emails\n\nfoo@bar.com\n').size).toBe(
      0,
    );
  });
});

describe('loadTelegramAllowlistFrom', () => {
  it('parses handles from an injected read source', () => {
    const state = loadTelegramAllowlistFrom({
      readFile: (relPath) =>
        relPath === 'program/EMAIL_ALLOWLIST.md' ? FIXTURE : null,
    });
    expect(state.available).toBe(true);
    expect([...state.handles]).toEqual(['avery_personal', 'samrivera']);
    expect(state.source).toBe('program/EMAIL_ALLOWLIST.md');
  });

  it('returns unavailable when the source has no content (fail closed)', () => {
    const state = loadTelegramAllowlistFrom({ readFile: () => null });
    expect(state.available).toBe(false);
    expect(state.handles.size).toBe(0);
  });
});

describe('canProcessTelegramSender', () => {
  const loaded: TelegramAllowlistState = {
    available: true,
    handles: new Set(['avery_personal', 'samrivera']),
    source: '/repo/program/EMAIL_ALLOWLIST.md',
  };
  const unavailable: TelegramAllowlistState = {
    available: false,
    handles: new Set(),
    source: '/repo/program/EMAIL_ALLOWLIST.md',
  };

  it('allows an authorized handle (case-insensitive)', () => {
    expect(
      canProcessTelegramSender('Avery_personal', loaded, 'closed'),
    ).toEqual({
      allowed: true,
    });
    expect(canProcessTelegramSender('samrivera', loaded, 'closed')).toEqual({
      allowed: true,
    });
  });

  it('tolerates a leading @ on the incoming username', () => {
    expect(canProcessTelegramSender('@SamRivera', loaded, 'closed')).toEqual({
      allowed: true,
    });
  });

  it('drops a handle not on the list', () => {
    expect(canProcessTelegramSender('someone_else', loaded, 'closed')).toEqual({
      allowed: false,
      reason: 'sender not on allowlist',
    });
  });

  it('drops a sender with no username in closed mode', () => {
    expect(canProcessTelegramSender(undefined, loaded, 'closed')).toEqual({
      allowed: false,
      reason: 'sender not on allowlist',
    });
  });

  it('fails closed when the allowlist is unavailable', () => {
    expect(
      canProcessTelegramSender('Avery_personal', unavailable, 'closed'),
    ).toEqual({ allowed: false, reason: 'allowlist unavailable' });
  });

  it('allows permissive fallback only when explicitly enabled', () => {
    expect(
      canProcessTelegramSender('anyone', unavailable, 'permissive'),
    ).toEqual({ allowed: true });
  });
});

describe('normalizeTelegramAllowlistFallbackMode', () => {
  it('defaults to closed', () => {
    expect(normalizeTelegramAllowlistFallbackMode()).toBe('closed');
    expect(normalizeTelegramAllowlistFallbackMode('anything-else')).toBe(
      'closed',
    );
  });

  it('honors permissive when set', () => {
    expect(normalizeTelegramAllowlistFallbackMode('permissive')).toBe(
      'permissive',
    );
  });
});
