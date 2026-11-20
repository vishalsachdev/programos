import { describe, expect, it } from 'vitest';

import {
  checkMessage,
  parseArgs,
  report,
} from '../scripts/check-message.js';

// The offline check runs the worker's reader and the host's verdict
// (`src/email-auth.ts`, one folder up) on one message. Synthetic messages
// only.

const PLATFORM = 'mx.platform.example';
const CAMPUS = 'mx.campus.example.edu';

function message(top: string[], from = 'Dana Lee <dlee@example.edu>') {
  return new TextEncoder().encode(
    [
      ...top,
      `From: ${from}`,
      'To: program@example.org',
      'Subject: Status update',
      '',
      'The budget is approved.',
    ].join('\r\n'),
  );
}

const twoSpf = `Authentication-Results: ${PLATFORM}; dkim=pass header.d=example.edu; spf=none smtp.helo=out.example.edu; spf=pass smtp.mailfrom=bounce@mail.example.edu; dmarc=pass header.from=example.edu`;

describe('offline check of one message', () => {
  it('a platform header with a HELO and a MAIL FROM result: authenticated', async () => {
    const result = await checkMessage(message([twoSpf]), {
      platform: PLATFORM,
      envelopeFrom: 'bounce@mail.example.edu',
    });
    expect(result.record.platform_status).toBe('read');
    expect(result.decision).toEqual({
      verdict: 'authenticated',
      reason: `DMARC pass for example.edu (${PLATFORM})`,
    });
    expect(result.enforceWouldDrop).toBe(false);
    const text = report(result);
    expect(text).toContain('VERDICT: authenticated');
    expect(text).toContain('would be processed');
    expect(text).not.toContain('Note: the envelope sender was not given');
  });

  it('takes the envelope sender from Return-Path when it is not given, and says so', async () => {
    const result = await checkMessage(
      message(['Return-Path: <bounce@mail.example.edu>', twoSpf]),
      { platform: PLATFORM },
    );
    expect(result.envelopeFrom).toBe('bounce@mail.example.edu');
    expect(result.envelopeFromSource).toBe('Return-Path header');
    expect(result.decision.verdict).toBe('authenticated');
    expect(report(result)).toContain('Note: the envelope sender was not given');
  });

  it('the bare form: unauthenticated unless the From domain is not required', async () => {
    const bare = message([
      `Authentication-Results: ${PLATFORM}; spf=pass; dkim=pass; dmarc=pass`,
    ]);
    const strict = await checkMessage(bare, { platform: PLATFORM });
    expect(strict.decision.verdict).toBe('unauthenticated');
    expect(strict.enforceWouldDrop).toBe(true);
    expect(report(strict)).toContain('(no From domain named)');
    const loose = await checkMessage(bare, {
      platform: PLATFORM,
      requireFromDomain: 'false',
    });
    expect(loose.decision.verdict).toBe('authenticated');
  });

  it('a display name with a comma and one address: authenticated with a named From domain', async () => {
    const result = await checkMessage(
      message([twoSpf], 'Lee, Dana <dlee@example.edu>'),
      { platform: PLATFORM, envelopeFrom: 'bounce@mail.example.edu' },
    );
    expect(result.record.from_mailboxes).toBe(2);
    expect(result.decision.verdict).toBe('authenticated');
    // A second address behind the comma is not that form.
    const two = await checkMessage(
      message([twoSpf], 'dlee@example.edu, Dana <a@attacker.example.net>'),
      { platform: PLATFORM, envelopeFrom: 'bounce@mail.example.edu' },
    );
    expect(two.decision.verdict).toBe('unauthenticated');
  });

  it('a header a sender extended, or a second one with the platform name: unauthenticated, dropped even with unknown allowed', async () => {
    const real = `Authentication-Results: ${PLATFORM}; spf=fail; dmarc=fail header.from=example.edu`;
    for (const top of [
      [real, ' ; dmarc=pass header.from=example.edu'],
      [real, `Authentication-Results: ${PLATFORM}; dmarc=pass header.from=example.edu`],
    ]) {
      const result = await checkMessage(message(top), {
        platform: PLATFORM,
        unknown: 'allow',
      });
      expect(result.record.platform_status).toBe('rejected');
      expect(result.decision.verdict).toBe('unauthenticated');
      expect(result.enforceWouldDrop).toBe(true);
    }
  });

  it('no platform header: unknown, and enforce follows the sub-choice', async () => {
    const none = message(['Authentication-Results: other.example; dmarc=pass']);
    const blocked = await checkMessage(none, { platform: PLATFORM });
    expect(blocked.record.platform_status).toBe('absent');
    expect(blocked.decision.verdict).toBe('unknown');
    expect(blocked.enforceWouldDrop).toBe(true);
    const allowed = await checkMessage(none, {
      platform: PLATFORM,
      unknown: 'allow',
    });
    expect(allowed.enforceWouldDrop).toBe(false);
  });

  it('forwarded mail: the forwarder header is read under the same rule as in the worker', async () => {
    const result = await checkMessage(
      message([
        `Authentication-Results: ${PLATFORM}; spf=pass smtp.mailfrom=campus.example.edu; dkim=fail; dmarc=fail header.from=example.edu`,
        `Authentication-Results: ${CAMPUS}; spf=pass smtp.mailfrom=dlee@example.edu; dmarc=pass header.from=example.edu`,
      ]),
      {
        platform: PLATFORM,
        forwarderIds: CAMPUS,
        forwarderDomains: 'campus.example.edu',
        envelopeFrom: 'srs0=ab=cd=example.edu=dlee@campus.example.edu',
      },
    );
    expect(result.decision).toEqual({
      verdict: 'authenticated',
      reason: `DMARC pass for example.edu (${CAMPUS})`,
    });
  });

  it('refuses settings the worker or the host would refuse', async () => {
    const raw = message([twoSpf]);
    await expect(checkMessage(raw, { platform: '' })).rejects.toThrow(
      /--platform/,
    );
    await expect(
      checkMessage(raw, { platform: PLATFORM, forwarderIds: CAMPUS }),
    ).rejects.toThrow(/set together/);
    await expect(
      checkMessage(raw, { platform: PLATFORM, unknown: 'maybe' }),
    ).rejects.toThrow(/"block" or "allow"/);
    await expect(
      checkMessage(raw, { platform: PLATFORM, trusted: 'not a host' }),
    ).rejects.toThrow(/host names/);
  });

  it('reads its arguments', () => {
    expect(
      parseArgs(['m.eml', '--platform', PLATFORM, '--unknown', 'allow']),
    ).toEqual({
      file: 'm.eml',
      options: { platform: PLATFORM, unknown: 'allow' },
    });
    expect(() => parseArgs(['m.eml'])).toThrow(/Usage/);
    expect(() => parseArgs(['m.eml', '--platform'])).toThrow(/needs a value/);
    expect(() =>
      parseArgs(['m.eml', '--platform', PLATFORM, '--nope', 'x']),
    ).toThrow(/Unknown argument/);
  });
});
