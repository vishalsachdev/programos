import { describe, expect, it } from 'vitest';

import {
  buildExceptionsReport,
  checkGovernanceContracts,
  collectAgedOpenQuestions,
  collectOpenHolds,
  collectPendingHandoffs,
  collectSyncStaleness,
  dateInZone,
  fileAgeDays,
  lastNDates,
  parseAddedDate,
  parseLastSynced,
  parseSensorAnnotations,
} from './exceptions-report.js';

const TZ = 'America/Chicago';
// 2026-06-10 12:00 Central (17:00 UTC)
const NOW = new Date('2026-06-10T17:00:00Z');

const AUDIT_DAY = `### 09:00:00 — email — outbound
**From:** Coordinator
body
[sensor: pass]
---
### 10:00:00 — telegram — outbound
body
[sensor: flag: propagation-lag — curriculum.md still shows ToolAlpha]
---
### 11:00:00 — email — outbound
body
[sensor: fail — Applied Topics is Draft, not Core | type: factual]
---
### 12:00:00 — email — outbound
body
[sensor: pending:12:00:00-abc123]
---
### 13:00:00 — web-chat — outbound
body
[sensor: skipped]
---
`;

const LAST_SYNCED_FRESH = `# CRS 554 Box Sync

**Last synced:** 2026-06-10 (auto, \`scripts/box-autosync.py\`)
`;
const LAST_SYNCED_STALE = `# ELC 550 Box Sync

**Last synced:** 2026-06-04 (auto, \`scripts/box-autosync.py\`)
`;

/** Stub reader over a path->content map; listDir derives entries from keys. */
function stubReader(files: Record<string, string>) {
  return {
    refresh: () => ({ advanced: false, sha: 'stub' }),
    readFile: (p: string) => files[p] ?? null,
    listDir: (dir: string) => {
      const prefix = `${dir}/`;
      const entries = new Set<string>();
      for (const key of Object.keys(files)) {
        if (key.startsWith(prefix)) {
          entries.add(key.slice(prefix.length).split('/')[0]);
        }
      }
      return entries.size > 0 ? [...entries] : null;
    },
  };
}

describe('dateInZone / lastNDates', () => {
  it('renders the calendar date in the given timezone', () => {
    expect(dateInZone(NOW, TZ)).toBe('2026-06-10');
    // 03:00 UTC is still the previous day in Chicago.
    expect(dateInZone(new Date('2026-06-10T03:00:00Z'), TZ)).toBe('2026-06-09');
  });

  it('produces n dates, newest first', () => {
    expect(lastNDates(3, TZ, NOW)).toEqual([
      '2026-06-10',
      '2026-06-09',
      '2026-06-08',
    ]);
  });

  it('does not duplicate or skip dates across the fall DST transition', () => {
    // 2026-11-01 in America/Chicago is a 25-hour day: subtracting fixed 24h
    // blocks from late that evening lands on the same local date twice and
    // silently drops 10-31 from the window.
    // 2026-11-02T05:30Z = 2026-11-01 23:30 CST.
    const dates = lastNDates(4, TZ, new Date('2026-11-02T05:30:00Z'));
    expect(dates).toEqual([
      '2026-11-01',
      '2026-10-31',
      '2026-10-30',
      '2026-10-29',
    ]);
  });
});

