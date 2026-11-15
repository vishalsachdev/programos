import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  assertGateProfile,
  chatProfile,
  emailProfile,
  emailAddressesInText,
  formatShortfallAlert,
  gateDirectSend,
  gateEmailOutbound,
  reportDeliveryShortfall,
  setDeliveryShortfallAlerter,
  warnIfShortReply,
  SHORT_REPLY_THRESHOLD,
  type DeliveryProfile,
} from './delivery-gate.js';
import { logger } from './logger.js';
import { processDelivery } from './delivery-processor.js';
import type { DeliveryState } from './delivery-state.js';

describe('emailProfile (G46 email delivery gate)', () => {
  it('passes a clean <reply> block', () => {
    expect(
      emailProfile.validate('<reply>Hi Paige,\n\nAll set.</reply>'),
    ).toEqual({ ok: true, text: 'Hi Paige,\n\nAll set.' });
  });

  it('refuses text with no <reply> block — never falls back to session text', () => {
    expect(emailProfile.validate('Mode 2 — answered from tools.md')).toEqual({
      ok: false,
      reason: 'missing-reply-block',
    });
  });

  it('refuses an empty <reply> block', () => {
    expect(emailProfile.validate('noise<reply>  \n</reply>noise')).toEqual({
      ok: false,
      reason: 'empty-reply-block',
    });
  });

  it('refuses when any block matches a scaffolding signature', () => {
    expect(
      emailProfile.validate(
        '<reply>Hi Paige, done.</reply><reply>Reply sent and pilot log committed.</reply>',
      ),
    ).toEqual({ ok: false, reason: 'scaffolding' });
  });

  it('gateEmailOutbound stays an alias of emailProfile.validate', () => {
    const raw = '<reply>Hello</reply>';
    expect(gateEmailOutbound(raw)).toEqual(emailProfile.validate(raw));
  });
});

describe('chatProfile (G46 chat delivery gate — signature check only)', () => {
  it('passes free-form text untouched', () => {
    expect(
      chatProfile.validate('Here is the roster update you asked for.'),
    ).toEqual({
      ok: true,
      text: 'Here is the roster update you asked for.',
    });
  });

  it('strips <internal> blocks like the legacy chat path', () => {
    expect(
      chatProfile.validate('<internal>thinking…</internal>Roster updated.'),
    ).toEqual({ ok: true, text: 'Roster updated.' });
  });

  it('extracts <reply> blocks when present instead of sending tags verbatim', () => {
    expect(
      chatProfile.validate(
        'narration <reply>Just the reply.</reply> more narration',
      ),
    ).toEqual({ ok: true, text: 'Just the reply.' });
  });

  it('refuses scaffolding signatures (the ungated-Telegram leak)', () => {
    expect(
      chatProfile.validate('Reply sent and pilot log committed to the repo.'),
    ).toEqual({ ok: false, reason: 'scaffolding' });
    expect(chatProfile.validate('Classification: Mode 1 — Update')).toEqual({
      ok: false,
      reason: 'scaffolding',
    });
  });

  it('refuses unmatched reply-tag remnants', () => {
    expect(chatProfile.validate('Hi Avery, done.</reply>')).toEqual({
      ok: false,
      reason: 'reply-tag-remnants',
    });
  });

  it('passes empty output as ok with empty text (caller skips the send)', () => {
    expect(chatProfile.validate('<internal>only internal</internal>')).toEqual({
      ok: true,
      text: '',
    });
  });

  it('does not trip on mid-sentence mentions of gate phrases', () => {
    expect(
      chatProfile.validate('Thanks — the reply sent yesterday covers it.'),
    ).toEqual({
      ok: true,
      text: 'Thanks — the reply sent yesterday covers it.',
    });
  });
});

