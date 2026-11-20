import { describe, expect, it } from 'vitest';

import { parseAuthenticationResults, type AuthTrust } from '../src/auth.js';
import {
  buildIntake,
  fromAddressCount,
  fromMailboxCount,
  fromMailboxes,
} from '../src/mail.js';
import { authTrust } from '../src/settings.js';
import { MemoryKV, testEnv } from './helpers.js';

// Synthetic messages only. `mx.platform.example` stands for the mail
// platform that runs the worker, `mx.campus.example.edu` for a mailbox
// system that forwards to the bot's address.
const PLATFORM = 'mx.platform.example';
const CAMPUS = 'mx.campus.example.edu';
const trust: AuthTrust = {
  platformAuthservId: PLATFORM,
  forwarderAuthservIds: [CAMPUS],
  forwarderDomains: ['campus.example.edu'],
};
const receivedAt = new Date('2026-11-20T15:00:00.000Z');
const AR = 'Authentication-Results: ';

interface Options {
  envelopeFrom?: string;
  trust?: AuthTrust;
  from?: string;
  /** What the platform's API reports; default: the first header given. */
  platformHeader?: string | null;
}

/**
 * `top` is the start of the raw message, first line first. By default the
 * platform's API reports the first header, as it does when the platform
 * really prepended it.
 */
async function auth(top: string[], options: Options = {}) {
  const raw = new TextEncoder().encode(
    [
      ...top,
      options.from ?? 'From: Dana Lee <dlee@example.edu>',
      'To: program@example.org',
      'Subject: Status update',
      'Message-ID: <auth-test@example.edu>',
      '',
      'The budget is approved.',
    ].join('\r\n'),
  );
  // The first header with its continuation lines, as one value.
  let first: string | null = null;
  if (top[0]?.startsWith(AR)) {
    first = top[0].slice(AR.length);
    for (const line of top.slice(1)) {
      if (!/^[ \t]/.test(line)) break;
      first += line;
    }
  }
  return buildIntake(
    raw,
    {
      from: options.envelopeFrom ?? 'bounce@mail.example.edu',
      to: 'program@example.org',
      authenticationResults:
        options.platformHeader === undefined ? first : options.platformHeader,
    },
    receivedAt,
    'discussions/raw',
    options.trust ?? trust,
  );
}