describe('parseSensorAnnotations', () => {
  it('counts fail/flag/error and stale pendings; ignores pass/skipped', () => {
    const r = parseSensorAnnotations(AUDIT_DAY);
    expect(r.fail).toHaveLength(1);
    expect(r.fail[0]).toContain('Applied Topics is Draft');
    expect(r.flag).toHaveLength(1);
    expect(r.flag[0]).toContain('propagation-lag');
    expect(r.error).toHaveLength(0);
    expect(r.pending).toBe(1);
  });

  it('counts only the exact marker grammar; near-misses land in error', () => {
    // `[sensor: passed]` / `[sensor: pass-through]` must not inflate the
    // pass denominator; writer drift surfaces loudly instead of vanishing.
    const day = [
      '[sensor: pass]',
      '[sensor: passed]',
      '[sensor: pass-through]',
      '[sensor: pass — out-of-scope: tracking-state]',
      '[sensor: flagged]',
    ].join('\n');
    const r = parseSensorAnnotations(day);
    expect(r.pass).toBe(2); // exact + out-of-scope form
    expect(r.flag).toHaveLength(0);
    expect(r.error).toEqual([
      'unrecognized marker: passed',
      'unrecognized marker: pass-through',
      'unrecognized marker: flagged',
    ]);
  });

  it('ignores markers quoted mid-prose in an untruncated email body', () => {
    // logOutboundEmail records full bodies; an email ABOUT the sensor must
    // not add verdicts. The writer always emits real annotations on their
    // own line, so only full-line matches count.
    const day = [
      '### 13:00:00 — email — outbound',
      '**[OUTBOUND EMAIL]** To: avery@example.edu | Subject: pipeline report',
      '',
      'One reply was annotated [sensor: fail — bad claim | type: factual] and',
      'another got [sensor: flag: propagation-lag] from the sensor yesterday.',
      '',
      '[sensor: pass]',
      '---',
      '',
    ].join('\n');
    const r = parseSensorAnnotations(day);
    expect(r.fail).toHaveLength(0);
    expect(r.flag).toHaveLength(0);
    expect(r.pass).toBe(1);
  });

  it('counts full-line verdicts whose descriptions contain bracketed citations', () => {
    const day = [
      '[sensor: fail — conflicts with the superseding decision [2026-07-26] | type: factual]',
      '[sensor: flag: roster status [2026-08-08] could be stale]',
    ].join('\n');
    const r = parseSensorAnnotations(day);
    expect(r.fail).toEqual([
      'fail — conflicts with the superseding decision [2026-07-26] | type: factual',
    ]);
    expect(r.flag).toEqual(['flag: roster status [2026-08-08] could be stale']);
    expect(r.error).toHaveLength(0);
  });
});

describe('fileAgeDays', () => {
  it('computes whole-day age from a dated filename', () => {
    expect(fileAgeDays('2026-06-03-conflicts.md', TZ, NOW)).toBe(7);
    expect(fileAgeDays('2026-06-10-x.md', TZ, NOW)).toBe(0);
  });

  it('returns null for undated names', () => {
    expect(fileAgeDays('README.md', TZ, NOW)).toBeNull();
  });
});

describe('parseLastSynced', () => {
  it('extracts the date', () => {
    expect(parseLastSynced(LAST_SYNCED_STALE)).toBe('2026-06-04');
  });
  it('returns null when absent', () => {
    expect(parseLastSynced('# nothing here')).toBeNull();
  });
});

describe('collectOpenHolds', () => {
  it('lists dated holds oldest-first by age, excluding done/ and reports', () => {
    const reader = stubReader({
      'discussions/kb-triage/2026-06-01-conflicts.md': 'x',
      'discussions/kb-triage/2026-06-08-response-error.md': 'x',
      'discussions/kb-triage/2026-06-10-backlog-triage-report.md': 'x',
      'discussions/kb-triage/done/2026-04-30-conflicts.md': 'x',
    });
    const holds = collectOpenHolds(reader, TZ, NOW);
    expect(holds.map((h) => h.file)).toEqual([
      '2026-06-01-conflicts.md',
      '2026-06-08-response-error.md',
    ]);
    expect(holds[0].ageDays).toBe(9);
  });
});

describe('collectSyncStaleness', () => {
  it('flags only courses whose sync is older than 36h', () => {
    const reader = stubReader({
      'courses/crs554/sync/_last-synced.md': LAST_SYNCED_FRESH,
      'courses/elc550/sync/_last-synced.md': LAST_SYNCED_STALE,
      'courses/crs557_business_intelligence.md': 'not a synced course',
    });
    const r = collectSyncStaleness(reader, TZ, NOW);
    expect(r.checked).toBe(2);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0]).toMatchObject({ course: 'elc550', ageDays: 6 });
  });
});

const CLAUDE_MD_OK = '# program-repo\n\n## KB Write Protocol\n\nrules…\n';

