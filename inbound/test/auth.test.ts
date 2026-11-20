import { describe, expect, it } from 'vitest';

import { parseAuthenticationResults, type AuthTrust } from '../src/auth.js';
import { buildIntake } from '../src/mail.js';
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

function message(top: string[], from = 'From: Dana Lee <dlee@example.edu>') {
  return new TextEncoder().encode(
    [
      ...top,
      from,
      'To: program@example.org',
      'Subject: Status update',
      'Message-ID: <auth-test@example.edu>',
      '',
      'The budget is approved.',
    ].join('\r\n'),
  );
}

async function auth(
  top: string[],
  options: { envelopeFrom?: string; trust?: AuthTrust; from?: string } = {},
) {
  const intake = await buildIntake(
    message(top, options.from),
    {
      from: options.envelopeFrom ?? 'bounce@mail.example.edu',
      to: 'program@example.org',
    },
    receivedAt,
    'discussions/raw',
    options.trust ?? trust,
  );
  return intake;
}

describe('which headers are read', () => {
  it('reads nothing when no trusted source is set (the default)', async () => {
    const { payload, markdown } = await auth(
      [`Authentication-Results: ${PLATFORM}; spf=pass; dkim=pass; dmarc=pass`],
      { trust: undefined },
    );
    const untrusted = await buildIntake(
      message([
        `Authentication-Results: ${PLATFORM}; spf=pass; dkim=pass; dmarc=pass`,
      ]),
      { from: 'bounce@mail.example.edu', to: 'program@example.org' },
      receivedAt,
      'discussions/raw',
    );
    expect(untrusted.payload.auth.results).toEqual([]);
    expect(untrusted.markdown).toContain(
      'X-Intake-Authentication: no trusted result',
    );
    // With the platform named, the same header is read.
    expect(payload.auth.results).toHaveLength(1);
    expect(markdown).toContain(
      `X-Intake-Authentication: platform ${PLATFORM}: spf=pass (mail.example.edu) dkim=pass dmarc=pass`,
    );
  });

  it('reads the first header when it carries the platform name', async () => {
    const { payload } = await auth([
      `Authentication-Results: ${PLATFORM}; spf=pass smtp.mailfrom=bounce@mail.example.edu;`,
      ' dkim=pass (2048-bit key; "quoted; text") header.d=example.edu header.s=s1;',
      ' dkim=fail header.d=list.example.net; dmarc=pass (p=reject) header.from=example.edu; arc=none',
      'Received: from mail.example.edu by mx.platform.example; Fri, 20 Nov 2026 15:00:00 +0000',
    ]);
    expect(payload.auth).toEqual({
      version: 1,
      envelope_from_domain: 'mail.example.edu',
      from_headers: 1,
      from_mailboxes: 1,
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
  });

  it('ignores a header with the platform name that the sender wrote', async () => {
    // The platform added no header of its own here, or added one with
    // another name: the planted header is not first-and-named, so it is
    // not read.
    const below = await auth([
      'Authentication-Results: other.example; spf=fail',
      `Authentication-Results: ${PLATFORM}; spf=pass; dkim=pass header.d=example.edu; dmarc=pass`,
    ]);
    expect(below.payload.auth.results).toEqual([]);
    expect(below.markdown).toContain(
      'X-Intake-Authentication: no trusted result',
    );
    expect(below.markdown).not.toContain('dmarc=pass');
  });

  it('reads the real platform header and not a planted one below it', async () => {
    const { payload } = await auth([
      `Authentication-Results: ${PLATFORM}; spf=fail; dkim=none; dmarc=fail`,
      `Authentication-Results: ${PLATFORM}; spf=pass; dkim=pass header.d=example.edu; dmarc=pass header.from=example.edu`,
    ]);
    expect(payload.auth.results).toHaveLength(1);
    expect(payload.auth.results[0]).toMatchObject({
      spf: 'fail',
      dkim: [{ result: 'none', domain: '' }],
      dmarc: 'fail',
    });
  });

  it('ignores a planted forwarder header on mail sent straight to the bot', async () => {
    // The platform result does not show a campus server handing it over.
    const { payload } = await auth(
      [
        `Authentication-Results: ${PLATFORM}; spf=pass; dkim=none; dmarc=fail`,
        `Authentication-Results: ${CAMPUS}; spf=pass smtp.mailfrom=example.edu; dkim=pass header.d=example.edu; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'anyone@attacker.example.net' },
    );
    expect(payload.auth.results.map((r) => r.source)).toEqual(['platform']);
  });

  it('reads the forwarder header when SPF passed for the forwarder at the platform', async () => {
    const { payload, markdown } = await auth(
      [
        `Authentication-Results: ${PLATFORM}; spf=pass; dkim=fail; dmarc=fail`,
        'Received: from out.campus.example.edu by mx.platform.example; Fri, 20 Nov 2026 15:00:00 +0000',
        `Authentication-Results: ${CAMPUS}; spf=pass smtp.mailfrom=dlee@example.edu; dkim=pass header.d=example.edu; dmarc=pass action=none header.from=example.edu`,
        // Written by the sender, below the forwarder's own: never read.
        `Authentication-Results: ${CAMPUS}; dmarc=pass header.from=other.example.org`,
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

  it('reads the forwarder header when SPF failed at the platform but the forwarder signed', async () => {
    const { payload } = await auth(
      [
        `Authentication-Results: ${PLATFORM}; spf=fail; dkim=pass header.d=campus.example.edu; dmarc=fail`,
        `Authentication-Results: ${CAMPUS}; spf=pass smtp.mailfrom=example.edu; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'dlee@example.edu' },
    );
    expect(payload.auth.results.map((r) => r.source)).toEqual([
      'platform',
      'forwarder',
    ]);
  });

  it('does not treat a failed SPF for the forwarder domain as proof', async () => {
    const { payload } = await auth(
      [
        `Authentication-Results: ${PLATFORM}; spf=softfail; dkim=fail header.d=campus.example.edu; dmarc=fail`,
        `Authentication-Results: ${CAMPUS}; dmarc=pass header.from=example.edu`,
      ],
      { envelopeFrom: 'x@campus.example.edu' },
    );
    expect(payload.auth.results).toHaveLength(1);
  });

  it('never reads a header that names no server', async () => {
    const { payload } = await auth([
      'Authentication-Results: spf=pass smtp.mailfrom=example.edu; dmarc=pass header.from=example.edu',
    ]);
    expect(payload.auth.results).toEqual([]);
    expect(
      parseAuthenticationResults('spf=pass smtp.mailfrom=example.edu'),
    ).toBeNull();
  });

  it('does not read a result out of a quoted string or a comment the sender shaped', async () => {
    const { payload } = await auth(
      [
        `Authentication-Results: ${PLATFORM}; spf=pass smtp.mailfrom="a; dmarc=pass header.from=example.edu"@attacker.example.net`,
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
      `Authentication-Results: ${PLATFORM}; spf=pass smtp.mailfrom="a; dmarc=pass`,
    ]);
    expect(broken.payload.auth.results).toEqual([]);
  });

  it('counts a second From header and a second address in From', async () => {
    const two = await buildIntake(
      new TextEncoder().encode(
        [
          `Authentication-Results: ${PLATFORM}; dmarc=pass`,
          'From: dlee@example.edu',
          'From: other@example.org',
          'To: program@example.org',
          'Subject: Two senders',
          '',
          'x',
        ].join('\r\n'),
      ),
      { from: 'b@mail.example.edu', to: 'program@example.org' },
      receivedAt,
      'discussions/raw',
      trust,
    );
    expect(two.payload.auth.from_headers).toBe(2);
    const group = await auth([], {
      from: 'From: "dlee@example.edu" <other@example.org>',
    });
    expect(group.payload.auth.from_mailboxes).toBe(2);
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
    expect(() =>
      authTrust(
        env({
          FORWARDER_AUTHSERV_IDS: CAMPUS,
          FORWARDER_DOMAINS: 'campus.example.edu',
        }),
      ),
    ).toThrow(/needs PLATFORM_AUTHSERV_ID/);
    expect(() =>
      authTrust(
        env({
          PLATFORM_AUTHSERV_ID: PLATFORM,
          FORWARDER_AUTHSERV_IDS: PLATFORM,
          FORWARDER_DOMAINS: 'campus.example.edu',
        }),
      ),
    ).toThrow(/must not repeat/);
  });
});