describe('which headers are read', () => {
  it('reads nothing when no trusted source is set (the default)', async () => {
    const { payload, markdown } = await auth(
      [`${AR}${PLATFORM}; spf=pass; dkim=pass; dmarc=pass`],
      {
        trust: {
          platformAuthservId: '',
          forwarderAuthservIds: [],
          forwarderDomains: [],
        },
      },
    );
    expect(payload.auth.results).toEqual([]);
    expect(markdown).toContain('X-Intake-Authentication: no trusted result');
  });

  it('reads the first header when it carries the platform name', async () => {
    const { payload, markdown } = await auth([
      `${AR}${PLATFORM}; spf=pass smtp.mailfrom=bounce@mail.example.edu;`,
      ' dkim=pass (2048-bit key; "quoted; text") header.d=example.edu header.s=s1;',
      ' dkim=fail header.d=list.example.net; dmarc=pass (p=reject) header.from=example.edu; arc=none',
      'Received: from mail.example.edu by mx.platform.example; Fri, 20 Nov 2026 15:00:00 +0000',
    ]);
    expect(payload.auth).toEqual({
      version: 1,
      envelope_from_domain: 'mail.example.edu',
      from_headers: 1,
      from_mailboxes: 1,
      from_display_commas: false,
      platform_status: 'read',
      results: [
        {
          source: 'platform',
          authserv_id: PLATFORM,
          spf: 'pass',
          spf_domain: 'mail.example.edu',
          dkim: [
            { result: 'pass', domain: 'example.edu' },
            { result: 'fail', domain: 'list.example.net' },
          ],
          dmarc: 'pass',
          dmarc_from: 'example.edu',
          arc: 'none',
        },
      ],
    });
    expect(markdown).toContain(
      `X-Intake-Authentication: platform ${PLATFORM}: spf=pass (mail.example.edu) dkim=pass (example.edu) dkim=fail (list.example.net) dmarc=pass (example.edu) arc=none`,
    );
  });

  it('reads the bare form the platform documents', async () => {
    const { payload } = await auth([
      `${AR}${PLATFORM}; spf=pass; dkim=pass; dmarc=pass`,
    ]);
    expect(payload.auth.results[0]).toMatchObject({
      spf: 'pass',
      spf_domain: 'mail.example.edu',
      dkim: [{ result: 'pass', domain: '' }],
      dmarc: 'pass',
      dmarc_from: '',
    });
  });

  it('ignores a planted header with the platform name that is not the first one', async () => {
    const { payload, markdown } = await auth([
      `${AR}other.example; spf=fail`,
      `${AR}${PLATFORM}; spf=pass; dkim=pass header.d=example.edu; dmarc=pass`,
    ]);
    expect(payload.auth.results).toEqual([]);
    expect(markdown).not.toContain('dmarc=pass');
  });

  it('ignores a planted first header when the platform put none in the raw message', async () => {
    const planted = `${PLATFORM}; spf=pass; dmarc=pass header.from=example.edu`;
    // The platform's API reports no such header at all.
    const none = await auth([`${AR}${planted}`], { platformHeader: null });
    expect(none.payload.auth.results).toEqual([]);
    // The platform's API reports its real header, which is not in the raw
    // bytes; the first raw header is the sender's.
    const other = await auth([`${AR}${planted}`], {
      platformHeader: `${PLATFORM}; spf=fail; dmarc=fail, ${planted}`,
    });
    expect(other.payload.auth.results).toEqual([]);
  });

  it('reads nothing when two headers carry the platform name', async () => {
    const { payload } = await auth([
      `${AR}${PLATFORM}; spf=fail; dkim=none; dmarc=fail`,
      `${AR}${PLATFORM}; spf=pass; dkim=pass header.d=example.edu; dmarc=pass header.from=example.edu`,
    ]);
    expect(payload.auth.results).toEqual([]);
  });

  it('drops a header that a continuation line of the sender extended', async () => {
    // The sender's first line starts with a space, so it becomes part of
    // the platform's header above it.
    const added = await auth([
      `${AR}${PLATFORM}; dkim=none; spf=fail; dmarc=fail header.from=example.edu`,
      ' ; dkim=pass header.d=example.edu; dmarc=pass header.from=example.edu',
    ]);
    expect(added.payload.auth.results).toEqual([]);
    const spfOnly = await auth([
      `${AR}${PLATFORM}; spf=fail; dmarc=fail`,
      '\t; spf=pass smtp.mailfrom=example.edu',
    ]);
    expect(spfOnly.payload.auth.results).toEqual([]);
    // With no DMARC result from the platform, an added one is the only
    // one: the header still does not authenticate by a DKIM line alone.
    const dkimOnly = await auth([
      `${AR}${PLATFORM}; spf=fail`,
      ' ; dkim=pass header.d=example.edu',
    ]);
    expect(dkimOnly.payload.auth.results).toEqual([]);
  });

  it('drops a header whose comment the sender closed early', async () => {
    // A server that copies the envelope sender into a comment.
    const envelope =
      '"x) ; dmarc=pass header.from=example.edu ; foo=bar ("@attacker.example.net';
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass (domain of ${envelope} designates 192.0.2.1 as permitted sender) smtp.mailfrom=attacker.example.net; dmarc=fail header.from=example.edu`,
      ],
      { envelopeFrom: envelope },
    );
    expect(payload.auth.results).toEqual([]);
  });

  it('drops a header whose comment is still open at its end', async () => {
    // Input class: sender text in a comment opens more comments than the
    // server closes, so the server's own dmarc=fail is inside a comment.
    const envelope =
      '"x) ; dmarc=pass header.from=example.edu (y (z"@attacker.example.net';
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass (domain of ${envelope} designates 192.0.2.1 as permitted sender) smtp.mailfrom=attacker.example.net; dmarc=fail header.from=example.edu`,
      ],
      { envelopeFrom: envelope },
    );
    expect(payload.auth.results).toEqual([]);
    expect(
      parseAuthenticationResults(`${PLATFORM}; dmarc=pass (p=none`),
    ).toBeNull();
  });

  it('drops a header in which one result carries a property twice', async () => {
    // Input class: sender text closes a comment, adds a property and opens
    // the comment again; parentheses pair and each method appears once.
    const envelope =
      '"x) smtp.mailfrom=campus.example.edu (y"@attacker.example.net';
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass (domain of ${envelope} designates 192.0.2.1 as permitted sender) smtp.mailfrom=attacker.example.net; dmarc=fail header.from=example.edu`,
        // Written by the sender: must not be read as the forwarder's.
        `${AR}${CAMPUS}; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: envelope },
    );
    expect(payload.auth.results).toEqual([]);
    expect(
      parseAuthenticationResults(
        `${PLATFORM}; dmarc=pass header.from=example.edu header.from=attacker.example.net`,
      ),
    ).toBeNull();
    // The same property name in two results is how a server writes it.
    expect(
      parseAuthenticationResults(
        `${PLATFORM}; dkim=pass header.d=example.edu; dkim=fail header.d=example.org; dmarc=pass`,
      )?.methods,
    ).toHaveLength(3);
  });

  it('does not read a forwarder header below one that cannot be relied on', async () => {
    // Input class: the forwarder's own header is made unusable (unclosed
    // quote, open comment), and a planted one with its name sits below it.
    for (const broken of [
      `${CAMPUS}; spf=fail smtp.mailfrom="a; dmarc=fail header.from=example.edu`,
      `${CAMPUS}; spf=fail (sender said (x) smtp.mailfrom=example.edu; dmarc=fail header.from=example.edu`,
    ]) {
      const { payload } = await auth(
        [
          `${AR}${PLATFORM}; spf=pass; dkim=fail; dmarc=fail`,
          `${AR}${broken}`,
          `${AR}${CAMPUS}; dmarc=pass header.from=example.edu`,
        ],
        { envelopeFrom: 'srs0=ab=cd=example.edu=dlee@campus.example.edu' },
      );
      expect(payload.auth.results.map((r) => r.source)).toEqual(['platform']);
    }
  });

  it('does not read a result out of a quoted string', async () => {
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass smtp.mailfrom="a; dmarc=pass header.from=example.edu"@attacker.example.net`,
        ' (sender said; dkim=pass header.d=example.edu); dmarc=fail header.from=example.edu',
      ],
      { envelopeFrom: 'x@attacker.example.net' },
    );
    expect(payload.auth.results).toHaveLength(1);
    expect(payload.auth.results[0]).toMatchObject({
      spf: 'pass',
      dkim: [],
      dmarc: 'fail',
      dmarc_from: 'example.edu',
    });
    // An unclosed quote: the header is not used at all.
    const broken = await auth([
      `${AR}${PLATFORM}; spf=pass smtp.mailfrom="a; dmarc=pass`,
    ]);
    expect(broken.payload.auth.results).toEqual([]);
  });

  it('marks a domain it cannot read as invalid, not as absent', async () => {
    // A null envelope sender: the platform's "smtp.mailfrom" is then no
    // host name either, and the two agree.
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass smtp.mailfrom=<>; dkim=pass header.d=localhost; dmarc=pass header.from=a_b.attacker.example.net`,
      ],
      { envelopeFrom: '' },
    );
    expect(payload.auth.results[0]).toMatchObject({
      spf_domain: 'invalid',
      dkim: [{ result: 'pass', domain: 'invalid' }],
      dmarc_from: 'invalid',
    });
  });

  it('does not take an SPF result for the HELO name as one for the envelope sender', async () => {
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass smtp.helo=mail.attacker.example.net; dmarc=fail`,
      ],
      { envelopeFrom: 'x@campus.example.edu' },
    );
    expect(payload.auth.results[0]).toMatchObject({
      spf: 'pass',
      spf_domain: '',
    });
  });

  it('ignores a planted forwarder header on mail sent straight to the bot', async () => {
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass; dkim=pass header.d=campus.example.edu; dmarc=fail`,
        `${AR}${CAMPUS}; spf=pass smtp.mailfrom=example.edu; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'anyone@attacker.example.net' },
    );
    // A DKIM signature of the forwarder domain is not proof either.
    expect(payload.auth.results.map((r) => r.source)).toEqual(['platform']);
  });

  it('forwarded mail: reads the forwarder header when SPF passed for the forwarder at the platform', async () => {
    // SPF passes for the forwarder's rewritten envelope sender; for the
    // original sender it does not, so DMARC fails at the bot's domain.
    const { payload, markdown } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass; dkim=fail; dmarc=fail`,
        'Received: from out.campus.example.edu by mx.platform.example; Fri, 20 Nov 2026 15:00:00 +0000',
        `${AR}${CAMPUS}; spf=pass smtp.mailfrom=dlee@example.edu; dkim=pass header.d=example.edu; dmarc=pass action=none header.from=example.edu`,
        // Written by the sender, below the forwarder's own: never read.
        `${AR}${CAMPUS}; dmarc=pass header.from=other.example.org`,
      ],
      { envelopeFrom: 'srs0=ab=cd=example.edu=dlee@campus.example.edu' },
    );
    expect(payload.auth.results).toHaveLength(2);
    expect(payload.auth.results[1]).toEqual({
      source: 'forwarder',
      authserv_id: CAMPUS,
      spf: 'pass',
      spf_domain: 'example.edu',
      dkim: [{ result: 'pass', domain: 'example.edu' }],
      dmarc: 'pass',
      dmarc_from: 'example.edu',
      arc: '',
    });
    expect(markdown).toContain(`forwarder ${CAMPUS}: spf=pass (example.edu)`);
  });

  it('does not treat a failed SPF for the forwarder domain as proof', async () => {
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=softfail; dmarc=fail`,
        `${AR}${CAMPUS}; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'x@campus.example.edu' },
    );
    expect(payload.auth.results).toHaveLength(1);
  });

  it('never reads a header that names no server', async () => {
    const value =
      'spf=pass smtp.mailfrom=example.edu; dmarc=pass header.from=example.edu';
    const { payload } = await auth([`${AR}${value}`]);
    expect(payload.auth.results).toEqual([]);
    expect(parseAuthenticationResults(value)).toBeNull();
  });
});

describe('the From header', () => {
  it('counts every From header, also one with a space before the colon', async () => {
    const two = await auth([
      `${AR}${PLATFORM}; dmarc=pass`,
      'From: a@attacker.example.net',
    ]);
    expect(two.payload.auth.from_headers).toBe(2);
    const spaced = await auth([
      `${AR}${PLATFORM}; dmarc=pass`,
      'From : a@attacker.example.net',
    ]);
    expect(spaced.payload.auth.from_headers).toBe(2);
  });

  it('counts the different addresses in the header text', () => {
    expect(fromAddressCount('Dana Lee <dlee@example.edu>')).toBe(1);
    // Some mail clients write the address as the display name too.
    expect(fromAddressCount('"DLee@example.edu" <dlee@example.edu>')).toBe(1);
    expect(fromAddressCount("'dlee@example.edu' <dlee@example.edu>")).toBe(1);
    expect(fromAddressCount('"dlee@example.edu" <other@example.org>')).toBe(2);
    expect(fromAddressCount('dlee@example.edu, other@example.org')).toBe(2);
    // A quoted local part the parser may skip.
    expect(
      fromAddressCount('"a"@attacker.example.net <dlee@example.edu>'),
    ).toBe(2);
    expect(fromAddressCount('dlee@example.edu, "a"@attacker.example.net')).toBe(
      2,
    );
    // The Kelvin sign lower-cases to "k".
    expect(fromAddressCount('dlee@Kent.example.edu')).toBe(2);
    expect(fromAddressCount('')).toBe(0);
  });

  it('never counts 1 for a header a reader could take as more than one mailbox', () => {
    // Input class: a second mailbox the address pattern does not see, or a
    // form in which readers disagree about where a mailbox ends.
    for (const header of [
      // A comment or a space next to "@".
      '<dlee@example.edu>, <a(x)@attacker.example.net>',
      'a(x)@attacker.example.net <dlee@example.edu>',
      '<dlee@example.edu> a @attacker.example.net',
      'a@ attacker.example.net <dlee@example.edu>',
      'dlee@example.edu@attacker.example.net',
      // More than one address in angle brackets; brackets that do not pair.
      '<dlee@example.edu> <dlee@example.edu>',
      '<dlee@example.edu> <>',
      'dlee@example.edu>',
      // A group, a route, a comma outside a quoted display name.
      'x:;, dlee@example.edu',
      'team: dlee@example.edu;',
      '<@attacker.example.net:dlee@example.edu>',
      'Lee, Dana <dlee@example.edu>',
      'dlee@example.edu,',
      // A quote or a comment left open, a backslash, a control character.
      '"Dana <dlee@example.edu>',
      'Dana (Lee <dlee@example.edu>',
      'Dana) <dlee@example.edu>',
      'Dana\\ <dlee@example.edu>',
      'dlee@example.edu\u0001',
      'dlee@example.edu\u0000',
      // A comment inside the brackets, or beside an address without them.
      '<dl(x)ee@example.edu>',
      'dl(x)ee@example.edu',
      'dlee@example.edu (Dana Lee)',
    ]) {
      expect(fromAddressCount(header), header).not.toBe(1);
    }
    // Still one mailbox: a quoted display name may hold these characters,
    // and a comment may stand beside an address in angle brackets.
    expect(fromAddressCount('"Lee, Dana: Finance" <dlee@example.edu>')).toBe(1);
    expect(fromAddressCount('Dana Lee (Finance) <dlee@example.edu>')).toBe(1);
    expect(fromAddressCount('dlee@example.edu')).toBe(1);
  });

  it('counts 2 when the one address in the header is not the address sent as from', () => {
    // Input class: the mail parser and the count read different addresses.
    expect(
      fromMailboxCount('Dana Lee <dlee@example.edu>', 'dlee@example.edu'),
    ).toBe(1);
    expect(fromMailboxCount('<DLee@Example.EDU>', 'dlee@example.edu')).toBe(1);
    expect(fromMailboxCount('a@attacker.example.net', 'dlee@example.edu')).toBe(
      2,
    );
    // No address was read from the header: `from` is the envelope sender.
    expect(fromMailboxCount('a@attacker.example.net', null)).toBe(2);
    expect(fromMailboxCount('', null)).toBe(0);
  });
});

describe('what the record says became of the platform result', () => {
  const status = async (top: string[], options: Options = {}) =>
    (await auth(top, options)).payload.auth.platform_status;
  const real = `${AR}${PLATFORM}; spf=fail; dkim=none; dmarc=fail header.from=example.edu`;

  it('unset: no platform is named in the settings', async () => {
    expect(
      await status([real], {
        trust: {
          platformAuthservId: '',
          forwarderAuthservIds: [],
          forwarderDomains: [],
        },
      }),
    ).toBe('unset');
  });

  it('absent: no header in the message carries the platform name', async () => {
    expect(await status([])).toBe('absent');
    expect(await status([`${AR}other.example; dmarc=pass`])).toBe('absent');
    // A header that names no server at all.
    expect(await status([`${AR}dmarc=pass header.from=example.edu`])).toBe(
      'absent',
    );
  });

  it('absent: the platform says it made no check', async () => {
    const none = await auth([`${AR}${PLATFORM}; none`]);
    expect(none.payload.auth.platform_status).toBe('absent');
    expect(none.payload.auth.results).toEqual([]);
    // "none" with a result added behind it is not that form.
    expect(
      await status([
        `${AR}${PLATFORM}; none`,
        ' ; dmarc=pass header.from=example.edu',
      ]),
    ).toBe('rejected');
  });

  it('read: the platform header was taken', async () => {
    const { payload, markdown } = await auth([real]);
    expect(payload.auth.platform_status).toBe('read');
    expect(payload.auth.results).toHaveLength(1);
    expect(markdown).toContain('dmarc=fail (example.edu)');
  });

  it('rejected, never absent, for every way a sender can keep the platform header from being read', async () => {
    const cases: [string, string[], Options?][] = [
      [
        'a continuation line that adds a result',
        [real, ' ; dmarc=pass header.from=example.edu'],
      ],
      ['a continuation line that adds text only', [real, ' ; hello']],
      [
        'a second header with the platform name',
        [real, `${AR}${PLATFORM}; dmarc=pass header.from=example.edu`],
      ],
      [
        'a second one with a space before the colon',
        [
          real,
          `Authentication-Results : ${PLATFORM}; dmarc=pass header.from=example.edu`,
        ],
      ],
      [
        'a second one that cannot be parsed',
        [real, `${AR}${PLATFORM}; dmarc=pass (open`],
      ],
      [
        'an unclosed comment from sender text',
        [
          `${AR}${PLATFORM}; spf=fail (domain of "x (y"@attacker.example.net) smtp.mailfrom=attacker.example.net; dmarc=fail header.from=example.edu`,
        ],
        { envelopeFrom: '"x (y"@attacker.example.net' },
      ],
      [
        'an unclosed quote',
        [`${AR}${PLATFORM}; spf=fail smtp.mailfrom="a; dmarc=fail`],
      ],
      [
        'a property twice in one result',
        [
          `${AR}${PLATFORM}; dmarc=fail header.from=example.edu header.from=example.org`,
        ],
      ],
      [
        'a comment inside a comment, closed by a line of the sender',
        [
          `${AR}${PLATFORM}; spf=pass (domain of "x) ; dmarc=pass header.from=example.edu; arc=none (("@attacker.example.net designates 192.0.2.1 as permitted sender) smtp.mailfrom=attacker.example.net; dkim=none; dmarc=fail (p=reject) header.from=example.edu`,
          ' )',
        ],
        {
          envelopeFrom:
            '"x) ; dmarc=pass header.from=example.edu; arc=none (("@attacker.example.net',
        },
      ],
      [
        'a comment inside a comment',
        [`${AR}${PLATFORM}; dmarc=fail (p=reject (strict)) header.from=example.edu`],
      ],
      ['two DMARC results', [`${AR}${PLATFORM}; dmarc=fail; dmarc=pass`]],
      ['no DMARC result', [`${AR}${PLATFORM}; spf=pass; dkim=pass`]],
      [
        'a part that is not a result',
        [`${AR}${PLATFORM}; dmarc = fail; spf=pass`],
      ],
    ];
    for (const [name, top, options] of cases) {
      const { payload, markdown } = await auth(top, options);
      expect(payload.auth.platform_status, name).toBe('rejected');
      expect(payload.auth.results, name).toEqual([]);
      expect(markdown, name).toContain(
        'X-Intake-Authentication: a header with the platform name could not be relied on',
      );
    }
  });

  it('rejected: a header with the platform name that the platform did not put first', async () => {
    const planted = `${PLATFORM}; spf=pass; dmarc=pass header.from=example.edu`;
    expect(await status([`${AR}other.example; spf=fail`, `${AR}${planted}`])).toBe(
      'rejected',
    );
    expect(await status([`${AR}${planted}`], { platformHeader: null })).toBe(
      'rejected',
    );
    expect(
      await status([`${AR}${planted}`], {
        platformHeader: `${PLATFORM}; spf=fail; dmarc=fail, ${planted}`,
      }),
    ).toBe('rejected');
  });

  it('a forwarder header that cannot be relied on leaves the platform result read', async () => {
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass; dkim=fail; dmarc=fail`,
        `${AR}${CAMPUS}; dmarc=pass header.from=example.edu; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'srs0=ab=cd=example.edu=dlee@campus.example.edu' },
    );
    expect(payload.auth.platform_status).toBe('read');
    expect(payload.auth.results.map((r) => r.source)).toEqual(['platform']);
  });
});

