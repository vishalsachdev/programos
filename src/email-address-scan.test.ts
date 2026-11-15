import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import {
  emailAddressesInText,
  inboundEmailAddressesInText,
  emailProfile,
} from './delivery-gate.js';
import { stripMarkdown } from './email-format.js';

const { describeSendPrecheck } = await import(
  new URL('../container/agent-runner/src/allowlist-check.ts', import.meta.url)
    .href
);
const allowlistText = '| Person | person@example.edu |';

// R2-1/5: catches host/container disagreement at URL boundaries and ordinary quote punctuation.
it('checks addresses adjacent to links and accepts quoted known contacts in the container', () => {
  expect(
    describeSendPrecheck({
      to: 'person@example.edu',
      body: '[Source](https://example.org)invented@example.org',
      allowlistText,
    }),
  ).toContain('invented@example.org');
  expect(
    describeSendPrecheck({
      to: 'person@example.edu',
      body: "Contact 'person@example.edu'",
      allowlistText,
    }),
  ).toBe('');
});

// R2-2: long admitted input and outgoing text cannot monopolize the event loop while searching for @.
it.each([
  ['no @', 'a'.repeat(200_000)],
  ['many @', 'a@'.repeat(100_000)],
])(
  'scans 200,000 characters with %s in under 50ms on host and container',
  (_name, text) => {
    const startHost = performance.now();
    const result = emailAddressesInText(text);
    const hostMs = performance.now() - startHost;
    expect(result).toEqual([]);
    expect(hostMs).toBeLessThan(50);
    const startContainer = performance.now();
    const warning = describeSendPrecheck({
      to: 'person@example.edu',
      body: text,
      allowlistText,
    });
    const containerMs = performance.now() - startContainer;
    expect(warning).toBe('');
    expect(containerMs).toBeLessThan(50);
  },
);

// R5 replaces empty-local readings: URL/handle exemptions require whole-token prefixes; other slash tokens remain exact.
it('keeps exact slash tokens, excludes @-prefixed handles and preserves local-part characters', () => {
  expect(emailAddressesInText('/@handle.name @x.example /@not.email')).toEqual([
    '/@handle.name',
    '/@not.email',
  ]);
  expect(
    emailAddressesInText(
      stripMarkdown("'._person_.@example.edu' mailto:plus+tag@example.org"),
    ),
  ).toEqual(['.person.@example.edu', 'plus+tag@example.org']);
});

// R3-1: covers the ordinary reply validator and container tool warning before either reaches send.
it.each([
  'person_@example.edu',
  '_person@example.edu',
  '.person@example.edu',
  'person.@example.edu',
])(
  'refuses distinct identity %s in the reply validator and warns in the container',
  (address) => {
    expect(
      emailProfile.validate(`<reply>Contact ${address}</reply>`, {
        allowlist: {
          available: true,
          source: 'test',
          senders: new Set(['person@example.edu']),
        },
        inboundText: [],
      }),
    ).toMatchObject({
      ok: false,
      reason: 'unverified-email-address',
      addresses: [address],
    });
    expect(
      describeSendPrecheck({
        to: 'person@example.edu',
        body: `Contact ${address}`,
        allowlistText,
      }),
    ).toContain(address);
  },
);

// R3-1: container advice must accept an underscore address actually present in its own allowlist.
it('accepts an approved underscore identity in the container without warning', () => {
  expect(
    describeSendPrecheck({
      to: 'person_@example.edu',
      body: 'Contact person_@example.edu',
      allowlistText: '| Underscore | person_@example.edu |',
    }),
  ).toBe('');
});