describe('buildExceptionsReport', () => {
  const baseFiles = {
    'CLAUDE.md': CLAUDE_MD_OK,
    'discussions/audit-log/2026-06-09.md': AUDIT_DAY,
    'courses/crs554/sync/_last-synced.md': LAST_SYNCED_FRESH,
  };
  const noRuns = {
    taskRuns: [],
    pausedTasks: [],
    timeZone: TZ,
    now: NOW,
    workingContextEntries: [],
  };

  it('wakes the agent when there are sensor exceptions and counts them', () => {
    const report = buildExceptionsReport({
      ...noRuns,
      reader: stubReader(baseFiles),
    });
    expect(report.wakeAgent).toBe(true);
    expect(report.data.sensor.fail).toBe(1);
    expect(report.data.sensor.flag).toBe(1);
    // The pending is on a PAST day (06-09) → stale.
    expect(report.data.sensor.stalePending).toBe(1);
    expect(report.data.sensor.samples[0]).toContain('2026-06-09');
  });

  it("does not count today's pendings as stale (sensor may still be running)", () => {
    const report = buildExceptionsReport({
      ...noRuns,
      reader: stubReader({
        'CLAUDE.md': CLAUDE_MD_OK,
        'discussions/audit-log/2026-06-10.md': '[sensor: pending:x]\n',
      }),
    });
    expect(report.data.sensor.stalePending).toBe(0);
  });

  it('stays silent on a clean week (wakeAgent=false)', () => {
    const report = buildExceptionsReport({
      ...noRuns,
      reader: stubReader({
        'CLAUDE.md': CLAUDE_MD_OK,
        'discussions/audit-log/2026-06-09.md': '[sensor: pass]\n',
        'courses/crs554/sync/_last-synced.md': LAST_SYNCED_FRESH,
      }),
    });
    expect(report.wakeAgent).toBe(false);
    expect(report.data.sensor.fail).toBe(0);
  });

  it('counts routed approvals; a newly routed one wakes the agent, a standing one does not', () => {
    const routed = (added: string) =>
      [
        '## Routed Approvals',
        '',
        `- [ ] **Routed to Omar Haddad (ohaddad): admissions** (Sender: jhl@example.edu; Approver: ohaddad@example.edu; Raw: discussions/raw/a.md) (Added: ${added})`,
      ].join('\n');
    const clean = {
      'CLAUDE.md': CLAUDE_MD_OK,
      'discussions/audit-log/2026-06-09.md': '[sensor: pass]\n',
      'courses/crs554/sync/_last-synced.md': LAST_SYNCED_FRESH,
    };
    const fresh = buildExceptionsReport({
      ...noRuns,
      reader: stubReader({
        ...clean,
        'discussions/OPEN_QUESTIONS.md': routed('2026-06-08'),
      }),
    });
    expect(fresh.wakeAgent).toBe(true);
    expect(fresh.data.routedApprovals.openedInWindow).toBe(1);
    expect(fresh.data.routedApprovals.open).toHaveLength(1);

    const standing = buildExceptionsReport({
      ...noRuns,
      reader: stubReader({
        ...clean,
        'discussions/OPEN_QUESTIONS.md': routed('2026-05-01'),
      }),
    });
    expect(standing.data.routedApprovals.open).toHaveLength(1);
    expect(standing.data.routedApprovals.openedInWindow).toBe(0);
    expect(standing.wakeAgent).toBe(false);
  });

  it('alwaysWake overrides a clean week', () => {
    const report = buildExceptionsReport({
      ...noRuns,
      reader: stubReader({ 'CLAUDE.md': CLAUDE_MD_OK }),
      alwaysWake: true,
    });
    expect(report.wakeAgent).toBe(true);
  });

  it('reports task failures and paused tasks', () => {
    const report = buildExceptionsReport({
      ...noRuns,
      reader: stubReader({ 'CLAUDE.md': CLAUDE_MD_OK }),
      taskRuns: [
        {
          task_id: 'weekly-nudge',
          run_at: '2026-06-09T14:00:00Z',
          duration_ms: 100,
          status: 'error',
          result: null,
          error: 'send_email unavailable in container',
        },
        {
          task_id: 'fde-scan',
          run_at: '2026-06-08T12:00:00Z',
          duration_ms: 100,
          status: 'success',
          result: 'ok',
          error: null,
        },
      ],
      pausedTasks: [
        { id: 'weekly-nudge', promptPreview: 'Action item nudge…' },
      ],
    });
    expect(report.wakeAgent).toBe(true);
    expect(report.data.tasks.failures).toHaveLength(1);
    expect(report.data.tasks.failures[0].error).toContain('send_email');
    expect(report.data.tasks.paused).toHaveLength(1);
  });

  it('a failed mirror refresh becomes a note, not a crash', () => {
    const reader = {
      ...stubReader({ 'CLAUDE.md': CLAUDE_MD_OK }),
      refresh: () => {
        throw new Error('network down');
      },
    };
    const report = buildExceptionsReport({ ...noRuns, reader });
    expect(report.wakeAgent).toBe(true);
    expect(report.data.notes[0]).toContain('mirror refresh failed');
  });
});