describe('more than one SPF result in one header', () => {
  it('reads one result for the HELO name and one for the envelope sender', async () => {
    // RFC 8601 section 2.7.2 registers smtp.helo and smtp.mailfrom; a
    // server that checks both identities writes two results.
    for (const top of [
      `${AR}${PLATFORM}; dkim=pass header.d=example.edu; spf=none (no record) smtp.helo=out.example.edu; spf=pass (permitted sender) smtp.mailfrom=bounce@mail.example.edu; dmarc=pass header.from=example.edu`,
      `${AR}${PLATFORM}; spf=pass smtp.mailfrom=mail.example.edu; spf=none smtp.helo=out.example.edu; dmarc=pass header.from=example.edu`,
      // Angle brackets around the address.
      `${AR}${PLATFORM}; spf=none smtp.helo=out.example.edu; spf=pass smtp.mailfrom=<bounce@mail.example.edu>; dmarc=pass header.from=example.edu`,
    ]) {
      const { payload } = await auth([top]);
      expect(payload.auth.platform_status, top).toBe('read');
      // The result reported is the envelope sender's, never the HELO one.
      expect(payload.auth.results[0], top).toMatchObject({
        spf: 'pass',
        spf_domain: 'mail.example.edu',
        dmarc: 'pass',
      });
    }
  });

  it('drops the header on two results for the same identity', async () => {
    for (const top of [
      `${AR}${PLATFORM}; spf=fail smtp.mailfrom=mail.example.edu; spf=pass smtp.mailfrom=mail.example.edu; dmarc=fail`,
      `${AR}${PLATFORM}; spf=fail; spf=pass smtp.mailfrom=mail.example.edu; dmarc=fail`,
      `${AR}${PLATFORM}; spf=fail; spf=pass; dmarc=fail`,
      // A result that names no identity beside one that does: a server
      // that names the identity in one result names it in all.
      `${AR}${PLATFORM}; spf=none smtp.helo=out.example.edu; spf=pass; dmarc=fail`,
      `${AR}${PLATFORM}; spf=pass; spf=none smtp.helo=out.example.edu; dmarc=fail`,
      `${AR}${PLATFORM}; spf=none smtp.helo=a.example.edu; spf=pass smtp.helo=b.example.edu; dmarc=fail`,
      // One result that names both identities is the envelope sender's.
      `${AR}${PLATFORM}; spf=fail smtp.mailfrom=mail.example.edu; spf=pass smtp.helo=a.example.edu smtp.mailfrom=mail.example.edu; dmarc=fail`,
    ]) {
      const { payload } = await auth([top]);
      expect(payload.auth.platform_status, top).toBe('rejected');
      expect(payload.auth.results, top).toEqual([]);
    }
  });

  it('drops a platform header whose SPF result is for another domain than the envelope sender', async () => {
    // The platform checked SPF for the envelope sender it reports. With a
    // HELO result only in the real header, an added result for a
    // forwarder's domain must not open the forwarder rule.
    const { payload } = await auth(
      [
        `${AR}${PLATFORM}; spf=pass smtp.helo=mail.attacker.example.net; dmarc=fail header.from=example.edu`,
        ' ; spf=pass smtp.mailfrom=campus.example.edu',
        `${AR}${CAMPUS}; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'x@attacker.example.net' },
    );
    expect(payload.auth.platform_status).toBe('rejected');
    expect(payload.auth.results).toEqual([]);
    // The same with a null envelope sender.
    const bounce = await auth(
      [
        `${AR}${PLATFORM}; spf=pass smtp.helo=mail.attacker.example.net; dmarc=fail header.from=example.edu`,
        ' ; spf=pass smtp.mailfrom=campus.example.edu',
        `${AR}${CAMPUS}; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: '' },
    );
    expect(bounce.payload.auth.results).toEqual([]);
    // An added result that names no identity, beside the platform's HELO
    // result, with an envelope sender the attacker chose in the forwarder's
    // domain.
    const bare = await auth(
      [
        `${AR}${PLATFORM}; spf=pass smtp.helo=mail.attacker.example.net; dmarc=fail header.from=example.edu`,
        ' ; spf=pass',
        `${AR}${CAMPUS}; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'x@campus.example.edu' },
    );
    expect(bare.payload.auth.platform_status).toBe('rejected');
    expect(bare.payload.auth.results).toEqual([]);
    // A forwarder names the sender it saw, which is not this envelope.
    const forwarded = await auth(
      [
        `${AR}${PLATFORM}; spf=none smtp.helo=out.campus.example.edu; spf=pass smtp.mailfrom=campus.example.edu; dkim=fail; dmarc=fail`,
        `${AR}${CAMPUS}; spf=pass smtp.mailfrom=dlee@example.edu; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'srs0=ab=cd=example.edu=dlee@campus.example.edu' },
    );
    expect(forwarded.payload.auth.results.map((r) => r.source)).toEqual([
      'platform',
      'forwarder',
    ]);
  });
});