describe('gate refusal uses the real delivery coordinator', () => {
  async function orchestrate(raw: string, profile: DeliveryProfile) {
    let stored: DeliveryState | undefined;
    const deliverPrepared = vi.fn(async () => ({
      status: 'sent' as const,
      providerId: 'provider-1',
    }));
    const result = await processDelivery(
      {
        chatJid: 'tg-test@program',
        prompt: 'prompt',
        inboundText: 'question',
        targetTimestamp: '2026-08-10T15:00:00.000Z',
        previousCursor: '',
        context: {},
      },
      {
        loadState: () =>
          stored ? { status: 'valid', state: stored } : { status: 'none' },
        saveState: (state) => {
          stored = state;
          return { status: 'saved' };
        },
        clearState: () => {
          stored = undefined;
        },
        runBusinessAgent: async () => ({ status: 'success', raw }),
        runRepairAgent: async () => ({ status: 'success', raw }),
        validateOutput: profile.validate,
        prepareDelivery: async (text, deliveryId) => ({
          status: 'prepared',
          delivery: {
            channel: 'telegram',
            deliveryId,
            jid: 'tg-test@program',
            payload: { text },
          },
        }),
        deliverPrepared,
        writeCursor: vi.fn(),
        auditSent: () => 'written',
        auditSuppressed: () => 'written',
        auditCcContext: () => 'written',
        auditDeadLetter: () => 'written',
        closeContainer: vi.fn(),
        alertDeadLetter: async () => undefined,
        now: () => new Date('2026-08-10T15:01:00.000Z'),
        newDeliveryId: () => 'delivery-1',
      },
    );
    return { result, stored, deliverPrepared };
  }

  it('telegram scaffolding output is persisted for repair, not sent', async () => {
    const r = await orchestrate(
      'Email sent to Paige; pilot log committed.',
      chatProfile,
    );
    expect(r.result).toEqual({ status: 'retry', attempt: 1 });
    expect(r.stored?.phase).toBe('repair-required');
    expect(r.deliverPrepared).not.toHaveBeenCalled();
  });

  it('telegram normal output reaches the frozen delivery path', async () => {
    const r = await orchestrate(
      'The CRS 554 roster now shows 42 items.',
      chatProfile,
    );
    expect(r.result).toEqual({ status: 'complete' });
    expect(r.deliverPrepared).toHaveBeenCalledTimes(1);
  });

  // Catches storing only the refusal category and discarding offending addresses before repair.
  it('stores every unverified address in the durable repair reason', async () => {
    const r = await orchestrate(
      '<reply>Contact amorgan@example.edu or morgan@example.edu</reply>',
      emailProfile,
    );
    expect(r.stored).toMatchObject({
      phase: 'repair-required',
      gateReason:
        'unverified-email-address: amorgan@example.edu, morgan@example.edu',
    });
    expect(r.deliverPrepared).not.toHaveBeenCalled();
  });

  it('email output without a reply block is persisted for repair', async () => {
    const r = await orchestrate(
      'The CRS 554 roster now shows 42 items.',
      emailProfile,
    );
    expect(r.result).toEqual({ status: 'retry', attempt: 1 });
    expect(r.stored?.phase).toBe('repair-required');
    expect(r.deliverPrepared).not.toHaveBeenCalled();
  });
});

describe('assertGateProfile (registry-level profile requirement)', () => {
  it('accepts the registered profiles', () => {
    expect(() => assertGateProfile('webhook', emailProfile)).not.toThrow();
    expect(() => assertGateProfile('telegram', chatProfile)).not.toThrow();
  });

  it('throws at startup for a channel with no declared profile', () => {
    expect(() => assertGateProfile('mystery', undefined)).toThrow(/G46/);
  });

  it('throws for an ad-hoc profile not registered in the gate module', () => {
    const rogue: DeliveryProfile = {
      name: 'email',
      validate: (t) => ({ ok: true, text: t }),
    };
    expect(() => assertGateProfile('rogue', rogue)).toThrow(/delivery-gate/);
  });
});

