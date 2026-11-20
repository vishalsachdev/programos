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

  it('is "unknown" with no auth field, an empty one, or only servers the host does not trust', () => {
    expect(verdict(undefined)).toBe('unknown');
    expect(verdict('pass')).toBe('unknown');
    expect(verdict(record([]))).toBe('unknown');
    expect(
      verdict(
        record([result({ authserv_id: 'mx.other.example', dmarc: 'pass' })]),
      ),
    ).toBe('unknown');
    // A record of a version this code does not know is not interpreted.
    expect(verdict(record([result({ dmarc: 'pass' })], { version: 2 }))).toBe(
      'unknown',
    );
  });

  it('is "authenticated" on a DMARC pass from the platform', () => {
    expect(verdict(record([result({ dmarc: 'pass' })]))).toBe('authenticated');
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