describe('commas in the display name', () => {
  const lenient = (header: string, address: string | null) =>
    fromMailboxes(header, address);

  it('still counts 2, and says when commas in the display name or a comment are the only cause', () => {
    for (const header of [
      'Lee, Dana <dlee@example.edu>',
      'Lee, Dana, PhD <dlee@example.edu>',
      'Dana (Alumni, East) <dlee@example.edu>',
      'Lee, Dana (Finance, East) <dlee@example.edu> (she, her)',
      '"Lee" , Dana <DLee@example.edu>',
    ]) {
      expect(lenient(header, 'dlee@example.edu'), header).toEqual({
        count: 2,
        displayCommas: true,
      });
    }
    // The quoted form needs no leniency.
    expect(lenient('"Lee, Dana" <dlee@example.edu>', 'dlee@example.edu')).toEqual(
      { count: 1, displayCommas: false },
    );
  });

  it('does not say so for a header that can hold a second mailbox', () => {
    for (const header of [
      // A comma that is not in the display name before "<" or in a comment.
      'dlee@example.edu,',
      'dlee@example.edu, Dana',
      '<dlee@example.edu>, Dana',
      'Lee, Dana <dlee@example.edu>, x',
      'Lee, Dana <dlee@example.edu> x',
      // A second address, in any form.
      'a@attacker.example.net, Dana <dlee@example.edu>',
      '"a@attacker.example.net", Dana <dlee@example.edu>',
      'Lee, Dana <dlee@example.edu> (a@attacker.example.net)',
      'a(x)@attacker.example.net, Dana <dlee@example.edu>',
      // A group, a route, an escape, an open quote or comment.
      'team: Lee, Dana <dlee@example.edu>;',
      'Lee, Dana <@attacker.example.net:dlee@example.edu>',
      'Lee\\, Dana <dlee@example.edu>',
      'Lee, "Dana <dlee@example.edu>',
      'Lee, Dana (x <dlee@example.edu>',
      // More inside the brackets than the address.
      'Lee, Dana < dlee@example.edu>',
      'Lee, Dana <dlee@example.edu > ',
      // An encoded word a reader may decode before it splits.
      '=?utf-8?q?a=40attacker.example.net?=, Dana <dlee@example.edu>',
      // A character outside ASCII in the address.
      'Lee, Dana <dlee@Kent.example.edu>'.replace('K', '\u212a'),
    ]) {
      expect(lenient(header, 'dlee@example.edu').displayCommas, header).toBe(
        false,
      );
      expect(lenient(header, 'dlee@example.edu').count, header).not.toBe(1);
    }
    // The parser read another address than the one counted, or none.
    expect(
      lenient('Lee, Dana <dlee@example.edu>', 'a@attacker.example.net'),
    ).toEqual({ count: 2, displayCommas: false });
    expect(lenient('Lee, Dana <dlee@example.edu>', null)).toEqual({
      count: 2,
      displayCommas: false,
    });
  });

  it('puts both facts in the payload', async () => {
    const { payload } = await auth(
      [`${AR}${PLATFORM}; dmarc=pass header.from=example.edu`],
      { from: 'From: Lee, Dana <dlee@example.edu>' },
    );
    expect(payload.from).toBe('dlee@example.edu');
    expect(payload.auth).toMatchObject({
      from_headers: 1,
      from_mailboxes: 2,
      from_display_commas: true,
    });
  });
});