// R4-1: reproduces valid atext prefixes being silently checked as a different allowlisted mailbox.
it.each([
  "o'person@example.edu",
  'fake/person@example.edu',
  'fake!person@example.edu',
])('requires the exact complete token %s to be trusted', (address) => {
  const context = {
    allowlist: {
      available: true,
      source: 'test',
      senders: new Set(['person@example.edu']),
    },
    inboundText: [],
  };
  expect(
    emailProfile.validate(`<reply>Contact ${address}</reply>`, context),
  ).toMatchObject({ ok: false, addresses: [address] });
  expect(
    describeSendPrecheck({
      to: 'person@example.edu',
      body: `Contact ${address}`,
      allowlistText,
    }),
  ).toContain(address);
  // R5 replaces the old dual-reading assertion: approving the whole token must pass without requiring a substring.
  expect(
    emailProfile.validate(`<reply>Contact ${address}</reply>`, {
      ...context,
      allowlist: { ...context.allowlist, senders: new Set([address]) },
    }),
  ).toMatchObject({ ok: true, text: `Contact ${address}` });
});
// R4-1: quotes remain punctuation and an immediately pre-@ slash denotes a URL handle.
it('accepts a quoted approved address and ignores Medium and YouTube slash-at handles', () => {
  expect(
    emailAddressesInText(
      "'person@example.edu' https://medium.com/@jane.writer/story https://www.youtube.com/@handle.name",
    ),
  ).toEqual(['person@example.edu']);
});

// R4-3/D: only a matching underscore run on both sides is evidence of markup, never a genuine unpaired leading underscore.
it.each([
  ['__advisor@example.org__', true],
  ['_advisor@example.org_', true],
  ['<_advisor@example.org>', false],
  ['__advisor@example.org_', false],
  ['_advisor@example.org__', false],
])('adds inbound markup variant only for paired runs: %s', (text, paired) => {
  const addresses = inboundEmailAddressesInText(text);
  expect(addresses.includes('advisor@example.org')).toBe(paired);
  expect(addresses.some((address) => address.startsWith('_'))).toBe(true);
});

// R5-1/2: raw tokens with quoted local parts, international domains or stray characters must never vanish or become an approved sub-token.
it.each([
  '"invented"@example.org',
  'invented@example.xn--p1ai',
  'person@example.edué',
  'pérson@example.edu',
  'person@example.edu#fragment',
])(
  'refuses untrusted exact token %s in ordinary replies and container warnings',
  (token) => {
    expect(
      emailProfile.validate(`<reply>Contact ${token}</reply>`, {
        allowlist: {
          available: true,
          source: 'fixture',
          senders: new Set(['person@example.edu']),
        },
        inboundText: [],
      }),
    ).toMatchObject({ ok: false, addresses: [token] });
    expect(
      describeSendPrecheck({
        to: 'person@example.edu',
        body: `Contact ${token}`,
        allowlistText,
      }),
    ).toContain(token);
  },
);
// R5 token delimiters and ordinary handles must keep legitimate simple reply formats deliverable.
it.each([
  '(avery@example.edu)',
  '<avery@example.edu>',
  '|Name|avery@example.edu|',
  'Email avery@example.edu.',
  'Telegram @ProgramBot',
  'Contact "avery@example.edu"',
  "Contact 'avery@example.edu'",
  'Contact mailto:avery@example.edu',
  'Contact mailto:"avery@example.edu"',
  "Contact mailto:'avery@example.edu'",
  'Contact avery@example.edu:!?',
])('accepts exact allowlisted token or handle in %s', (text) => {
  expect(
    emailProfile.validate(`<reply>${text}</reply>`, {
      allowlist: {
        available: true,
        source: 'fixture',
        senders: new Set(['avery@example.edu']),
      },
    }),
  ).toMatchObject({ ok: true });
  expect(
    describeSendPrecheck({
      to: 'avery@example.edu',
      body: text,
      allowlistText: '| Avery | avery@example.edu |',
    }),
  ).toBe('');
});
// R5-3: raw intake can trust the exact supplied mailbox, never one of its former candidate readings.
it('retains just the complete inbound token and balanced underscore variants', () => {
  expect(
    inboundEmailAddressesInText(
      "Cc: <o'advisor@example.org> __wrapped@example.org__ _italic@example.org_ <_actual@example.org>",
    ),
  ).toEqual([
    "o'advisor@example.org",
    '__wrapped@example.org__',
    'wrapped@example.org',
    '_italic@example.org_',
    'italic@example.org',
    '_actual@example.org',
  ]);
});

