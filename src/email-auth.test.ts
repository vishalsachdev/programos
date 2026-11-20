import { describe, expect, it } from 'vitest';

import {
  emailAuthBlocks,
  emailAuthVerdict,
  readEmailAuthSettings,
} from './email-auth.js';

const PLATFORM = 'mx.platform.example';
const CAMPUS = 'mx.campus.example.edu';
const trusted = new Set([PLATFORM, CAMPUS]);

function result(over: Record<string, unknown>) {
  return {
    source: 'platform',
    authserv_id: PLATFORM,
    spf: '',
    spf_domain: '',
    dkim: [],
    dmarc: '',
    dmarc_from: '',
    arc: '',
    ...over,
  };
}
function record(results: unknown[], over: Record<string, unknown> = {}) {
  return {
    version: 1,
    envelope_from_domain: 'mail.example.edu',
    from_headers: 1,
    from_mailboxes: 1,
    from_display_commas: false,
    platform_status: results.length > 0 ? 'read' : 'absent',
    results,
    ...over,
  };
}
const verdict = (auth: unknown, from = 'dlee@example.edu', t = trusted) =>
  emailAuthVerdict(from, auth, t).verdict;

describe('emailAuthVerdict', () => {
  it('is "unknown" when the host trusts no server, whatever the payload says', () => {
    expect(
      emailAuthVerdict(
        'dlee@example.edu',
        record([result({ dmarc: 'pass', dmarc_from: 'example.edu' })]),
        new Set(),
      ),
    ).toEqual({ verdict: 'unknown', reason: 'no trusted mail server is set' });
  });

  it('is "unknown" only when nobody was asked or the platform wrote nothing', () => {
    // An intake that sends no record.
    expect(verdict(undefined)).toBe('unknown');
    expect(verdict(null)).toBe('unknown');
    // The worker has no platform set; the platform wrote no header.
    expect(verdict(record([], { platform_status: 'unset' }))).toBe('unknown');
    expect(verdict(record([], { platform_status: 'absent' }))).toBe('unknown');
    // Only servers the host was not told to believe (names from the
    // worker's settings, not from the message).
    expect(
      verdict(
        record([result({ authserv_id: 'mx.other.example', dmarc: 'pass' })]),
      ),
    ).toBe('unknown');
  });

  it('is "unauthenticated", not "unknown", when a header with the platform name was there and was not read', () => {
    const decision = emailAuthVerdict(
      'dlee@example.edu',
      record([], { platform_status: 'rejected' }),
      trusted,
    );
    expect(decision.verdict).toBe('unauthenticated');
    expect(decision.reason).toMatch(/could not be relied on/);
  });

  it('is "unauthenticated" on a record it cannot interpret', () => {
    expect(verdict('pass')).toBe('unauthenticated');
    expect(verdict([])).toBe('unauthenticated');
    // A version this code does not know.
    expect(
      verdict(
        record([result({ dmarc: 'pass', dmarc_from: 'example.edu' })], {
          version: 2,
        }),
      ),
    ).toBe('unauthenticated');
    expect(verdict(record([], { results: 'none' }))).toBe('unauthenticated');
    expect(verdict(record([], { platform_status: 'maybe' }))).toBe(
      'unauthenticated',
    );
    // A status and a result list that contradict each other.
    const pass = [result({ dmarc: 'pass', dmarc_from: 'example.edu' })];
    expect(verdict(record(pass, { platform_status: 'absent' }))).toBe(
      'unauthenticated',
    );
    expect(verdict(record(pass, { platform_status: 'unset' }))).toBe(
      'unauthenticated',
    );
    expect(verdict(record([], { platform_status: 'read' }))).toBe(
      'unauthenticated',
    );
    expect(verdict(record([null], { platform_status: 'read' }))).toBe(
      'unauthenticated',
    );
  });

  it('a worker from before platform_status: an empty result list is "unauthenticated"', () => {
    // That worker sent an empty list both when the platform wrote nothing
    // and when its header was unusable.
    const old = (results: unknown[]) => ({
      version: 1,
      envelope_from_domain: 'mail.example.edu',
      from_headers: 1,
      from_mailboxes: 1,
      results,
    });
    const decision = emailAuthVerdict('dlee@example.edu', old([]), trusted);
    expect(decision.verdict).toBe('unauthenticated');
    expect(decision.reason).toMatch(/inbound\/ worker/);
    // Its results are still read.
    expect(
      verdict(old([result({ dmarc: 'pass', dmarc_from: 'example.edu' })])),
    ).toBe('authenticated');
  });

  it('is "authenticated" on a DMARC pass from the platform that names the From domain', () => {
    expect(
      emailAuthVerdict(
        'dlee@example.edu',
        record([result({ dmarc: 'pass', dmarc_from: 'example.edu' })]),
        trusted,
      ),
    ).toEqual({
      verdict: 'authenticated',
      reason: `DMARC pass for example.edu (${PLATFORM})`,
    });
  });

  it('a pass that names no From domain does not authenticate unless the deployer allows it for the platform', () => {
    const bare = record([result({ dmarc: 'pass' })]);
    const strict = emailAuthVerdict('dlee@example.edu', bare, trusted);
    expect(strict.verdict).toBe('unauthenticated');
    expect(strict.reason).toMatch(/names no From domain/);
    expect(
      emailAuthVerdict('dlee@example.edu', bare, trusted, {
        requireFromDomain: false,
      }).verdict,
    ).toBe('authenticated');
    // Never for a forwarder, whatever the setting.
    expect(
      emailAuthVerdict(
        'dlee@example.edu',
        record([
          result({ dmarc: 'fail' }),
          result({ source: 'forwarder', authserv_id: CAMPUS, dmarc: 'pass' }),
        ]),
        trusted,
        { requireFromDomain: false },
      ).verdict,
    ).toBe('unauthenticated');
    // A domain the worker could not read is not "no domain".
    expect(
      emailAuthVerdict(
        'dlee@example.edu',
        record([result({ dmarc: 'pass', dmarc_from: 'invalid' })]),
        trusted,
        { requireFromDomain: false },
      ).verdict,
    ).toBe('unauthenticated');
  });

  it('a From header with commas in the display name counts only with a pass that names the From domain', () => {
    const commas = { from_mailboxes: 2, from_display_commas: true };
    expect(
      verdict(
        record([result({ dmarc: 'pass', dmarc_from: 'example.edu' })], commas),
      ),
    ).toBe('authenticated');
    // No named domain: not even where the deployer accepts that otherwise.
    expect(
      emailAuthVerdict(
        'dlee@example.edu',
        record([result({ dmarc: 'pass' })], commas),
        trusted,
        { requireFromDomain: false },
      ).verdict,
    ).toBe('unauthenticated');
    // The flag does not excuse any other count, or a second From header.
    const pass = [result({ dmarc: 'pass', dmarc_from: 'example.edu' })];
    expect(
      verdict(record(pass, { from_mailboxes: 3, from_display_commas: true })),
    ).toBe('unauthenticated');
    expect(verdict(record(pass, { ...commas, from_headers: 2 }))).toBe(
      'unauthenticated',
    );
    expect(
      verdict(record(pass, { from_mailboxes: 2, from_display_commas: 'yes' })),
    ).toBe('unauthenticated');
  });

  it('uses DMARC only: an aligned DKIM or SPF pass alone does not authenticate', () => {
    expect(
      verdict(
        record([
          result({
            spf: 'pass',
            spf_domain: 'example.edu',
            dkim: [{ result: 'pass', domain: 'example.edu' }],
            dmarc: 'none',
          }),
        ]),
      ),
    ).toBe('unauthenticated');
    expect(
      verdict(
        record([result({ dkim: [{ result: 'pass', domain: 'example.edu' }] })]),
      ),
    ).toBe('unauthenticated');
  });

  it('is "unauthenticated" on a pass that does not cover the From domain', () => {
    // DMARC was checked for another From domain, for a parent or a child
    // of it, or for a domain the worker could not read.
    for (const dmarc_from of [
      'attacker.example.net',
      'edu',
      'dept.example.edu',
      'invalid',
    ]) {
      expect(verdict(record([result({ dmarc: 'pass', dmarc_from })]))).toBe(
        'unauthenticated',
      );
    }
    expect(
      verdict(
        record([result({ dmarc: 'pass', dmarc_from: 'example.edu' })]),
        'dlee@dept.example.edu',
      ),
    ).toBe('unauthenticated');
    expect(verdict(record([result({ spf: 'fail', dmarc: 'fail' })]))).toBe(
      'unauthenticated',
    );
    expect(verdict(record([result({ spf: 'none', dmarc: 'none' })]))).toBe(
      'unauthenticated',
    );
  });

  it('a forwarder must name the From domain it checked DMARC for', () => {
    const forwarder = (over: Record<string, unknown>) =>
      result({ source: 'forwarder', authserv_id: CAMPUS, ...over });
    expect(verdict(record([forwarder({ dmarc: 'pass' })]))).toBe(
      'unauthenticated',
    );
    expect(
      verdict(
        record([forwarder({ dmarc: 'pass', dmarc_from: 'example.edu' })]),
      ),
    ).toBe('authenticated');
  });

  it('forwarded mail: SPF and DMARC fail at the platform, the forwarder recorded a pass', () => {
    const auth = record([
      result({
        spf: 'fail',
        spf_domain: 'example.edu',
        dkim: [{ result: 'pass', domain: 'campus.example.edu' }],
        dmarc: 'fail',
      }),
      result({
        source: 'forwarder',
        authserv_id: CAMPUS,
        spf: 'pass',
        spf_domain: 'example.edu',
        dmarc: 'pass',
        dmarc_from: 'example.edu',
      }),
    ]);
    expect(emailAuthVerdict('dlee@example.edu', auth, trusted)).toEqual({
      verdict: 'authenticated',
      reason: `DMARC pass for example.edu (${CAMPUS})`,
    });
    // A host that trusts only the platform does not count the forwarder.
    expect(verdict(auth, 'dlee@example.edu', new Set([PLATFORM]))).toBe(
      'unauthenticated',
    );
  });

  it('is never "authenticated" when the message has two From headers or two addresses in From', () => {
    const pass = [result({ dmarc: 'pass' })];
    expect(verdict(record(pass, { from_headers: 2 }))).toBe('unauthenticated');
    expect(verdict(record(pass, { from_mailboxes: 2 }))).toBe(
      'unauthenticated',
    );
    expect(verdict(record(pass, { from_headers: undefined }))).toBe(
      'unauthenticated',
    );
    expect(verdict(record(pass), 'not-an-address')).toBe('unauthenticated');
  });
});

