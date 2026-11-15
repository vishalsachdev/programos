import { describe, expect, it } from 'vitest';

import { buildOutreachRecipientRoster } from './outreach-recipient-roster.js';

const ALLOWLIST = `
## Authorized Senders (Program operating team)

| Name | Email | Title | Access | Role / domain (gatekeeping) |
|------|-------|-------|--------|------------------------------|
| Avery Morgan | avery@example.edu | Director | read-write | Program Director · **coordinator-cohort: founding** |
| Lin Chen | lchen12@example.edu | Faculty | read-write | Faculty · **coordinator-cohort: faculty-expansion** |
| Lena Marsh | user107@example.edu | Staff | read-only | Student Services · **coordinator-cohort: team-expansion** |
| Ivy Pike | user108@example.edu | Staff | read-only | Student Experience · **coordinator-cohort: team-expansion** |
| Visibility Only | visible@example.edu | Staff | read-only | Reference access · **coordinator-cohort: team-expansion** |
| Clara Doyle | cdoyle@example.edu | Staff | read-write | Learning Support · **coordinator-cohort: team-expansion** |
| Wren Tate | wtate@example.edu | Staff | read-write | T&L · **coordinator-cohort: team-expansion** |
| Chet Lim | user101@example.edu | Staff | read-only | T&L · **coordinator-cohort: team-expansion** |
| Hugo Larsen | hlarsen@example.edu | Staff | read-only | T&L · **coordinator-cohort: team-expansion** |
| Peter Quill | pquill2@example.edu | Staff | read-only | T&L · **coordinator-cohort: team-expansion** |
| Felix Stone | fstone@example.edu | Staff | read-write | T&L · **coordinator-cohort: stage-2-pilot** |
| Walter Oakes | user112@example.edu | Observer | read-only | Research · **coordinator-cohort: observer** |
| Avery Morgan (PeerAgent Agent) | averybot@gmail.com | agent | read-write | Agent · **coordinator-cohort: agent** |
| Cohortless Observer | observer@example.edu | Research Observer | read-only | Research visibility only |
| Cohortless Agent | agent@example.edu | agent | read-write | Automated principal |

> **Retired access (revoked, no longer authorized):**
> - **Greta J. Nash** (user111@example.edu)
`;

const ACTION_ITEMS = `
# Action items

## Avery Morgan
- [ ] Direct the launch review

## Lin
- [ ] Finish ELC 550 modules

## Ivy Pike & Leena (Student Services)
- [ ] Track learner onboarding
- [ ] Hold onboarding office hours

## Leena (Student Services)
- [ ] Test Coordinator from Student Services

## Klara
- [ ] Finalize the mentor framework

## Teaching & Learning (Chet Lim / Hugo Larsen / Peter)
- [ ] Unassigned shared T&L work
- [ ] Start Spring production (Owner: Wren Tate / T&L)

## Felix (T&L) — additional from meeting
- [ ] Review the production schedule

## Walter Oakes
- [ ] Observe the pilot

## Cohortless Observer
- [ ] Observe without receiving reminders

## Cohortless Agent
- [ ] Automated work must not receive reminders

## Visibility Only
- [ ] Item retained for Avery's digest

## Team
- [ ] Shared work

## Greta J. Nash
- [ ] Old retired item
`;