// R6-1: prefix-only URL exemption must not hide a www. mailbox from host/container checks.
it('requires exact trust for www. mailbox names while preserving URL paths and queries', () => {
  const context = {
    allowlist: {
      available: true,
      source: 'fixture',
      senders: new Set(['person@example.edu']),
    },
  };
  expect(
    emailProfile.validate(
      '<reply>Contact www.contact@example.org</reply>',
      context,
    ),
  ).toMatchObject({ ok: false, addresses: ['www.contact@example.org'] });
  expect(
    describeSendPrecheck({
      to: 'person@example.edu',
      body: 'Contact www.contact@example.org',
      allowlistText,
    }),
  ).toContain('www.contact@example.org');
  expect(
    emailProfile.validate('<reply>Contact www.contact@example.org</reply>', {
      allowlist: {
        ...context.allowlist,
        senders: new Set(['www.contact@example.org']),
      },
    }),
  ).toMatchObject({ ok: true });
  expect(
    emailAddressesInText(
      'https://medium.com/@jane.writer/story https://www.youtube.com/@handle.name www.example.org/search?q=person@example.edu',
    ),
  ).toEqual([]);
});

// R6-2/3: stop boundary/quote cleanup from accepting or trusting a mailbox suffix.
it.each([
  'fake|person@example.edu',
  'fake`person@example.edu',
  "'person@example.edu",
  '<person@example.edu',
  '[person@example.edu',
  'person@example.edu"',
])('preserves the complete unpaired identity %s', (address) => {
  const context = {
    allowlist: {
      available: true,
      source: 'fixture',
      senders: new Set(['person@example.edu']),
    },
  };
  expect(
    emailProfile.validate(`<reply>Contact ${address}</reply>`, context),
  ).toMatchObject({ ok: false, addresses: [address] });
  expect(
    describeSendPrecheck({
      to: 'person@example.edu',
      body: `Contact ${address}`,
      allowlistText,
    }),
  ).toContain(address);
  expect(inboundEmailAddressesInText(address)).toEqual([address]);
});

// R7-1/2: skip only an unambiguous whole URL or single-@ handle, never appended mailbox syntax.
it.each([
  'www.example.org/<contact@example.org>',
  '@handle-contact@example.org',
  '@handle.name<contact@example.org>',
  // R8-1: reject unbalanced URI grouping without hiding a separate contact.
  'www.example.org/)(contact@example.org)',
  'https://example.org/(contact@example.org!',
  // R10: require dotted nonempty hostname labels and no address-adjacent opening wrapper.
  'www./(contact@example.org)',
  'https://example.org../(contact@example.org)',
  'https://example.org/(contact@example.org)',
  'https://github.com/search?q=(person@example.edu)',
  "https://example.org/people/o'person@example.edu",
  'http://[::1]/@handle.name',
  // R9-1: ambiguous URI punctuation must not hide a separate mail link.
  'www.example.org/｜contact@example.org',
  "www.example.org/'(contact@example.org)",
])('refuses a hidden mailbox in exemption-shaped token %s', (token) => {
  const context = {
    allowlist: {
      available: true,
      source: 'fixture',
      senders: new Set(['person@example.edu']),
    },
  };
  expect(
    emailProfile.validate(`<reply>Contact ${token}</reply>`, context),
  ).toMatchObject({ ok: false, addresses: [token] });
  expect(
    describeSendPrecheck({
      to: 'person@example.edu',
      body: `Contact ${token}`,
      allowlistText,
    }),
  ).toContain(token);
});

// R7-3: structured mailto recipients are exact values, not new free-text table/markup input.
it('does not reinterpret structured HTML mailto targets as another mailbox', async () => {
  const { inboundEmailAddressesInHtml } =
    await import('./inbound-html-addresses.js');
  expect(
    inboundEmailAddressesInHtml(
      '<a href="mailto:|fake|advisor@example.org|">Advisor</a>',
    ),
  ).toEqual(['|fake|advisor@example.org|']);
  expect(
    inboundEmailAddressesInHtml(
      '<a href="mailto:mailto:advisor@example.org">Advisor</a>',
    ),
  ).toEqual(['mailto:advisor@example.org']);
});