describe('checkGovernanceContracts', () => {
  it('is silent when the KB Write Protocol heading is present', () => {
    expect(
      checkGovernanceContracts(stubReader({ 'CLAUDE.md': CLAUDE_MD_OK })),
    ).toEqual([]);
  });

  it('notes a missing KB Write Protocol heading (exact-name consumer contract)', () => {
    const notes = checkGovernanceContracts(
      stubReader({ 'CLAUDE.md': '# program-repo\n\n## Write Rules\n' }),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"## KB Write Protocol" heading missing');
  });

  it('notes an unreadable CLAUDE.md instead of silently passing', () => {
    const notes = checkGovernanceContracts(stubReader({}));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('CLAUDE.md unreadable');
  });

  it('a heading regression wakes the digest agent', () => {
    const report = buildExceptionsReport({
      taskRuns: [],
      pausedTasks: [],
      timeZone: TZ,
      now: NOW,
      workingContextEntries: [],
      reader: stubReader({ 'CLAUDE.md': '# program-repo\n' }),
    });
    expect(report.wakeAgent).toBe(true);
    expect(report.data.notes.some((n) => n.includes('contract check'))).toBe(
      true,
    );
  });
});

describe('parseAddedDate', () => {
  it('reads the (Added: YYYY-MM-DD) stamp', () => {
    expect(parseAddedDate('- [ ] **Q?** body (Added: 2026-05-01)')).toBe(
      '2026-05-01',
    );
  });

  it('tolerates whitespace after the colon', () => {
    expect(parseAddedDate('- [ ] **Q?** (Added:  2026-05-01)')).toBe(
      '2026-05-01',
    );
  });

  it('returns null when absent or malformed', () => {
    expect(parseAddedDate('- [ ] **Q?** no stamp')).toBeNull();
    expect(parseAddedDate('- [ ] **Q?** (Added: May 1 2026)')).toBeNull();
  });
});

describe('collectAgedOpenQuestions', () => {
  const AQ_NOW = new Date('2026-06-10T17:00:00Z'); // today = 2026-06-10 CT
  const oq = (...bullets: string[]) => ({
    'discussions/OPEN_QUESTIONS.md': `# Open Questions\n\n${bullets.join('\n')}\n`,
  });

  it('returns empty when the file is unreadable', () => {
    const r = collectAgedOpenQuestions(stubReader({}), 7, TZ, AQ_NOW);
    expect(r).toEqual({ newlyAged: [], totalAged: 0, missingAdded: [] });
  });

  it('ignores questions younger than the threshold', () => {
    const r = collectAgedOpenQuestions(
      stubReader(oq('- [ ] **Fresh?** (Added: 2026-06-05)')), // 5d
      7,
      TZ,
      AQ_NOW,
    );
    expect(r.totalAged).toBe(0);
    expect(r.newlyAged).toHaveLength(0);
  });

  it('reports a question that crossed the threshold inside the window', () => {
    // 16d old, threshold 14 → crossed 2 days ago, window 7 → newly aged.
    const r = collectAgedOpenQuestions(
      stubReader(oq('- [ ] **Crossed?** (Added: 2026-05-25)')),
      7,
      TZ,
      AQ_NOW,
    );
    expect(r.totalAged).toBe(1);
    expect(r.newlyAged).toHaveLength(1);
    expect(r.newlyAged[0]).toMatchObject({
      title: 'Crossed?',
      added: '2026-05-25',
      ageDays: 16,
    });
  });

  it('counts but does not re-report a long-aged question (flag-once)', () => {
    // 100d old — crossed the threshold long before this window.
    const r = collectAgedOpenQuestions(
      stubReader(oq('- [ ] **Ancient?** (Added: 2026-03-02)')),
      7,
      TZ,
      AQ_NOW,
    );
    expect(r.totalAged).toBe(1);
    expect(r.newlyAged).toHaveLength(0);
  });

  it('flags open questions missing the Added stamp (write-path integrity)', () => {
    const r = collectAgedOpenQuestions(
      stubReader(oq('- [ ] **Undated?** the gate was skipped')),
      7,
      TZ,
      AQ_NOW,
    );
    expect(r.missingAdded).toEqual(['Undated?']);
    expect(r.totalAged).toBe(0);
  });

  it('skips resolved [x] questions entirely', () => {
    const r = collectAgedOpenQuestions(
      stubReader(oq('- [x] **Done?** (Added: 2026-01-01)', '- [x] **Also?**')),
      7,
      TZ,
      AQ_NOW,
    );
    expect(r.totalAged).toBe(0);
    expect(r.missingAdded).toHaveLength(0);
  });

  it('sorts newly aged oldest-first and caps the enumerated list at 10', () => {
    // 12 questions all crossing within the window (ages 14..25 vs window 12).
    const bullets = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(AQ_NOW.getTime() - (14 + i) * 86_400_000)
        .toISOString()
        .slice(0, 10);
      return `- [ ] **Q${i}?** (Added: ${d})`;
    });
    const r = collectAgedOpenQuestions(
      stubReader(oq(...bullets)),
      12,
      TZ,
      AQ_NOW,
    );
    expect(r.totalAged).toBe(12);
    expect(r.newlyAged).toHaveLength(10);
    expect(r.newlyAged[0].ageDays).toBeGreaterThan(r.newlyAged[9].ageDays);
  });

  it('newly aged questions wake the digest agent; a standing backlog alone does not', () => {
    const ancient = buildExceptionsReport({
      taskRuns: [],
      pausedTasks: [],
      timeZone: TZ,
      now: AQ_NOW,
      workingContextEntries: [],
      reader: stubReader({
        'CLAUDE.md': CLAUDE_MD_OK,
        ...oq('- [ ] **Ancient?** (Added: 2026-03-02)'),
      }),
    });
    expect(ancient.data.openQuestions.totalAged).toBe(1);
    expect(ancient.data.openQuestions.newlyAged).toHaveLength(0);
    expect(ancient.wakeAgent).toBe(false);

    const crossed = buildExceptionsReport({
      taskRuns: [],
      pausedTasks: [],
      timeZone: TZ,
      now: AQ_NOW,
      workingContextEntries: [],
      reader: stubReader({
        'CLAUDE.md': CLAUDE_MD_OK,
        ...oq('- [ ] **Crossed?** (Added: 2026-05-25)'),
      }),
    });
    expect(crossed.wakeAgent).toBe(true);
  });

  it('a missing Added stamp wakes the digest agent', () => {
    const report = buildExceptionsReport({
      taskRuns: [],
      pausedTasks: [],
      timeZone: TZ,
      now: AQ_NOW,
      workingContextEntries: [],
      reader: stubReader({
        'CLAUDE.md': CLAUDE_MD_OK,
        ...oq('- [ ] **Undated?** no stamp'),
      }),
    });
    expect(report.wakeAgent).toBe(true);
    expect(report.data.openQuestions.missingAdded).toEqual(['Undated?']);
  });
});