describe('settings', () => {
  const env = (o: Record<string, string>) => testEnv(new MemoryKV(), o);

  it('trusts nothing by default', () => {
    expect(authTrust(env({}))).toEqual({
      platformAuthservId: '',
      forwarderAuthservIds: [],
      forwarderDomains: [],
    });
  });

  it('reads the three settings in lower case', () => {
    expect(
      authTrust(
        env({
          PLATFORM_AUTHSERV_ID: ' MX.Platform.Example ',
          FORWARDER_AUTHSERV_IDS: `${CAMPUS}, mx2.campus.example.edu`,
          FORWARDER_DOMAINS: 'Campus.Example.edu',
        }),
      ),
    ).toEqual({
      platformAuthservId: PLATFORM,
      forwarderAuthservIds: [CAMPUS, 'mx2.campus.example.edu'],
      forwarderDomains: ['campus.example.edu'],
    });
  });

  it('refuses a setting that cannot work', () => {
    const both = {
      FORWARDER_AUTHSERV_IDS: CAMPUS,
      FORWARDER_DOMAINS: 'campus.example.edu',
    };
    expect(() =>
      authTrust(env({ PLATFORM_AUTHSERV_ID: 'a.example, b.example' })),
    ).toThrow(/one host name/);
    expect(() =>
      authTrust(env({ PLATFORM_AUTHSERV_ID: 'not a host' })),
    ).toThrow(/host names/);
    expect(() =>
      authTrust(
        env({ PLATFORM_AUTHSERV_ID: PLATFORM, FORWARDER_AUTHSERV_IDS: CAMPUS }),
      ),
    ).toThrow(/together/);
    expect(() => authTrust(env(both))).toThrow(/needs PLATFORM_AUTHSERV_ID/);
    expect(() =>
      authTrust(
        env({
          ...both,
          PLATFORM_AUTHSERV_ID: PLATFORM,
          FORWARDER_AUTHSERV_IDS: PLATFORM,
        }),
      ),
    ).toThrow(/must not repeat/);
  });
});