// R7-4: parse recipient-bearing URI headers as exact values; unrelated header text must not create contacts.
it('retains exact received mailto query recipients without accepting subject substrings', async () => {
  const { inboundEmailAddressesInHtml } =
    await import('./inbound-html-addresses.js');
  expect(
    inboundEmailAddressesInHtml(
      '<a href="mailto:primary@example.org?cc=backup@example.org&amp;bcc=plus%2Btag%40example.org&amp;subject=other@example.org">Use the contacts</a>',
    ),
  ).toEqual([
    'primary@example.org',
    'backup@example.org',
    'plus+tag@example.org',
  ]);
});

// R8-2: a free-text leading pipe is an address character, not a table without a closing row edge.
it.each(['|advisor@example.org', '|fake|advisor@example.org'])(
  'preserves the complete leading-pipe identity %s outside a table',
  (address) => {
    expect(inboundEmailAddressesInText(`Cc: ${address}`)).toEqual([address]);
    expect(inboundEmailAddressesInText(`Contact ${address}`)).toEqual([
      address,
    ]);
    expect(
      describeSendPrecheck({
        to: 'person@example.edu',
        body: `Contact ${address}`,
        allowlistText,
      }),
    ).toContain(address);
  },
);

// R8-4: decoded commas delimit supplied recipients except inside an actual quoted local part.
it.each(['to', 'cc', 'bcc'])(
  'keeps both received recipients in encoded %s mailto lists',
  async (field) => {
    const { inboundEmailAddressesInHtml } =
      await import('./inbound-html-addresses.js');
    expect(
      inboundEmailAddressesInHtml(
        `<a href="mailto:primary@example.org?${field}=backup%40example.org%2Csecond%40example.org">Contact</a>`,
      ),
    ).toEqual([
      'primary@example.org',
      'backup@example.org',
      'second@example.org',
    ]);
  },
);
it('preserves a decoded quoted comma inside its exact mailbox while retaining the next recipient', async () => {
  const { inboundEmailAddressesInHtml } =
    await import('./inbound-html-addresses.js');
  expect(
    inboundEmailAddressesInHtml(
      '<a href="mailto:primary@example.org?cc=%22last%2Cfirst%22%40example.org%2Csecond%40example.org">Contact</a>',
    ),
  ).toEqual([
    'primary@example.org',
    '"last,first"@example.org',
    'second@example.org',
  ]);
});

// R9-2: a quoted mailbox with whitespace is one exact identifier, never its final word.
it.each([
  '"team lead"@example.org',
  '<"team lead"@example.org>',
  'mailto:"team lead"@example.org',
])('preserves complete quoted mailbox %s for exact trust comparison', (raw) => {
  const address = '"team lead"@example.org';
  expect(inboundEmailAddressesInText(`Contact ${raw}`)).toEqual([address]);
  expect(
    emailProfile.validate(`<reply>Contact ${raw}</reply>`, {
      allowlist: {
        available: true,
        source: 'fixture',
        senders: new Set(['person@example.edu']),
      },
      trustedBodyAddresses: [address],
    }),
  ).toMatchObject({ ok: true });
  const warning = describeSendPrecheck({
    to: 'person@example.edu',
    body: `Contact ${raw}`,
    allowlistText,
  });
  expect(warning).toContain(raw);
  expect(warning).not.toContain('unverified-email-address: lead');
});

// R10: hostname validation must work even without a parenthesized mailbox path.
it.each([
  'www./contact@example.org',
  'https://example..org/contact@example.org',
  'https://example.org./contact@example.org',
  'https://localhost/contact@example.org',
])(
  'refuses an exempt-shaped token with a dotless or empty-label hostname: %s',
  (token) => {
    expect(
      emailProfile.validate(`<reply>Contact ${token}</reply>`, {
        allowlist: {
          available: true,
          source: 'fixture',
          senders: new Set(['person@example.edu']),
        },
      }),
    ).toMatchObject({ ok: false, addresses: [token] });
    expect(
      describeSendPrecheck({
        to: 'person@example.edu',
        body: `Contact ${token}`,
        allowlistText,
      }),
    ).toContain(token);
  },
);