describe('reportDeliveryShortfall (G46 completeness — never silently partial)', () => {
  afterEach(() => setDeliveryShortfallAlerter(null));

  it('fires the registered alerter naming the missed recipients', async () => {
    const alerts: string[] = [];
    setDeliveryShortfallAlerter(async (s) => {
      alerts.push(formatShortfallAlert(s));
    });

    reportDeliveryShortfall({
      channel: 'email',
      context: 'program-email: Weekly KB Update',
      intended: ['a@example.edu', 'b@example.edu'],
      sent: ['a@example.edu'],
      missed: ['b@example.edu'],
      reason: 'resend-api-error: HTTP 422',
    });
    await vi.waitFor(() => expect(alerts).toHaveLength(1));

    expect(alerts[0]).toContain('b@example.edu');
    expect(alerts[0]).toContain('resend-api-error');
    expect(alerts[0]).toContain('Weekly KB Update');
  });

  it('does nothing when there is no shortfall', async () => {
    const alerter = vi.fn(async () => {});
    setDeliveryShortfallAlerter(alerter);
    reportDeliveryShortfall({
      channel: 'email',
      context: 'program-email: digest',
      intended: ['a@example.edu'],
      sent: ['a@example.edu'],
      missed: [],
      reason: 'n/a',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(alerter).not.toHaveBeenCalled();
  });

  it('an alerter failure is swallowed (logged), never thrown at the sender', () => {
    setDeliveryShortfallAlerter(async () => {
      throw new Error('telegram down');
    });
    expect(() =>
      reportDeliveryShortfall({
        channel: 'email',
        context: 'ctx',
        intended: ['a@x'],
        sent: [],
        missed: ['a@x'],
        reason: 'r',
      }),
    ).not.toThrow();
  });
});

describe('gateDirectSend (direct-send backstop: IPC + scheduler sends)', () => {
  it('passes tagless prose through unchanged', () => {
    const r = gateDirectSend('Weekly digest: 3 items resolved.');
    expect(r).toEqual({ ok: true, text: 'Weekly digest: 3 items resolved.' });
  });

  it('reduces a <reply> block to its contents', () => {
    const r = gateDirectSend(
      'Classification: question\n<reply>Hi Paige,\n\nAll set.</reply>',
    );
    expect(r).toEqual({ ok: true, text: 'Hi Paige,\n\nAll set.' });
  });

  it('strips <internal> blocks from tagless text', () => {
    const r = gateDirectSend('<internal>gate notes</internal>Digest body.');
    expect(r).toEqual({ ok: true, text: 'Digest body.' });
  });

  it('refuses a body that is only internal monologue', () => {
    const r = gateDirectSend('<internal>nothing outbound here</internal>');
    expect(r).toEqual({ ok: false, reason: 'empty-reply-block' });
  });

  it('refuses prose containing a literal unmatched <reply> tag', () => {
    // Coordinator emailing Avery ABOUT the pipeline: the literal tag in prose is
    // indistinguishable from malformed agent output, so it must not
    // transmit — a loud refusal (owner alert) beats a leaked tag.
    const r = gateDirectSend(
      'The gate wraps outbound text in a <reply> tag before sending.',
    );
    expect(r).toEqual({ ok: false, reason: 'reply-tag-remnants' });
  });

  it('refuses scaffolding even inside a well-formed reply block', () => {
    const r = gateDirectSend(
      '<reply>Reply sent and pilot log updated.</reply>',
    );
    expect(r).toEqual({ ok: false, reason: 'scaffolding' });
  });

  it('refuses an empty body', () => {
    expect(gateDirectSend('  \n ')).toEqual({
      ok: false,
      reason: 'empty-reply-block',
    });
  });
});

// --- warnIfShortReply ---

describe('warnIfShortReply (short-reply guard)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not warn when body is long enough', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const longBody = 'a'.repeat(SHORT_REPLY_THRESHOLD);
    warnIfShortReply(longBody, 'please send me the full audit report', 'test');
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not warn when inbound is not a document request', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    warnIfShortReply('Hi, thanks!', 'Hey, how are you?', 'test');
    expect(spy).not.toHaveBeenCalled();
  });

  it('warns (without throwing) when body is short and inbound is a document request', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const shortBody = 'Reply sent and pilot log committed.';
    // Logs a warning, never blocks the send
    expect(() =>
      warnIfShortReply(
        shortBody,
        'Please send the full KB audit report organized into 15 categories',
        'group=program-email',
      ),
    ).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        outboundLen: shortBody.length,
        threshold: SHORT_REPLY_THRESHOLD,
        context: 'group=program-email',
      }),
      expect.stringContaining('short-reply-guard'),
    );
  });

  it('warns when body is short and inbound contains "comprehensive summary"', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    warnIfShortReply(
      'Got it.',
      'Can you provide a comprehensive summary?',
      'test',
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('email body address trust', () => {
  const context = {
    allowlist: {
      available: true,
      senders: new Set(['avery@example.edu']),
      source: 'test',
    },
    inboundText: [
      'From: visitor@example.org\nTo: other@example.org\nCc: cc@example.org\nContact inbound-only@example.org',
    ],
    sendFromEmail: 'program@example.org',
  };
  // Catches omission of the deterministic body-address refusal and named evidence.
  it.each([
    'amorgan@example.edu',
    'morgan@example.edu',
    '**unknown@example.org**.',
    '<a href="mailto:UNKNOWN+tag@example.org">Contact</a>,',
  ])('refuses untrusted body address %s', (address) => {
    const gate = emailProfile.validate(
      `<reply>Contact ${address}</reply>`,
      context,
    );
    expect(gate).toMatchObject({
      ok: false,
      reason: 'unverified-email-address',
      addresses: [
        address.includes('mailto:')
          ? 'href="mailto:UNKNOWN+tag@example.org">Contact</a>'
          : address.replaceAll('**', ''),
      ],
    });
  });
  // Catches failure to trust the allowlist, turn input, or configured sender case-insensitively.
  it.each([
    'AVERY@example.edu',
    'inbound-only@example.org',
    'visitor@example.org',
    'other@example.org',
    'cc@example.org',
    'PROGRAM@example.org',
    '**avery@example.edu**,',
    '`avery@example.edu`',
    'mailto:avery@example.edu',
  ])('passes trusted address %s', (address) => {
    expect(
      emailProfile.validate(`<reply>Contact ${address}.</reply>`, context).ok,
    ).toBe(true);
  });
  // R5 replaces the old HTML sub-reading approval: attribute text is a whole stray-character token, not an allowlisted mailbox.
  it('refuses an href attribute token even when its embedded mailbox is allowlisted', () => {
    expect(
      emailProfile.validate(
        '<reply>Contact <a href="mailto:avery@example.edu">Avery</a></reply>',
        context,
      ),
    ).toMatchObject({
      ok: false,
      addresses: ['href="mailto:avery@example.edu">Avery</a>'],
    });
  });
  // Catches ignoring unverified quotes while preserving real inbound quotes and hidden internals.
  it('trusts quoted addresses only when supplied inbound and ignores internal addresses', () => {
    expect(
      emailProfile.validate(
        '<internal>hidden@example.org</internal><reply>Thanks.\n> inbound-only@example.org</reply>',
        context,
      ).ok,
    ).toBe(true);
  });
  // Catches accidental extension of the email policy to chat.
  it('leaves chat addresses unchanged', () => {
    expect(
      chatProfile.validate('Contact unknown@example.org', context).ok,
    ).toBe(true);
  });
  // Catches fail-open behavior when the allowlist is missing, even for known inbound identities.
  it('refuses address-bearing replies when the allowlist is unavailable', () => {
    expect(
      emailProfile.validate('<reply>visitor@example.org</reply>', {
        ...context,
        allowlist: { ...context.allowlist, available: false },
      }),
    ).toMatchObject({
      ok: false,
      reason: 'unverified-email-address',
      addresses: ['visitor@example.org'],
    });
  });
  // Catches a context-free direct-send bypass and prevents proposed recipients establishing body trust.
  it('gates direct sends without trusting proposed recipients', () => {
    expect(gateDirectSend('unknown@example.org', context)).toMatchObject({
      ok: false,
      reason: 'unverified-email-address',
    });
    expect(gateDirectSend('recipient@example.org', context).ok).toBe(false);
    expect(gateDirectSend('unknown@example.org').ok).toBe(false);
  });
  // Catches limiting validation to the repair evidence cap.
  it('scans the entire reply', () => {
    expect(
      emailProfile.validate(
        `<reply>${'x'.repeat(13000)} amorgan@example.edu</reply>`,
        context,
      ),
    ).toMatchObject({ ok: false, addresses: ['amorgan@example.edu'] });
  });
});

describe('email body URL and mailto boundaries', () => {
  // Catches extracting a Medium path handle as an email address.
  it('ignores a Medium @handle URL', () => {
    const text = 'Read https://medium.com/@jane.writer/example-post';
    expect(emailAddressesInText(text)).toEqual([]);
    expect(emailProfile.validate(`<reply>${text}</reply>`)).toEqual({
      ok: true,
      text,
    });
  });
  // Catches extracting dotted YouTube handles and bare www URL handles as email addresses.
  it('ignores YouTube @handle URLs', () => {
    for (const url of [
      'https://www.youtube.com/@handle',
      'https://www.youtube.com/@handle.name',
      'http://www.youtube.com/@handle.name',
      'www.youtube.com/@handle.name',
    ]) {
      expect(emailAddressesInText(url)).toEqual([]);
      expect(gateDirectSend(`Watch ${url}`).ok).toBe(true);
    }
  });
  // Catches URL exclusion accidentally exempting bare mailto targets or HTML href targets.
  it('still refuses unknown bare mailto and href targets', () => {
    for (const [text, cleaned, raw] of [
      [
        'mailto:unknown@example.edu',
        'unknown@example.edu',
        'mailto:unknown@example.edu',
      ],
      [
        '<a href="mailto:unknown@example.edu">Contact</a>',
        'href="mailto:unknown@example.edu">contact</a>',
        'href="mailto:unknown@example.edu">Contact</a>',
      ],
    ]) {
      expect(emailAddressesInText(text)).toEqual([cleaned]);
      expect(emailProfile.validate(`<reply>${text}</reply>`)).toMatchObject({
        ok: false,
        reason: 'unverified-email-address',
        addresses: [raw],
      });
    }
  });
  // Catches hiding a displayed email or mailto target when removing nearby HTTP URLs.
  it('still refuses unknown markdown mailto links alongside URL handles', () => {
    const text =
      '[Read](https://medium.com/@jane.writer/post)[unknown@example.edu](mailto:unknown@example.edu)';
    expect(emailAddressesInText(text)).toEqual([text.toLowerCase()]);
    expect(emailProfile.validate(`<reply>${text}</reply>`)).toMatchObject({
      ok: false,
      reason: 'unverified-email-address',
      addresses: [
        '(https://medium.com/@jane.writer/post)unknown@example.edu',
        '(mailto:unknown@example.edu)',
      ],
    });
    expect(
      emailAddressesInText('[unknown@example.edu](mailto:unknown@example.edu)'),
    ).toEqual(['[unknown@example.edu](mailto:unknown@example.edu)']);
  });
});

// R6-1: www. prefixes without a pre-@ slash are mailbox identities.
it('refuses untrusted www. mailbox identities', () => {
  const text = 'www.contact@example.edu';
  expect(emailAddressesInText(text)).toEqual(['www.contact@example.edu']);
  expect(gateDirectSend(text)).toMatchObject({
    ok: false,
    addresses: ['www.contact@example.edu'],
  });
});