// --- collectPendingHandoffs ---

describe('collectPendingHandoffs', () => {
  const TZ2 = 'America/Chicago';
  // "today" is 2026-07-28 in Chicago
  const NOW2 = new Date('2026-07-28T17:00:00Z');

  function makeHandoffEntry(overrides: Record<string, unknown>) {
    return {
      ts: '2026-07-21',
      type: 'handoff' as const,
      text: 'handoff entry',
      ...overrides,
    } as ReturnType<typeof Object.assign>;
  }

  it('returns empty arrays when no entries', () => {
    const result = collectPendingHandoffs([], TZ2, NOW2);
    expect(result.pending).toHaveLength(0);
    expect(result.pastPingAfter).toHaveLength(0);
  });

  it('ignores non-handoff type entries', () => {
    const entries = [
      { ts: '2026-07-21', type: 'thread' as const, text: 'some thread' },
    ];
    const result = collectPendingHandoffs(entries, TZ2, NOW2);
    expect(result.pending).toHaveLength(0);
  });

  it('ignores resolved handoffs', () => {
    const entries = [
      makeHandoffEntry({
        to: 'pfoster1@example.edu',
        artifact: 'docs/kb-audit.md',
        expected: 'corrections',
        ping_after: '2026-07-25',
        resolved: true,
      }),
    ];
    const result = collectPendingHandoffs(entries, TZ2, NOW2);
    expect(result.pending).toHaveLength(0);
  });

  it('flags unresolved handoff past ping_after', () => {
    const entries = [
      makeHandoffEntry({
        to: 'pfoster1@example.edu',
        artifact: 'docs/kb-audit.md',
        expected: 'itemized corrections',
        ping_after: '2026-07-25', // past 2026-07-28
        resolved: false,
      }),
    ];
    const result = collectPendingHandoffs(entries, TZ2, NOW2);
    expect(result.pending).toHaveLength(1);
    expect(result.pastPingAfter).toHaveLength(1);
    expect(result.pending[0].to).toBe('pfoster1@example.edu');
  });

  it('flags unresolved handoff with gotcha field even before ping_after', () => {
    const entries = [
      makeHandoffEntry({
        to: 'srivera@example.edu',
        artifact: 'G42 relay',
        expected: 'Avery reply',
        gotcha: 'bulk doc return breaks DECISIONS.md chronology',
        ping_after: '2026-08-05', // future
        resolved: false,
      }),
    ];
    const result = collectPendingHandoffs(entries, TZ2, NOW2);
    expect(result.pending).toHaveLength(1);
    expect(result.pastPingAfter).toHaveLength(0); // not past ping_after yet
    expect(result.pending[0].gotcha).toBe(
      'bulk doc return breaks DECISIONS.md chronology',
    );
  });

  it('does not flag unresolved handoff before ping_after without gotcha', () => {
    const entries = [
      makeHandoffEntry({
        to: 'srivera@example.edu',
        artifact: 'some doc',
        expected: 'reply',
        ping_after: '2026-08-10', // future, no gotcha
        resolved: false,
      }),
    ];
    const result = collectPendingHandoffs(entries, TZ2, NOW2);
    expect(result.pending).toHaveLength(0);
  });

  it('sorts pending oldest ping_after first', () => {
    const entries = [
      makeHandoffEntry({
        to: 'b@example.edu',
        artifact: 'b',
        expected: 'b',
        ping_after: '2026-07-27',
        resolved: false,
      }),
      makeHandoffEntry({
        to: 'a@example.edu',
        artifact: 'a',
        expected: 'a',
        ping_after: '2026-07-24',
        resolved: false,
      }),
    ];
    const result = collectPendingHandoffs(entries, TZ2, NOW2);
    expect(result.pending[0].to).toBe('a@example.edu');
    expect(result.pending[1].to).toBe('b@example.edu');
  });

  it('wakeAgent is true when pending handoffs exist', () => {
    const CLAUDE_MD = '## KB Write Protocol\n\nContent.';
    const reader = {
      refresh: () => {},
      readFile: (p: string) => {
        if (p === 'CLAUDE.md') return CLAUDE_MD;
        return null;
      },
      listDir: () => [],
    };
    const handoffEntry = makeHandoffEntry({
      to: 'pfoster1@example.edu',
      artifact: 'docs/kb-audit.md',
      expected: 'corrections',
      ping_after: '2026-07-25',
      resolved: false,
    });
    const report = buildExceptionsReport({
      reader,
      taskRuns: [],
      pausedTasks: [],
      timeZone: TZ2,
      now: NOW2,
      workingContextEntries: [handoffEntry],
    });
    expect(report.wakeAgent).toBe(true);
    expect(report.data.handoffs.pending).toHaveLength(1);
    expect(report.data.handoffs.pastPingAfter).toHaveLength(1);
  });
});

describe('collectPendingHandoffs gotcha normalization (codex round 4)', () => {
  it('a blank gotcha does not surface a handoff before ping_after', () => {
    const future = '2026-12-31';
    const base = {
      ts: '2026-07-21',
      type: 'handoff' as const,
      text: 'h',
      to: 'a@example.edu',
      artifact: 'doc.md',
      expected: 'reply',
      ping_after: future,
      resolved: false,
    };
    const now = new Date('2026-07-28T17:00:00Z');
    for (const gotcha of ['', '   ']) {
      const r = collectPendingHandoffs(
        [{ ...base, gotcha }] as never,
        'America/Chicago',
        now,
      );
      expect(r.pending).toHaveLength(0);
    }
    // A real one still does.
    const r = collectPendingHandoffs(
      [{ ...base, gotcha: 'real trap' }] as never,
      'America/Chicago',
      now,
    );
    expect(r.pending).toHaveLength(1);
  });
});