// R11-1: Unicode separators/full-width @ must be detected before both host and container exemptions.
it.each([
  ['contact@example。org', 'contact@example.org'],
  ['contact@example．org', 'contact@example.org'],
  ['contact@example｡org', 'contact@example.org'],
  ['contact＠example.org', 'contact@example.org'],
  ['contact@example﹒org', 'contact@example.org'],
  ['ｃｏｎｔａｃｔ＠ｅｘａｍｐｌｅ．ｏｒｇ', 'contact@example.org'],
])(
  'refuses untrusted Unicode token %s and records only its normalized inbound identity',
  (raw, normalized) => {
    for (const body of [`Contact ${raw}`, `Please email ${raw} for details.`]) {
      expect(
        emailProfile.validate(`<reply>${body}</reply>`, {
          allowlist: {
            available: true,
            source: 'fixture',
            senders: new Set(['person@example.edu']),
          },
          inboundText: [],
        }),
      ).toMatchObject({
        ok: false,
        reason: 'unverified-email-address',
        addresses: [raw],
      });
      expect(
        describeSendPrecheck({
          to: 'person@example.edu',
          body,
          allowlistText,
        }),
      ).toContain(raw);
      expect(inboundEmailAddressesInText(body)).toEqual([normalized]);
    }
  },
);

// R11-1: changed tokens require the exact normalized address, not just any approved recipient.
it.each([
  'avery@example。edu',
  'avery@example．edu',
  'avery@example｡edu',
  'avery＠example.edu',
])(
  'checks normalized %s against exact ASCII trust in earlier checks and container',
  (raw) => {
    const body = `Contact ${raw}`;
    const context = {
      allowlist: {
        available: true,
        source: 'fixture',
        senders: new Set(['person@example.edu']),
      },
      inboundText: [],
    };
    expect(
      emailProfile.validate(`<reply>${body}</reply>`, context),
    ).toMatchObject({ ok: false, addresses: [raw] });
    expect(
      emailProfile.validate(`<reply>${body}</reply>`, {
        ...context,
        allowlist: {
          ...context.allowlist,
          senders: new Set(['avery@example.edu']),
        },
      }),
    ).toMatchObject({ ok: true, text: body });
    expect(
      emailProfile.validate(`<reply>${body}</reply>`, {
        ...context,
        inboundText: ['Received contact avery@example。edu'],
      }),
    ).toMatchObject({ ok: true, text: body });
    expect(
      describeSendPrecheck({ to: 'person@example.edu', body, allowlistText }),
    ).toContain(raw);
    expect(
      describeSendPrecheck({
        to: 'avery@example.edu',
        body,
        allowlistText: '| Avery | avery@example.edu |',
      }),
    ).toBe('');
  },
);

// R11-1: received HTML text and exact structured mailto values use the same identity normalization.
it('normalizes Unicode contacts in received HTML without creating substring evidence', async () => {
  const { inboundEmailAddressesInHtml } =
    await import('./inbound-html-addresses.js');
  expect(
    inboundEmailAddressesInHtml(
      '<p>Contact text@example。org</p><a href="mailto:primary＠example｡org?cc=backup%40example%EF%BC%8Eorg">Contact</a>',
    ),
  ).toEqual(['primary@example.org', 'backup@example.org', 'text@example.org']);
  expect(
    inboundEmailAddressesInHtml(
      '<a href="mailto:|fake|contact＠example。org|">Contact</a>',
    ),
  ).toEqual(['|fake|contact@example.org|']);
});

// R11-1: normalized intake still grants the underscore variant only for paired runs.
it('normalizes incoming underscore-wrapped identities without trimming unpaired markup', () => {
  expect(inboundEmailAddressesInText('__avery＠example。edu__')).toEqual([
    '__avery@example.edu__',
    'avery@example.edu',
  ]);
  expect(inboundEmailAddressesInText('_avery＠example。edu')).toEqual([
    '_avery@example.edu',
  ]);
});
