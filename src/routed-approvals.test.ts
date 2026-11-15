import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import type {
  OutboundEmail,
  SendOutboundEmailOptions,
} from './outbound-email.js';
import {
  buildRelayEmail,
  createRoutedApprovalService,
  dbRoutedApprovalStore,
  maskRoutedActionItems,
  parseRoutedApprovals,
  quoteFoundIn,
  isAccessChange,
  relayDeliveryId,
  relayRefusal,
  resolveRouteApprover,
  ROUTED_REMINDER_MS,
  summarizeRoutedApprovals,
  type RelayPeek,
  type RoutedApprovalDeps,
} from './routed-approvals.js';

// Row wording follows the program/EMAIL_ALLOWLIST.md format.
const ALLOWLIST = `
## Authorized Senders (Program operating team)

| Name | Email | Title | Access | Role / domain (gatekeeping) |
|------|-------|-------|--------|------------------------------|
| Avery Morgan | avery@example.edu | Faculty | read-write | Program Director · **gate approver: content** · **coordinator-cohort: founding** |
| Omar Haddad | ohaddad@example.edu | Staff | read-write | Program oversight · **coordinator-cohort: founding** |
| Omar Junior | ohaddad2@example.edu | Staff | read-write | A netid that starts with ohaddad · **coordinator-cohort: test** |
| Tessa Bower | user104@example.edu | Staff | read-write | Student services · **coordinator-cohort: founding** |
| Jonas Berg | berg@example.edu | Faculty | read-write | Faculty (ELC 550) · **coordinator-cohort: faculty-expansion** |
| June Hale | jhl@example.edu | Admissions | read-only | Admissions. Any updates she sends route to **Omar Haddad (ohaddad)** for approval · **coordinator-cohort: team-expansion** |
| Martin (Marty) Webb | user105@example.edu | Advisor | read-only | Advising. Any updates Marty sends route through Tessa Bower (user104) · **coordinator-cohort: team-expansion** |
| Two Routes | tworoutes@example.edu | Staff | read-only | Updates route to **Omar Haddad (ohaddad)**; urgent ones route through Tessa Bower (user104) · **coordinator-cohort: test** |
| Ghost Route | ghost@example.edu | Staff | read-only | Updates route to **Nobody Here (nobody9)** · **coordinator-cohort: test** |
| Walter Oakes | user112@example.edu | Faculty | read-only | Research observer · **coordinator-cohort: observer** |
| Avery Morgan (PeerAgent Agent) | averybot@gmail.com | agent | read-write | Agent · **coordinator-cohort: agent** |

> **Retired access (revoked, no longer authorized):**
> | Greta Nash | user111@example.edu | Staff | read-write | Updates route to Omar Haddad (ohaddad) |
`;

const JUNE_RAW =
  'discussions/raw/2026-09-14-windows-1252-q-re-program-action-items-97-weekly-check-in-1445.md';

// Shape of a sender's reply: answers inline after
// Coordinator's numbered list. The Worker Markdown lost the Windows-1252 dashes
// ("cohort  assess"); the parsed .eml keeps them ("cohort — assess").
const JUNE_MD_TEXT = `See progress below in Yellow.

1. Review the pilot survey outcomes for the first group  assess initial survey results; continue monitoring response progress. (Added 2030-01-07; in progress as of 2030-01-21) This is complete

3. Work with Moira to place the sample documents in a shared folder for review  once completed, connect with Avery. (Added 2030-01-07) This is resolved and Paige and Tessa were working on adding a short question to a form already being used with Program learners.

6. Determine whether Elsa and Nolan are ready to receive Coordinator access and follow up with Tessa  assess readiness for additional staff access. (Added 2030-02-04) We decided to hold off and only add Moira and not add Elsa and Nolan to Coordinator.`;
const JUNE_EML_TEXT = JUNE_MD_TEXT.replace(/ {2}assess/g, ' — assess');

function juneEntry(
  overrides: {
    second?: string;
    approver?: string;
    sender?: string;
    quote?: string;
    raw?: string;
    box?: string;
  } = {},
): string {
  return [
    `- [${overrides.box ?? ' '}] **Routed to Omar Haddad (ohaddad): Re: Program Action Items — Weekly Check-in** (Sender: ${overrides.sender ?? 'jhl@example.edu'}; Approver: ${overrides.approver ?? 'ohaddad@example.edu'}; Raw: ${overrides.raw ?? JUNE_RAW}) (Added: 2026-09-14)`,
    `  - Sender's words: "${overrides.quote ?? 'Review the pilot survey outcomes for the first group — assess initial survey results; continue monitoring response progress. (Added 2030-01-07; in progress as of 2030-01-21) This is complete'}"`,
    `  - Sender's words: "${overrides.second ?? 'This is resolved and Paige and Tessa were working on adding a short question to a form already being used with Program learners.'}"`,
    `  - Affects: ACTION_ITEMS.md § June Hale — **Review the pilot survey outcomes for the first group**`,
  ].join('\n');
}

function openQuestions(...entries: string[]): string {
  return [
    '# Open questions',
    '',
    '## Earlier section',
    '',
    '- [ ] **Unrelated question** — not routed (Added: 2026-10-01)',
    '',
    '## Routed Approvals',
    '',
    'Items Coordinator has told a sender are waiting on an approver (G37, G42).',
    '',
    ...entries,
    '',
    '## Planning Meeting (2026-10-21)',
    '',
    '- [ ] **Second-group sequencing** — open (Added: 2026-10-22)',
  ].join('\n');
}