describe('buildOutreachRecipientRoster', () => {
  it('selects active operating-team owners from current action items', () => {
    const roster = buildOutreachRecipientRoster(ACTION_ITEMS, ALLOWLIST);

    expect(roster.recipients).toEqual([
      {
        name: 'Avery Morgan',
        email: 'avery@example.edu',
        openCount: 1,
        sourceOwners: ['Avery Morgan'],
        delivery: 'digest',
      },
      {
        name: 'Lin Chen',
        email: 'lchen12@example.edu',
        openCount: 1,
        sourceOwners: ['Lin'],
        delivery: 'nudge',
      },
      {
        name: 'Lena Marsh',
        email: 'user107@example.edu',
        openCount: 3,
        sourceOwners: [
          'Ivy Pike & Leena (Student Services)',
          'Leena (Student Services)',
        ],
        delivery: 'nudge',
      },
      {
        name: 'Ivy Pike',
        email: 'user108@example.edu',
        openCount: 2,
        sourceOwners: ['Ivy Pike & Leena (Student Services)'],
        delivery: 'nudge',
      },
      {
        name: 'Visibility Only',
        email: 'visible@example.edu',
        openCount: 1,
        sourceOwners: ['Visibility Only'],
        delivery: 'nudge',
      },
      {
        name: 'Clara Doyle',
        email: 'cdoyle@example.edu',
        openCount: 1,
        sourceOwners: ['Klara'],
        delivery: 'nudge',
      },
      {
        name: 'Wren Tate',
        email: 'wtate@example.edu',
        openCount: 1,
        sourceOwners: ['Teaching & Learning (Chet Lim / Hugo Larsen / Peter)'],
        delivery: 'nudge',
      },
      {
        name: 'Chet Lim',
        email: 'user101@example.edu',
        openCount: 2,
        sourceOwners: ['Teaching & Learning (Chet Lim / Hugo Larsen / Peter)'],
        delivery: 'nudge',
      },
      {
        name: 'Hugo Larsen',
        email: 'hlarsen@example.edu',
        openCount: 2,
        sourceOwners: ['Teaching & Learning (Chet Lim / Hugo Larsen / Peter)'],
        delivery: 'nudge',
      },
      {
        name: 'Peter Quill',
        email: 'pquill2@example.edu',
        openCount: 2,
        sourceOwners: ['Teaching & Learning (Chet Lim / Hugo Larsen / Peter)'],
        delivery: 'nudge',
      },
      {
        name: 'Felix Stone',
        email: 'fstone@example.edu',
        openCount: 1,
        sourceOwners: ['Felix (T&L) — additional from meeting'],
        delivery: 'nudge',
      },
      {
        name: 'Walter Oakes',
        email: 'user112@example.edu',
        openCount: 1,
        sourceOwners: ['Walter Oakes'],
        delivery: 'nudge',
      },
      {
        name: 'Cohortless Observer',
        email: 'observer@example.edu',
        openCount: 1,
        sourceOwners: ['Cohortless Observer'],
        delivery: 'nudge',
      },
    ]);
    expect(roster.unmatchedOwners).toEqual(['Team']);
  });

  it('always includes Avery’s digest when his personal open count is zero', () => {
    const roster = buildOutreachRecipientRoster(
      '## Lin\n- [ ] Finish ELC 550 modules\n',
      ALLOWLIST,
    );

    expect(roster.recipients[0]).toEqual({
      name: 'Avery Morgan',
      email: 'avery@example.edu',
      openCount: 0,
      sourceOwners: [],
      delivery: 'digest',
    });
  });

  it('rejects a malformed allowlist instead of accepting an empty audience', () => {
    expect(() =>
      buildOutreachRecipientRoster(
        '## Team\n- [ ] Shared work\n',
        '# no table',
      ),
    ).toThrow('exactly one active Avery');
  });

  it('rejects malformed action-item input instead of sending a digest-only batch', () => {
    expect(() =>
      buildOutreachRecipientRoster(
        '# Action items\n- [ ] Lost heading structure\n',
        ALLOWLIST,
      ),
    ).toThrow('no owner sections');
  });

  it('rejects duplicate active recipient emails', () => {
    const duplicate = ALLOWLIST.replace(
      '> **Retired access',
      '| Duplicate Lin | lchen12@example.edu | Staff | read-write | **coordinator-cohort: team-expansion** |\n\n> **Retired access',
    );

    expect(() => buildOutreachRecipientRoster(ACTION_ITEMS, duplicate)).toThrow(
      'duplicate active email',
    );
  });

  it('treats legacy monday-reminder markers as inert', () => {
    const legacy = ALLOWLIST.replace(
      'Student Services · **coordinator-cohort: team-expansion**',
      'Student Services · **coordinator-cohort: team-expansion** · **monday-reminder: no**',
    );

    const roster = buildOutreachRecipientRoster(ACTION_ITEMS, legacy);
    expect(
      roster.recipients.some(
        (recipient) => recipient.email === 'user107@example.edu',
      ),
    ).toBe(true);
  });

  it('still excludes agent principals', () => {
    const roster = buildOutreachRecipientRoster(ACTION_ITEMS, ALLOWLIST);
    const emails = roster.recipients.map((recipient) => recipient.email);
    expect(emails).not.toContain('averybot@gmail.com');
    expect(emails).not.toContain('agent@example.edu');
  });
});