describe('settings', () => {
  it('defaults to flag with no trusted server', () => {
    const s = readEmailAuthSettings({});
    expect(s.mode).toBe('flag');
    expect([...s.trusted]).toEqual([]);
    expect(s.unknown).toBe('block');
    expect(s.requireFromDomain).toBe(true);
  });

  it('EMAIL_AUTH_REQUIRE_FROM_DOMAIN takes the usual on and off words and nothing else', () => {
    for (const on of ['true', 'TRUE', '1', 'on', ' true '])
      expect(
        readEmailAuthSettings({ EMAIL_AUTH_REQUIRE_FROM_DOMAIN: on })
          .requireFromDomain,
      ).toBe(true);
    for (const off of ['false', '0', 'Off'])
      expect(
        readEmailAuthSettings({ EMAIL_AUTH_REQUIRE_FROM_DOMAIN: off })
          .requireFromDomain,
      ).toBe(false);
    expect(() =>
      readEmailAuthSettings({ EMAIL_AUTH_REQUIRE_FROM_DOMAIN: 'no thanks' }),
    ).toThrow(/EMAIL_AUTH_REQUIRE_FROM_DOMAIN/);
  });

  it('flag never blocks', () => {
    const s = readEmailAuthSettings({
      EMAIL_AUTH_TRUSTED_AUTHSERV_IDS: PLATFORM,
    });
    for (const v of ['authenticated', 'unauthenticated', 'unknown'] as const)
      expect(emailAuthBlocks(s, v)).toBe(false);
  });

  it('enforce refuses to start with no trusted server', () => {
    expect(() => readEmailAuthSettings({ EMAIL_AUTH_MODE: 'enforce' })).toThrow(
      /needs EMAIL_AUTH_TRUSTED_AUTHSERV_IDS/,
    );
    expect(() =>
      readEmailAuthSettings({
        EMAIL_AUTH_MODE: 'enforce',
        EMAIL_AUTH_UNKNOWN: 'allow',
        EMAIL_AUTH_TRUSTED_AUTHSERV_IDS: ' , ',
      }),
    ).toThrow(/needs EMAIL_AUTH_TRUSTED_AUTHSERV_IDS/);
  });

  it('refuses a value it does not know', () => {
    expect(() => readEmailAuthSettings({ EMAIL_AUTH_MODE: 'reject' })).toThrow(
      /"flag" or "enforce"/,
    );
    expect(() =>
      readEmailAuthSettings({ EMAIL_AUTH_UNKNOWN: 'maybe' }),
    ).toThrow(/"block" or "allow"/);
    expect(() =>
      readEmailAuthSettings({ EMAIL_AUTH_TRUSTED_AUTHSERV_IDS: 'not a host' }),
    ).toThrow(/host names/);
  });

  it('enforce blocks "unauthenticated" always and "unknown" by the sub-choice', () => {
    const base = {
      EMAIL_AUTH_MODE: 'Enforce',
      EMAIL_AUTH_TRUSTED_AUTHSERV_IDS: `MX.Platform.Example, ${CAMPUS}`,
    };
    const block = readEmailAuthSettings(base);
    expect([...block.trusted]).toEqual([PLATFORM, CAMPUS]);
    expect(emailAuthBlocks(block, 'authenticated')).toBe(false);
    expect(emailAuthBlocks(block, 'unauthenticated')).toBe(true);
    expect(emailAuthBlocks(block, 'unknown')).toBe(true);
    const allow = readEmailAuthSettings({
      ...base,
      EMAIL_AUTH_UNKNOWN: 'allow',
    });
    expect(emailAuthBlocks(allow, 'unauthenticated')).toBe(true);
    expect(emailAuthBlocks(allow, 'unknown')).toBe(false);
  });
});