describe('parseRoutedApprovals', () => {
  it('reads only the Routed Approvals section, with fields, quotes and affects', () => {
    const entries = parseRoutedApprovals(openQuestions(juneEntry()));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: JUNE_RAW,
      open: true,
      sender: 'jhl@example.edu',
      approver: 'ohaddad@example.edu',
      rawPath: JUNE_RAW,
      added: '2026-09-14',
      affects: [
        {
          file: 'ACTION_ITEMS.md',
          section: 'June Hale',
          title: 'Review the pilot survey outcomes for the first group',
        },
      ],
    });
    expect(entries[0].quotes).toHaveLength(2);
    expect(entries[0].quotes[1]).toBe(
      'This is resolved and Paige and Tessa were working on adding a short question to a form already being used with Program learners.',
    );
  });

  it('treats [x] and a ✅ Closed annotation as closed', () => {
    const closedBox = parseRoutedApprovals(
      openQuestions(juneEntry({ box: 'x' })),
    );
    expect(closedBox[0].open).toBe(false);
    const annotated = parseRoutedApprovals(
      openQuestions(
        `${juneEntry()}\n  - ✅ Closed 2026-09-20 per Omar Haddad: approved`,
      ),
    );
    expect(annotated[0]).toMatchObject({ open: false, closedOn: '2026-09-20' });
  });

  it('gives an entry without a Raw path a stable noraw key', () => {
    const line =
      '- [ ] **Routed to Avery: something** (Sender: a@example.edu; Approver: avery@example.edu)';
    const a = parseRoutedApprovals(
      openQuestions(`${line} (Added: 2026-10-01)`),
    );
    const b = parseRoutedApprovals(
      openQuestions(`${line} (Added: 2026-10-02)`),
    );
    expect(a[0].key).toMatch(/^noraw:/);
    expect(a[0].key).toBe(b[0].key);
  });

  it('ignores a format example inside a code block', () => {
    const md = openQuestions(
      '```',
      '- [ ] **Routed to <Approver name> (<netid>): <topic>** (Sender: <a>; Approver: <b>; Raw: <raw email path>) (Added: YYYY-MM-DD)',
      '  - Sender\'s words: "<an exact passage>"',
      '```',
      juneEntry(),
    );
    const entries = parseRoutedApprovals(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe(JUNE_RAW);
  });

  it('returns nothing when the section is absent', () => {
    expect(
      parseRoutedApprovals('# Open questions\n\n- [ ] **x** (Raw: a.md)'),
    ).toEqual([]);
  });
});

