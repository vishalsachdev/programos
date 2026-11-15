import { describe, expect, it } from 'vitest';

import {
  canProcessEmailSender,
  loadEmailAllowlistFrom,
  normalizeEmailAllowlistFallbackMode,
  parseAgentPrincipals,
  parseEmailAllowlist,
} from './webhook-allowlist.js';

describe('webhook email allowlist helpers', () => {
  it('parses email addresses from the markdown table', () => {
    const senders = parseEmailAllowlist(`
| Name | Email | Role |
| --- | --- | --- |
| Alice | alice@example.com | Faculty |
| Bob | bob@example.org | Staff |
`);

    expect([...senders]).toEqual(['alice@example.com', 'bob@example.org']);
  });

  it('fails closed when the allowlist is unavailable', () => {
    expect(
      canProcessEmailSender(
        'alice@example.com',
        {
          available: false,
          senders: new Set(),
          source: '/tmp/EMAIL_ALLOWLIST.md',
        },
        'closed',
      ),
    ).toEqual({ allowed: false, reason: 'allowlist unavailable' });
  });

  it('allows permissive fallback only when explicitly enabled', () => {
    expect(
      canProcessEmailSender(
        'alice@example.com',
        {
          available: false,
          senders: new Set(),
          source: '/tmp/EMAIL_ALLOWLIST.md',
        },
        'permissive',
      ),
    ).toEqual({ allowed: true });
  });

  it('rejects a senderless message even under permissive fallback', () => {
    // Permissive mode waives the allowlist check when the list is
    // unavailable — it must not waive having a sender at all. (The
    // old webhook-level !from guard was removed as dead code; this is
    // the case where it wasn't.)
    expect(
      canProcessEmailSender(
        undefined,
        {
          available: false,
          senders: new Set(),
          source: '/tmp/EMAIL_ALLOWLIST.md',
        },
        'permissive',
      ),
    ).toEqual({ allowed: false, reason: 'missing sender' });
  });

  it('rejects senders not present in the loaded allowlist', () => {
    expect(
      canProcessEmailSender(
        'bob@example.com',
        {
          available: true,
          senders: new Set(['alice@example.com']),
          source: '/tmp/EMAIL_ALLOWLIST.md',
        },
        'closed',
      ),
    ).toEqual({ allowed: false, reason: 'sender not on allowlist' });
  });

  it('normalizes fallback mode to closed by default', () => {
    expect(normalizeEmailAllowlistFallbackMode()).toBe('closed');
    expect(normalizeEmailAllowlistFallbackMode('permissive')).toBe(
      'permissive',
    );
    expect(normalizeEmailAllowlistFallbackMode('anything-else')).toBe('closed');
  });
});

describe('loadEmailAllowlistFrom', () => {
  it('parses the allowlist from an injected read source', () => {
    const state = loadEmailAllowlistFrom({
      readFile: (relPath) =>
        relPath === 'program/EMAIL_ALLOWLIST.md'
          ? '| Alice | alice@example.com |\n| Bob | bob@example.org |\n'
          : null,
    });
    expect(state.available).toBe(true);
    expect([...state.senders]).toEqual([
      'alice@example.com',
      'bob@example.org',
    ]);
    expect(state.source).toBe('program/EMAIL_ALLOWLIST.md');
  });

  it('returns unavailable when the source has no content (fail closed)', () => {
    const state = loadEmailAllowlistFrom({ readFile: () => null });
    expect(state.available).toBe(false);
    expect(state.senders.size).toBe(0);
  });
});

describe('parseAgentPrincipals (G19 sender tiers)', () => {
  // Rows in the program/EMAIL_ALLOWLIST.md format.
  const rows = [
    '| Avery Morgan (PeerAgent Agent) | averybot@gmail.com | **agent** (owner: Avery) | read-write | G52 agent principal. Authority scope: compose/propose only · **coordinator-cohort: agent** |',
    '| Walter Oakes | user112@example.edu | Faculty | read-only | Research observer · **coordinator-cohort: observer** |',
  ].join('\n');

  it('marks the PeerAgent agent row and no person row', () => {
    expect([...parseAgentPrincipals(rows)]).toEqual(['averybot@gmail.com']);
  });

  it('treats any one agent signal as enough', () => {
    expect([
      ...parseAgentPrincipals(
        '| Bot | bot@example.com | Staff | read-write | coordinator-cohort: agent |',
      ),
    ]).toEqual(['bot@example.com']);
  });

  it('loads agent principals with the allowlist', () => {
    const state = loadEmailAllowlistFrom({ readFile: () => rows });
    expect(state.senders.has('user112@example.edu')).toBe(true);
    expect([...(state.agentSenders ?? [])]).toEqual(['averybot@gmail.com']);
  });

  it('leaves agent principals undefined when the allowlist is unavailable', () => {
    expect(
      loadEmailAllowlistFrom({ readFile: () => null }).agentSenders,
    ).toBeUndefined();
  });
});