describe('resolveRouteApprover', () => {
  it('routes a read-only sender to the netid named in their row', () => {
    const r = resolveRouteApprover(
      ALLOWLIST,
      'jhl@example.edu',
      'ohaddad@example.edu',
    );
    expect(r).toMatchObject({
      ok: true,
      basis: 'row-route',
      approver: { name: 'Omar Haddad', email: 'ohaddad@example.edu' },
      sender: { name: 'June Hale', email: 'jhl@example.edu' },
    });
  });

  it('accepts the bare netid as the entry approver', () => {
    const r = resolveRouteApprover(ALLOWLIST, 'user105@example.edu', 'user104');
    expect(r).toMatchObject({
      ok: true,
      approver: { email: 'user104@example.edu' },
    });
  });

  it('routes a sender with no route to Avery', () => {
    const r = resolveRouteApprover(
      ALLOWLIST,
      'berg@example.edu',
      'avery@example.edu',
    );
    expect(r).toMatchObject({
      ok: true,
      basis: 'no-route',
      approver: { email: 'avery@example.edu' },
    });
  });

  it('accepts Avery for an item the sender addressed to him, even with a route', () => {
    const r = resolveRouteApprover(ALLOWLIST, 'jhl@example.edu', 'avery');
    expect(r).toMatchObject({ ok: true, basis: 'addressed-to-avery' });
  });

  it('holds when the entry names someone the row does not route to', () => {
    const r = resolveRouteApprover(
      ALLOWLIST,
      'jhl@example.edu',
      'user104@example.edu',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('routes to ohaddad@example.edu');
  });

  it('holds on two routes, an unknown netid, an agent, an unknown sender, or no approver', () => {
    expect(
      resolveRouteApprover(ALLOWLIST, 'tworoutes@example.edu', 'ohaddad').ok,
    ).toBe(false);
    expect(
      resolveRouteApprover(ALLOWLIST, 'ghost@example.edu', 'nobody9').ok,
    ).toBe(false);
    expect(
      resolveRouteApprover(ALLOWLIST, 'averybot@gmail.com', 'avery').ok,
    ).toBe(false);
    expect(
      resolveRouteApprover(ALLOWLIST, 'stranger@example.edu', 'avery').ok,
    ).toBe(false);
    expect(
      resolveRouteApprover(ALLOWLIST, 'jhl@example.edu', undefined).ok,
    ).toBe(false);
  });

  it('ignores retired rows', () => {
    expect(
      resolveRouteApprover(ALLOWLIST, 'user111@example.edu', 'ohaddad').ok,
    ).toBe(false);
  });
});

describe('quoteFoundIn', () => {
  it('matches across the lost Windows-1252 dash', () => {
    expect(
      quoteFoundIn('first group — assess initial survey', [JUNE_MD_TEXT]),
    ).toBe(true);
    expect(quoteFoundIn('first group  assess initial', [JUNE_EML_TEXT])).toBe(
      true,
    );
  });

  it('refuses a paraphrase, an ellipsis splice, and a quote under 3 words', () => {
    expect(
      quoteFoundIn('June says the survey review is done', [JUNE_MD_TEXT]),
    ).toBe(false);
    expect(
      quoteFoundIn('Review the pilot ... This is complete', [JUNE_MD_TEXT]),
    ).toBe(false);
    expect(quoteFoundIn('is complete', [JUNE_MD_TEXT])).toBe(false);
  });

  it('applies NFKC, so full-width letters compare as their plain form', () => {
    expect(quoteFoundIn('Ｔｈｉｓ ｉｓ ｃｏｍｐｌｅｔｅ', [JUNE_MD_TEXT])).toBe(
      true,
    );
  });
});

describe('relayRefusal (check d)', () => {
  const approver = {
    approverEmail: 'ohaddad@example.edu',
    approverName: 'Omar Haddad',
  };
  it('allows relays 1 and 2 in order', () => {
    expect(relayRefusal({ ...approver, relayCount: 0 }, 1)).toBeUndefined();
    expect(relayRefusal({ ...approver, relayCount: 1 }, 2)).toBeUndefined();
  });
  it('refuses a third relay, a repeat, a skipped number, and an unresolved approver', () => {
    expect(relayRefusal({ ...approver, relayCount: 2 }, 3)).toContain(
      'the cap is 2',
    );
    expect(relayRefusal({ ...approver, relayCount: 1 }, 1)).toContain(
      '1 already sent',
    );
    expect(relayRefusal({ ...approver, relayCount: 0 }, 2)).toContain(
      '0 already sent',
    );
    expect(relayRefusal({ relayCount: 0 }, 1)).toContain(
      'no resolved approver',
    );
  });
});

describe('buildRelayEmail', () => {
  it('is a fixed template around the quotes', () => {
    const msg = buildRelayEmail({
      approver: { name: 'Omar Haddad', email: 'ohaddad@example.edu' },
      sender: { name: 'June Hale', email: 'jhl@example.edu' },
      subject: 'Re: Program Action Items — Weekly Check-in',
      quotes: ['This is complete and more'],
      receivedAt: Date.parse('2026-09-14T19:45:00Z'),
      relayNumber: 1,
    });
    expect(msg.subject).toBe(
      'For your approval: Program Action Items — Weekly Check-in',
    );
    expect(msg.body).toContain('Hi Omar,');
    expect(msg.body).toContain(
      'June Hale (jhl@example.edu) sent Coordinator an update on September 14, 2026',
    );
    expect(msg.body).toContain('"This is complete and more"');
    expect(msg.body).toContain('June is copied.');
  });
});

describe('maskRoutedActionItems', () => {
  const ACTION_ITEMS = [
    '# Action items',
    '',
    '## June Hale',
    '- [ ] **Review the pilot survey outcomes for the first group** — assess results (Added 2030-01-07)',
    '- [ ] **Schedule discussion with Omar regarding future survey plans** — later',
    '',
    '## Avery Morgan',
    '- [ ] **Review the pilot survey outcomes for the first group** — same title, other owner',
  ].join('\n');

  it('skips a routed-and-pending item; an unrelated open item for the same person still counts (check b)', () => {
    const masked = maskRoutedActionItems(
      ACTION_ITEMS,
      openQuestions(juneEntry()),
    );
    expect(masked.skipped).toEqual([
      {
        section: 'June Hale',
        title: 'Review the pilot survey outcomes for the first group',
        entry:
          'Routed to Omar Haddad (ohaddad): Re: Program Action Items — Weekly Check-in',
      },
    ]);
    const june = masked.markdown.split('## Avery Morgan')[0];
    expect(june.match(/^- \[ \]/gm)).toHaveLength(1);
    expect(june).toContain('- [ ] **Schedule discussion with Omar');
    // Same title under another owner is not touched.
    expect(masked.markdown.split('## Avery Morgan')[1]).toContain(
      '- [ ] **Review the pilot',
    );
  });

  it('counts the item again once the entry is closed', () => {
    const masked = maskRoutedActionItems(
      ACTION_ITEMS,
      openQuestions(juneEntry({ box: 'x' })),
    );
    expect(masked.skipped).toEqual([]);
    expect(masked.markdown).toBe(ACTION_ITEMS);
  });
});

describe('summarizeRoutedApprovals', () => {
  it('lists open entries and counts opened and closed in the window', () => {
    const md = openQuestions(
      juneEntry(),
      juneEntry({ raw: 'discussions/raw/other.md', box: 'x' }).replace(
        '(Added: 2026-09-14)',
        '(Added: 2026-10-20)',
      ) + '\n  - ✅ Closed 2026-10-22 per Omar Haddad: approved',
    );
    const s = summarizeRoutedApprovals(md, '2026-10-18');
    expect(s.open).toHaveLength(1);
    expect(s.open[0]).toMatchObject({
      sender: 'jhl@example.edu',
      added: '2026-09-14',
    });
    expect(s.openedInWindow).toBe(1);
    expect(s.closedInWindow).toBe(1);
  });
});

// --- Service ---------------------------------------------------------------

interface Harness {
  deps: RoutedApprovalDeps;
  sent: Array<{ email: OutboundEmail; opts: SendOutboundEmailOptions }>;
  pings: string[];
  audits: Array<{ action: string; key: string }>;
  outbox: Map<string, RelayPeek>;
  refreshes: { count: number };
  setMd(md: string): void;
  advance(ms: number): void;
  /** sent | fail (permanent) | retry (outbox keeps retrying) | throw (crash before the outbox row) */
  sendResult: { value: 'sent' | 'fail' | 'retry' | 'throw' };
  pingResult: { value: 'sent' | 'failed-transient' };
}

function harness(): Harness {
  let md = openQuestions();
  let clock = Date.parse('2026-09-14T20:00:00Z');
  const sent: Harness['sent'] = [];
  const pings: string[] = [];
  const audits: Harness['audits'] = [];
  const outbox = new Map<string, RelayPeek>();
  const refreshes = { count: 0 };
  const sendResult = { value: 'sent' as Harness['sendResult']['value'] };
  const pingResult = { value: 'sent' as 'sent' | 'failed-transient' };
  const deps: RoutedApprovalDeps = {
    store: dbRoutedApprovalStore,
    readOpenQuestions: async () => md,
    readAllowlist: async () => ALLOWLIST,
    sendEmail: async (email, opts) => {
      if (sendResult.value === 'throw') throw new Error('process stopped');
      sent.push({ email, opts });
      const id = opts.deliveryId!;
      if (sendResult.value === 'retry') {
        outbox.set(id, { state: 'pending' });
        return { status: 'failed', reason: 'resend-503', retryable: true };
      }
      const result =
        sendResult.value === 'sent'
          ? ({ status: 'sent', resendId: `re_${sent.length}` } as const)
          : ({
              status: 'failed',
              reason: 'resend-500',
              retryable: false,
            } as const);
      outbox.set(id, { state: 'done', result });
      return result;
    },
    peekRelay: (id) => outbox.get(id) ?? { state: 'none' },
    cancelRelay: (id, reason) => {
      if (outbox.get(id)?.state !== 'pending') return false;
      outbox.set(id, {
        state: 'done',
        result: { status: 'failed', reason, retryable: false },
      });
      return true;
    },
    refreshMirror: async () => {
      refreshes.count++;
    },
    pingOwner: async (text) => {
      pings.push(text);
      return pingResult.value;
    },
    audit: (e) => audits.push({ action: e.action, key: e.key }),
    now: () => clock,
  };
  return {
    deps,
    sent,
    pings,
    audits,
    outbox,
    refreshes,
    setMd: (next) => {
      md = next;
    },
    advance: (ms) => {
      clock += ms;
    },
    sendResult,
    pingResult,
  };
}

function juneEvidence(service: ReturnType<typeof createRoutedApprovalService>) {
  service.recordEvidence({
    rawPath: JUNE_RAW,
    sender: 'JHL@example.edu',
    subject: 'Re: Program Action Items — Weekly Check-in',
    messageId: '<june-0914@example.edu>',
    receivedAt: Date.parse('2026-09-14T19:45:00Z'),
    texts: [JUNE_MD_TEXT, JUNE_EML_TEXT],
  });
}

describe('routed approval service', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it("replays June's 2026-09-14 email: relay to ohaddad, CC jhl, one Telegram notice (check c)", async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));

    await service.scanSoon();

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].email).toMatchObject({
      to: 'ohaddad@example.edu',
      cc: 'jhl@example.edu',
      subject: 'For your approval: Program Action Items — Weekly Check-in',
    });
    expect(h.sent[0].email.body).toContain(
      'This is resolved and Paige and Tessa were working on adding a short question',
    );
    expect(h.sent[0].opts).toMatchObject({
      sourceGroup: 'routed-approval',
      forceBotReplyTo: true,
      deliveryId: relayDeliveryId(JUNE_RAW, 1),
    });
    expect(h.pings).toHaveLength(1);
    expect(h.pings[0]).toContain('Coordinator routed approval (G42)');
    expect(h.pings[0]).toContain('Relays sent to the approver: 1 of 2');
    expect(h.audits.map((a) => a.action)).toEqual(['recorded', 'relay 1 sent']);

    // A second scan of the same KB sends nothing more.
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.pings).toHaveLength(1);
  });

  it('holds and tells Avery when the quote is not in the email', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(
      openQuestions(
        juneEntry({
          quote: 'June approves the new survey budget of 50000 dollars',
        }),
      ),
    );
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings[0]).toContain(
      "HELD, nothing was sent: a quote is not in the sender's email",
    );
  });

  it('holds when the entry names a different approver than the allowlist row', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry({ approver: 'user104@example.edu' })));
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings[0]).toContain('HELD');
    expect(h.pings[0]).toContain('routes to ohaddad@example.edu');
  });

  it("holds when the entry's sender is not who the raw email came from", async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry({ sender: 'user105@example.edu' })));
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings[0]).toContain('came from jhl@example.edu');
  });

  it('holds when the host has no intake record for the raw path', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings[0]).toContain('no intake record');
  });

  it('sends nothing for an entry already closed when first seen', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry({ box: 'x' })));
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings).toHaveLength(0);
  });

  it('day 3: one reminder relay; then Telegram to Avery every 3 days; a third relay is never sent (check d)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);

    h.advance(ROUTED_REMINDER_MS - 60_000);
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);

    h.advance(60_000);
    await service.scanSoon();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].email.subject).toBe(
      'Reminder, for your approval: Program Action Items — Weekly Check-in',
    );
    expect(h.sent[1].opts.deliveryId).toBe(relayDeliveryId(JUNE_RAW, 2));
    expect(h.pings).toHaveLength(1);

    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.sent).toHaveLength(2);
    expect(h.pings).toHaveLength(2);
    expect(h.pings[1]).toContain('still open after 6 days');

    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.sent).toHaveLength(2);
    expect(h.pings).toHaveLength(3);

    // Closing stops everything.
    h.setMd(
      openQuestions(
        `${juneEntry()}\n  - ✅ Closed 2026-09-24 per Omar Haddad: approved`,
      ),
    );
    await service.scanSoon();
    h.advance(ROUTED_REMINDER_MS * 3);
    await service.scanSoon();
    expect(h.sent).toHaveLength(2);
    expect(h.pings).toHaveLength(3);
    expect(h.audits.map((a) => a.action)).toContain('closed');
  });

  it('retries the creation notice when Telegram fails, without resending the relay', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.pingResult.value = 'failed-transient';
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.pings).toHaveLength(1);

    h.pingResult.value = 'sent';
    h.advance(60 * 60 * 1000);
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.pings).toHaveLength(2);
    expect(h.pings[1]).toContain('Coordinator routed approval (G42)');

    h.advance(60 * 60 * 1000);
    await service.scanSoon();
    expect(h.pings).toHaveLength(2);
  });

  it('reports a failed relay to Avery and keeps reminding him', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'fail';
    await service.scanSoon();
    expect(h.pings[0]).toContain('The relay email failed: resend-500');
    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.pings).toHaveLength(2);
  });

  it('resumes an initial relay that never reached the outbox (codex P1)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'throw';
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings[0]).toContain('The relay to the approver is queued');

    h.sendResult.value = 'sent';
    h.advance(60 * 60 * 1000);
    await createRoutedApprovalService(h.deps).scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].opts.deliveryId).toBe(relayDeliveryId(JUNE_RAW, 1));
    expect(h.audits.map((a) => a.action)).toContain('relay 1 sent');
  });

  it('leaves a retrying relay to the outbox and records it once it lands (codex P2)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.pings[0]).not.toContain('failed');

    // Still retrying: no second submission.
    h.advance(60 * 60 * 1000);
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);

    // The outbox delivers it later.
    h.outbox.set(relayDeliveryId(JUNE_RAW, 1), {
      state: 'done',
      result: { status: 'sent', resendId: 're_late' },
    });
    await service.scanSoon();
    expect(h.audits.map((a) => a.action)).toContain('relay 1 sent');

    // ...so the day-3 reminder still goes.
    h.sendResult.value = 'sent';
    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].opts.deliveryId).toBe(relayDeliveryId(JUNE_RAW, 2));
  });

  it('marks a relay failed when the outbox gives up on it', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    h.outbox.set(relayDeliveryId(JUNE_RAW, 1), {
      state: 'done',
      result: { status: 'failed', reason: 'dead-letter', retryable: false },
    });
    await service.scanSoon();
    expect(h.pings[1]).toContain('Coordinator routed approval relay failed');
    expect(h.pings[1]).toContain('dead-letter');
  });

  it('sends the day-3 approver reminder even while Telegram is down (codex P2)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.pingResult.value = 'failed-transient';
    await service.scanSoon();
    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.sent).toHaveLength(2);
  });

  it('keeps notices that did not fit in one message owed for the next scan (codex P2)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    const longTopic = 'x'.repeat(250);
    const entries = Array.from({ length: 20 }, (_, i) =>
      juneEntry({ raw: `discussions/raw/forged-${i}.md` }).replace(
        'Re: Program Action Items — Weekly Check-in**',
        `${longTopic} ${i}**`,
      ),
    );
    h.setMd(openQuestions(...entries));
    for (
      let i = 0;
      i < 10 && h.pings.join('').split('HELD').length - 1 < 20;
      i++
    ) {
      await service.scanSoon();
      h.advance(60 * 60 * 1000);
    }
    expect(h.pings.length).toBeGreaterThan(1);
    expect(h.pings[0]).toContain('more routed-approval notices follow');
    expect(h.pings.every((p) => p.length <= 4096)).toBe(true);
    const delivered = h.pings.join('\n').split('HELD').length - 1;
    expect(delivered).toBe(20);
  });

  it('retries a removal notice after a failed Telegram send (codex P2)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon();
    h.setMd(openQuestions());
    h.pingResult.value = 'failed-transient';
    await service.scanSoon();
    h.pingResult.value = 'sent';
    await service.scanSoon();
    expect(h.pings.at(-1)).toContain('removed without being closed');
    await service.scanSoon();
    expect(h.pings.filter((p) => p.includes('removed without')).length).toBe(2);
  });

  it('does not read a quoted "✅ Closed" as the entry being closed (codex r2)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    service.recordEvidence({
      rawPath: JUNE_RAW,
      sender: 'jhl@example.edu',
      subject: 'Status',
      receivedAt: Date.parse('2026-09-14T19:45:00Z'),
      texts: [
        'The webinar task is ✅ Closed 2026-10-24 and ready for approval.',
      ],
    });
    h.setMd(
      openQuestions(
        juneEntry({
          quote:
            'The webinar task is ✅ Closed 2026-10-24 and ready for approval.',
        }).replace(/\n {2}- Sender's words: "This is resolved[^\n]*/, ''),
      ),
    );
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
  });

  it('cancels a relay still retrying when the entry is closed (codex r2)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    h.setMd(openQuestions(juneEntry({ box: 'x' })));
    await service.scanSoon();
    expect(h.outbox.get(relayDeliveryId(JUNE_RAW, 1))).toMatchObject({
      state: 'done',
      result: { status: 'failed', reason: 'cancelled: the entry was closed' },
    });
    expect(h.audits.map((a) => a.action)).toContain('relay 1 cancelled');
  });

  it('never resends a relay whose outbox record expired before it was recorded (codex r2)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    h.outbox.clear(); // retention compaction after a long outage
    h.sendResult.value = 'sent';
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.pings.at(-1)).toContain('outcome unknown');
  });

  it('refreshes the mirror on the hourly fallback scan only (codex r2)', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const service = createRoutedApprovalService(h.deps);
      await service.scanSoon();
      expect(h.refreshes.count).toBe(0);
      service.start(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.refreshes.count).toBe(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds an access change addressed to anyone but Avery (codex r3, G39)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(
      openQuestions(
        juneEntry({
          second:
            'We decided to hold off and only add Moira and not add Elsa and Nolan to Coordinator.',
        }),
      ),
    );
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings[0]).toContain(
      'access or role change, which only Avery decides',
    );
  });

  it('treats punctuation variants of an access change alike (codex r8)', () => {
    for (const q of [
      'Please add Moira to Co–ordinator.',
      'Please add Moira to Co.ordinator.',
      'Please add Moira to Coordinator.',
      'She should get read‑write access.',
      'Add her to the allow-list please.',
      'We decided to hold off and only add Moira and not add Elsa and Nolan to Coordinator.',
    ]) {
      expect(isAccessChange(q), q).toBe(true);
    }
    for (const q of [
      'This is complete',
      'Review the pilot survey outcomes for the first group',
      'The webinar series moves to Thursdays starting in November.',
    ]) {
      expect(isAccessChange(q), q).toBe(false);
    }
  });

  it('holds an en-dash "Co–ordinator" access request addressed to the normal approver (codex r8)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    service.recordEvidence({
      rawPath: JUNE_RAW,
      sender: 'jhl@example.edu',
      subject: 'Access',
      receivedAt: Date.parse('2026-09-14T19:45:00Z'),
      texts: ['Please add Moira to Co–ordinator as soon as you can.'],
    });
    h.setMd(
      openQuestions(
        juneEntry({
          quote: 'Please add Moira to Co–ordinator as soon as you can.',
        }).replace(/\n {2}- Sender's words: "This is resolved[^\n]*/, ''),
      ),
    );
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings[0]).toContain('access or role change');
  });

  it('sends no reminder while OPEN_QUESTIONS.md cannot be read (codex r8)', async () => {
    const h = harness();
    let md: string | null = openQuestions(juneEntry());
    const service = createRoutedApprovalService({
      ...h.deps,
      readOpenQuestions: async () => md,
    });
    juneEvidence(service);
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    md = null;
    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    md = openQuestions(juneEntry());
    await service.scanSoon();
    expect(h.sent).toHaveLength(2);
  });

  it('waits for the whole startup reconcile, even a slow refresh (codex r8)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    h.setMd(openQuestions(juneEntry({ box: 'x' })));
    const restarted = createRoutedApprovalService({
      ...h.deps,
      refreshMirror: () => new Promise((resolve) => setTimeout(resolve, 50)),
    });
    await restarted.reconcileBeforeReplay();
    expect(h.outbox.get(relayDeliveryId(JUNE_RAW, 1))).toMatchObject({
      state: 'done',
      result: { reason: 'cancelled: the entry was closed' },
    });
  });

  it('relays an access change to Avery when the entry names him', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(
      openQuestions(
        juneEntry({
          approver: 'avery@example.edu',
          second:
            'We decided to hold off and only add Moira and not add Elsa and Nolan to Coordinator.',
        }),
      ),
    );
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].email.to).toBe('avery@example.edu');
  });

  it('holds the day-3 reminder when the allowlist route has changed (codex r3)', async () => {
    const h = harness();
    let allowlist = ALLOWLIST;
    const service = createRoutedApprovalService({
      ...h.deps,
      readAllowlist: async () => allowlist,
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);

    allowlist = ALLOWLIST.replace(
      'route to **Omar Haddad (ohaddad)** for approval',
      'route through Tessa Bower (user104)',
    );
    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.pings.at(-1)).toContain('Coordinator routed approval held');
    expect(h.pings.at(-1)).toContain('routes to user104@example.edu');
    // The confirmed first send is not denied.
    expect(h.pings.at(-1)).toContain('HELD, no further relay');
    expect(h.pings.at(-1)).toContain('The first email went to the approver on');
    expect(h.pings.at(-1)).not.toContain('nothing was sent');
  });

  it('cancels a queued relay when the route changes before it goes (codex r4)', async () => {
    const h = harness();
    let allowlist = ALLOWLIST;
    const service = createRoutedApprovalService({
      ...h.deps,
      readAllowlist: async () => allowlist,
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    expect(h.outbox.get(relayDeliveryId(JUNE_RAW, 1))).toEqual({
      state: 'pending',
    });
    allowlist = ALLOWLIST.replace(
      'route to **Omar Haddad (ohaddad)** for approval',
      'route through Tessa Bower (user104)',
    );
    await service.scanSoon();
    expect(h.outbox.get(relayDeliveryId(JUNE_RAW, 1))).toMatchObject({
      state: 'done',
      result: { reason: 'cancelled: the approval route changed' },
    });
    expect(h.pings.at(-1)).toContain('HELD, nothing was sent');
  });

  it('says the first email went when only the reminder failed (codex r3)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon();
    h.sendResult.value = 'fail';
    h.advance(ROUTED_REMINDER_MS);
    await service.scanSoon();
    expect(h.pings.at(-1)).toContain('The reminder email failed');
    expect(h.pings.at(-1)).toContain(
      'The first email went to the approver on September 14, 2026',
    );
    expect(h.pings.at(-1)).not.toContain('has not been told');
  });

  it('does not let a relay queued behind other mail block cancellation (codex r5)', async () => {
    const h = harness();
    let release!: (r: {
      status: 'failed';
      reason: string;
      retryable: false;
    }) => void;
    const service = createRoutedApprovalService({
      ...h.deps,
      relayWaitMs: 5,
      sendEmail: (email, opts) => {
        h.sent.push({ email, opts });
        h.outbox.set(opts.deliveryId!, { state: 'pending' });
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon(); // returns although the send has not resolved
    h.setMd(openQuestions(juneEntry({ box: 'x' })));
    await service.scanSoon();
    expect(h.outbox.get(relayDeliveryId(JUNE_RAW, 1))).toMatchObject({
      state: 'done',
      result: { reason: 'cancelled: the entry was closed' },
    });
    // The queue then resolves the waiting send as cancelled: a closed row
    // stays closed.
    release({
      status: 'failed',
      reason: 'cancelled: the entry was closed',
      retryable: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.audits.map((a) => a.action)).not.toContain('relay 1 failed');
  });

  it('records a send that finished on retry before holding for a route change (codex r5)', async () => {
    const h = harness();
    let allowlist = ALLOWLIST;
    const service = createRoutedApprovalService({
      ...h.deps,
      readAllowlist: async () => allowlist,
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    h.outbox.set(relayDeliveryId(JUNE_RAW, 1), {
      state: 'done',
      result: { status: 'sent', resendId: 're_retried' },
    });
    allowlist = ALLOWLIST.replace(
      'route to **Omar Haddad (ohaddad)** for approval',
      'route through Tessa Bower (user104)',
    );
    await service.scanSoon();
    expect(h.audits.map((a) => a.action)).toContain('relay 1 sent');
    await service.scanSoon();
    const held = h.pings.at(-1)!;
    expect(held).toContain('HELD, no further relay');
    expect(held).not.toContain('nothing was sent');
  });

  it('keeps an in-flight relay that lands after a hold as history', async () => {
    const h = harness();
    let allowlist = ALLOWLIST;
    const service = createRoutedApprovalService({
      ...h.deps,
      readAllowlist: async () => allowlist,
      cancelRelay: () => false, // already claimed by the outbox: in flight
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    allowlist = ALLOWLIST.replace(
      'route to **Omar Haddad (ohaddad)** for approval',
      'route through Tessa Bower (user104)',
    );
    await service.scanSoon(); // held; the in-flight relay could not be cancelled
    expect(h.audits.map((a) => a.action)).toContain('relay 1 held');
    h.outbox.set(relayDeliveryId(JUNE_RAW, 1), {
      state: 'done',
      result: { status: 'sent', resendId: 're_inflight' },
    });
    await service.scanSoon();
    expect(h.audits.map((a) => a.action)).toContain('relay 1 sent');
  });

  it('startup reconcile cancels relays for entries closed while down, and sends nothing new (codex r6)', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    const pingsBefore = h.pings.length;

    // While the process was down: June's entry closed, a new entry added.
    service.recordEvidence({
      rawPath: 'discussions/raw/new.md',
      sender: 'jhl@example.edu',
      subject: 'New',
      receivedAt: Date.parse('2026-09-15T15:00:00Z'),
      texts: ['A brand new update that needs approval soon.'],
    });
    h.setMd(
      openQuestions(
        juneEntry({ box: 'x' }),
        juneEntry({
          raw: 'discussions/raw/new.md',
          quote: 'A brand new update that needs approval soon.',
        }).replace(/\n {2}- Sender's words: "This is resolved[^\n]*/, ''),
      ),
    );
    const restarted = createRoutedApprovalService(h.deps);
    await restarted.reconcileBeforeReplay();
    expect(h.outbox.get(relayDeliveryId(JUNE_RAW, 1))).toMatchObject({
      state: 'done',
      result: { reason: 'cancelled: the entry was closed' },
    });
    expect(h.sent).toHaveLength(1);
    expect(h.pings).toHaveLength(pingsBefore);
    // The normal scan afterwards picks up the new entry.
    h.sendResult.value = 'sent';
    await restarted.scanSoon();
    expect(h.sent).toHaveLength(2);
  });

  it('startup reconcile cancels a queued relay whose route changed while down (codex r7)', async () => {
    const h = harness();
    let allowlist = ALLOWLIST;
    const deps = { ...h.deps, readAllowlist: async () => allowlist };
    const service = createRoutedApprovalService(deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    allowlist = ALLOWLIST.replace(
      'route to **Omar Haddad (ohaddad)** for approval',
      'route through Tessa Bower (user104)',
    );
    await createRoutedApprovalService(deps).reconcileBeforeReplay();
    expect(h.outbox.get(relayDeliveryId(JUNE_RAW, 1))).toMatchObject({
      state: 'done',
      result: { reason: 'cancelled: the approval route changed' },
    });
    expect(dbRoutedApprovalStore.get(JUNE_RAW)?.status).toBe('held');
    expect(h.sent).toHaveLength(1);
  });

  it('startup reconcile never submits a relay, even one that is due', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'throw'; // interrupted: the relay is still due
    await service.scanSoon();
    h.sendResult.value = 'sent';
    const restarted = createRoutedApprovalService(h.deps);
    await restarted.reconcileBeforeReplay();
    expect(h.sent).toHaveLength(0);
    await restarted.scanSoon();
    expect(h.sent).toHaveLength(1);
  });

  it('owes a follow-up when the row changes while Telegram is sending (codex r6)', async () => {
    const h = harness();
    let first = true;
    const service = createRoutedApprovalService({
      ...h.deps,
      pingOwner: async (text) => {
        h.pings.push(text);
        if (first) {
          first = false;
          // A late relay result lands while the message is in flight.
          dbRoutedApprovalStore.update(JUNE_RAW, {
            status: 'relay-failed',
            holdReason: 'resend-500',
          });
        }
        return 'sent';
      },
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    expect(h.pings[0]).toContain('queued');
    await service.scanSoon();
    expect(h.pings).toHaveLength(2);
    expect(h.pings[1]).toContain('Coordinator routed approval relay failed');
  });

  it('records a relay that landed after its entry was closed (codex r6)', async () => {
    const h = harness();
    const service = createRoutedApprovalService({
      ...h.deps,
      cancelRelay: () => false, // in flight
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    h.setMd(openQuestions(juneEntry({ box: 'x' })));
    await service.scanSoon();
    h.outbox.set(relayDeliveryId(JUNE_RAW, 1), {
      state: 'done',
      result: { status: 'sent', resendId: 're_after_close' },
    });
    await service.scanSoon();
    expect(h.audits.map((a) => a.action)).toContain('relay 1 sent');
    expect(dbRoutedApprovalStore.listUnrecordedRelays()).toEqual([]);
  });

  it('settles a closed row whose unrecorded relay failed, so it is not polled again', async () => {
    const h = harness();
    const service = createRoutedApprovalService({
      ...h.deps,
      cancelRelay: () => false,
    });
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    h.sendResult.value = 'retry';
    await service.scanSoon();
    h.setMd(openQuestions(juneEntry({ box: 'x' })));
    await service.scanSoon();
    h.outbox.set(relayDeliveryId(JUNE_RAW, 1), {
      state: 'done',
      result: { status: 'failed', reason: 'dead-letter', retryable: false },
    });
    await service.scanSoon();
    expect(dbRoutedApprovalStore.listUnrecordedRelays()).toEqual([]);
    expect(h.audits.map((a) => a.action)).not.toContain('relay 1 failed');
  });

  it('batches many new entries into one Telegram message', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    const entries = Array.from({ length: 6 }, (_, i) =>
      juneEntry({ raw: `discussions/raw/forged-${i}.md` }),
    );
    h.setMd(openQuestions(...entries));
    await service.scanSoon();
    expect(h.sent).toHaveLength(0);
    expect(h.pings).toHaveLength(1);
    expect(h.pings[0].split('HELD').length - 1).toBe(6);
  });

  it('tells Avery once when an open entry disappears without a close', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon();
    h.setMd(openQuestions());
    await service.scanSoon();
    await service.scanSoon();
    expect(h.pings).toHaveLength(2);
    expect(h.pings[1]).toContain('removed without being closed');
  });

  it('does not treat a missing section as removal', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    juneEvidence(service);
    h.setMd(openQuestions(juneEntry()));
    await service.scanSoon();
    h.setMd('# Open questions\n');
    await service.scanSoon();
    expect(h.pings).toHaveLength(1);
  });

  it('trusts an address in a quote only when the same address is in the email', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    service.recordEvidence({
      rawPath: JUNE_RAW,
      sender: 'jhl@example.edu',
      subject: 'Webinar contact',
      receivedAt: Date.parse('2026-09-14T19:45:00Z'),
      texts: [
        'Please send webinar questions to gradoffice@example.edu from now on.',
      ],
    });
    h.setMd(
      openQuestions(
        juneEntry({
          quote:
            'Please send webinar questions to gradoffice@example.edu from now on.',
        }).replace(/\n {2}- Sender's words: "This is resolved[^\n]*/, ''),
      ),
    );
    await service.scanSoon();
    expect(h.sent[0].opts.trustedBodyAddresses).toEqual([
      'gradoffice@example.edu',
    ]);
  });

  it('does not trust an address the word match accepts but the email does not contain', async () => {
    const h = harness();
    const service = createRoutedApprovalService(h.deps);
    service.recordEvidence({
      rawPath: JUNE_RAW,
      sender: 'jhl@example.edu',
      subject: 'Contact',
      receivedAt: Date.parse('2026-09-14T19:45:00Z'),
      texts: ['Questions go to foo.bar@example.edu for the fall term.'],
    });
    h.setMd(
      openQuestions(
        juneEntry({
          quote: 'Questions go to foo bar@example.edu for the fall term.',
        }).replace(/\n {2}- Sender's words: "This is resolved[^\n]*/, ''),
      ),
    );
    await service.scanSoon();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].opts.trustedBodyAddresses).toEqual([]);
  });

  it('runs one scan at a time and repeats once when asked during a scan', async () => {
    const h = harness();
    let reads = 0;
    const deps = {
      ...h.deps,
      readOpenQuestions: async () => (reads++, openQuestions()),
    };
    const service = createRoutedApprovalService(deps);
    await Promise.all([
      service.scanSoon(),
      service.scanSoon(),
      service.scanSoon(),
    ]);
    expect(reads).toBe(2);
  });

  it('survives a restart: the stored row stops a second relay', async () => {
    const h = harness();
    juneEvidence(createRoutedApprovalService(h.deps));
    h.setMd(openQuestions(juneEntry()));
    await createRoutedApprovalService(h.deps).scanSoon();
    await createRoutedApprovalService(h.deps).scanSoon();
    expect(h.sent).toHaveLength(1);
  });
});

describe('routed approval service, logging', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => {
    _closeDatabase();
    vi.restoreAllMocks();
  });

  it('never throws from recordEvidence', () => {
    const h = harness();
    const service = createRoutedApprovalService({
      ...h.deps,
      store: {
        ...h.deps.store,
        putEvidence: () => {
          throw new Error('disk full');
        },
      },
    });
    expect(() =>
      service.recordEvidence({
        rawPath: 'x.md',
        sender: 'a@b.c',
        subject: 's',
        receivedAt: 0,
        texts: [],
      }),
    ).not.toThrow();
  });
});
