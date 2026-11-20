import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCommitHashVerdict,
  applyPersonNameVerdict,
  applyPremiseDeadVerdict,
  checkPersonNameMismatch,
  buildSensorPrompt,
  checkCitations,
  checkCommitHashes,
  checkPremiseDeadClaims,
  parseAllowlistNames,
  checkSiteUrls,
  checkGRuleRefs,
  checkCourseCodeRefs,
  siteUrlTag,
  mergeFlagIntoVerdict,
  extractCommitHashRefs,
  extractCourseCodes,
  failTypeFromDesc,
  classifyOutOfScope,
  evaluateBehaviourReply,
  filterConfirmedAsOf,
  formatConfirmedDecisionsBlock,
  loadSyncRosters,
  makeSensorId,
  parseConfirmedDecisions,
  parseVerdict,
  pickTriageFile,
  placeholderFor,
  DEFAULT_SENSOR_MODEL,
  runBehaviourSensor,
  sensorRequestShape,
  selectRecentConfirmed,
  selectRelevantConfirmed,
  tokenize,
} from './behaviour-sensor.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// --- Fixtures -------------------------------------------------------------

const DECISIONS_FIXTURE = `# Program Decision Registry

Preamble that must be ignored by the parser.

---

### ELC 550 stats prep: CRS 572 modules confirmed

- **Date:** 2026-05-22
- **Stakeholders:** Avery, Lin
- **Decision:** ELC 550 statistics prep is sourced from CRS 572 modules (not the prior self-study packet).
- **Status:** Confirmed
- **Category:** Onboarding & Prerequisites

---

### LAB 513 Python & Tools prep: ToolBeta replaces ToolAlpha

- **Date:** 2026-05-22
- **Stakeholders:** Avery, Sam
- **Decision:** LAB 513 Python prep moves from ToolAlpha to ToolBeta.
- **Status:** Confirmed

---

### Weekly delivery structure (leading model)

- **Date:** 2026-05-08
- **Decision:** A live session plus a studio session is the leading model.
- **Status:** Proposed

---

### Old prep packet sourcing

- **Date:** 2026-01-10
- **Decision:** Prep was originally a self-study packet.
- **Status:** Superseded

---

### Capstone language clarified

- **Date:** 2026-04-06
- **Decision:** External FAQ omits explicit ordering of the two capstone parts.
- **Status:** Confirmed (pending Meera's sequencing decision)

---

### Spring 2031 full course structure confirmed

- **Date:** 2026-04-23
- **Decision:** Spring 2031 (16 weeks, 12 credits) final structure:
  - CRS 558 - Systems Topics (Vikram, Weeks 1-8, 4 cr)
  - Applied Topics Studio (Avery, Weeks 9-16, 4 cr)
- **Rationale:** Differentiating elective set.
- **Status:** Confirmed
- **Source:** Telegram 2026-04-23
`;

// curriculum.md is STALE: still shows ToolAlpha for LAB 513 prep, and lists
// "Applied Topics" as a Draft (not Core) course.
const CURRICULUM_FIXTURE = `# Program Curriculum

Total: 30 credits.

## Preparatory Coursework
- LAB 513 Python prep: ToolAlpha modules.
- ELC 550 stats prep: self-study packet.

## Courses
- CRS 554 (Core) — 8 videos recorded
- Applied Topics Studio (Draft — not yet approved as Core)
`;

// Box-synced production roster: FRESHER than curriculum.md, which still says
// "8 videos recorded" above. 13 Recorded rows here — the "8 vs 13" case.
const ROSTER_FIXTURE = `# CRS 554 — Instructional Activity Roster (Box sync)

**Last synced:** 2026-06-04 (auto, \`scripts/box-autosync.py\`)

## Module 2 — Topic Two

| Sequence | Title | Item Type | Final Length | Notes |
|---|---|---|---|---|
| M2I1 | Topic Two Overview | Lecture video | 6 min | Status: Recorded 2026-05-29 |
| M2I2 | Topic Two Basics | Lecture video | 6 min | Status: Recorded 2026-05-29 |
| M2I6 | Worked Example | Demonstration Video | 6 min | Status: Scripted 2026-05-29 |
`;

// ACTION_ITEMS fixture: still served by the stub reader, but since the G40
// scope revert nothing in the sensor loads it — tracking-state
// replies are classified out of scope before the model runs.
const ACTION_ITEMS_FIXTURE = `# Program Action Items

Preamble.

## Paige E. Foster

- [ ] Address required corrections in draft pages *(2026-06-10 meeting)*
- [ ] Apply approved program messaging language
- [x] Send updated notes to Nora

## Samuel Caleb Rivera

- [ ] Identify ToolBeta alternative for LAB 513 Python prep

## Nora A. Adler

- [ ] Create centralized tracking document for outstanding decisions *(assigned at the 2026-06-10 meeting)*
`;

/**
 * Write-side fixture repo (audit-log + triage files only). Ground truth is
 * deliberately NOT written here — it flows through the stub reader below, so
 * a regression back to filesystem reads fails these tests.
 */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sensor-test-'));
  fs.mkdirSync(path.join(dir, '.git')); // checkout-fs refuses a non-checkout
  fs.mkdirSync(path.join(dir, 'program'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'discussions'), { recursive: true });
  return dir;
}

/** Stub GroundTruthReader serving the fixtures at their repo-relative paths. */
const FIXTURE_FILES: Record<string, string> = {
  'program/curriculum.md': CURRICULUM_FIXTURE,
  'discussions/DECISIONS.md': DECISIONS_FIXTURE,
  'courses/crs554/sync/activity-roster.md': ROSTER_FIXTURE,
  'discussions/ACTION_ITEMS.md': ACTION_ITEMS_FIXTURE,
};
const stubReader = {
  refresh: () => ({ advanced: false, sha: 'stub-sha' }),
  readFile: (relPath: string) => FIXTURE_FILES[relPath] ?? null,
  exists: (relPath: string) => relPath in FIXTURE_FILES,
};

/** Build an Anthropic-shaped response with the given verdict text. */
function modelReply(text: string) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  };
}

describe('sensorRequestShape (per model family)', () => {
  it('the default sensor model is Haiku 5.5 (Haiku 4.5 is discontinued)', () => {
    expect(DEFAULT_SENSOR_MODEL).toBe('claude-haiku-5-5');
  });
  it('Haiku 5.5 keeps its adaptive thinking, at low effort, with verdict headroom', () => {
    // Haiku 5.5 thinks by default and its default effort is medium. The
    // docs prefer lowering effort over {type:'disabled'}, and thinking
    // counts toward max_tokens, so a 320 cap could end before the verdict.
    const s = sensorRequestShape('claude-haiku-5-5');
    expect(s).not.toHaveProperty('thinking');
    expect(s.output_config).toEqual({ effort: 'low' });
    expect(s.max_tokens).toBeGreaterThanOrEqual(2048);
    // Non-default sampling parameters are a 400 on Haiku 5.5.
    expect(s).not.toHaveProperty('temperature');
    expect(s).not.toHaveProperty('top_p');
    expect(s).not.toHaveProperty('top_k');
  });
  it('Haiku 4.5 (explicit SENSOR_MODEL override only) sends no thinking field', () => {
    const s = sensorRequestShape('claude-haiku-4-5-20251001');
    expect(s).not.toHaveProperty('thinking');
    expect(s).not.toHaveProperty('output_config');
    expect(s.max_tokens).toBe(320);
  });
  it('Sonnet 5 disables its default adaptive thinking', () => {
    expect(sensorRequestShape('claude-sonnet-5').thinking).toEqual({
      type: 'disabled',
    });
  });
  it('Opus 5 disables thinking (accepted at its default high effort)', () => {
    expect(sensorRequestShape('claude-opus-5').thinking).toEqual({
      type: 'disabled',
    });
  });
  it.each(['claude-opus-5-5', 'claude-fable-5-1', 'claude-mythos-5-1'])(
    '%s never sends type:disabled (400) and gets low effort plus thinking headroom',
    (model) => {
      const s = sensorRequestShape(model);
      expect(s).not.toHaveProperty('thinking');
      expect(s.output_config).toEqual({ effort: 'low' });
      expect(s.max_tokens).toBeGreaterThanOrEqual(2048);
    },
  );
  it('an unknown model gets the shape that cannot 400 or starve the verdict', () => {
    const s = sensorRequestShape('claude-something-9');
    expect(s).not.toHaveProperty('thinking');
    expect(s.max_tokens).toBeGreaterThanOrEqual(2048);
  });
});

// --- Pure functions -------------------------------------------------------

describe('parseConfirmedDecisions', () => {
  it('returns only Confirmed-status entries (incl. "Confirmed (pending)")', () => {
    const entries = parseConfirmedDecisions(DECISIONS_FIXTURE);
    const headings = entries.map((e) => e.heading);
    expect(headings).toContain('ELC 550 stats prep: CRS 572 modules confirmed');
    expect(headings).toContain(
      'LAB 513 Python & Tools prep: ToolBeta replaces ToolAlpha',
    );
    expect(headings).toContain('Capstone language clarified'); // "Confirmed (pending ...)"
    // Excludes Proposed and Superseded
    expect(headings).not.toContain('Weekly delivery structure (leading model)');
    expect(headings).not.toContain('Old prep packet sourcing');
  });

  it('parses date and decision text', () => {
    const fin = parseConfirmedDecisions(DECISIONS_FIXTURE).find((e) =>
      e.heading.startsWith('ELC 550'),
    );
    expect(fin?.date).toBe('2026-05-22');
    expect(fin?.decision).toContain('CRS 572 modules');
  });

  it('captures multi-line decisions (continuation bullets), stopping at the next field', () => {
    const spring = parseConfirmedDecisions(DECISIONS_FIXTURE).find((e) =>
      e.heading.startsWith('Spring 2031'),
    );
    // Facts live in continuation bullets, not the lead-in line.
    expect(spring?.decision).toContain('Applied Topics Studio');
    expect(spring?.decision).toContain('Weeks 9-16');
    expect(spring?.decision).toContain('CRS 558');
    // Must stop at the next field — Rationale text is not pulled in.
    expect(spring?.decision).not.toContain('Differentiating');
  });

  it('ignores the file preamble before the first heading', () => {
    const entries = parseConfirmedDecisions(DECISIONS_FIXTURE);
    expect(entries.every((e) => e.heading.length > 0)).toBe(true);
    expect(entries.map((e) => e.heading)).not.toContain(
      'Program Decision Registry',
    );
  });

  it('preserves supersession lifecycle notes needed to resolve conflicting decisions', () => {
    const entries = parseConfirmedDecisions(`### Old Tool Gamma status

**Superseded** — see the restoration decision for the current cost status.
- **Date:** 2026-06-04
- **Decision:** Tool Gamma is no longer free.
- **Status:** Confirmed

### Tool Gamma restored

- **Date:** 2026-07-26
- **Decision:** Tool Gamma is free for verified students.
- **Supersedes:** Old Tool Gamma status — cost portion only.
- **Status:** Confirmed
`);

    expect(entries[0].lifecycle).toContain(
      'Superseded: see the restoration decision for the current cost status.',
    );
    expect(entries[1].lifecycle).toContain(
      'Supersedes: Old Tool Gamma status — cost portion only.',
    );
    expect(formatConfirmedDecisionsBlock(entries)).toContain(
      'LIFECYCLE — Superseded:',
    );
  });
});

describe('selectRecentConfirmed', () => {
  it('orders most-recent-first and caps at the limit', () => {
    const entries = selectRecentConfirmed(
      parseConfirmedDecisions(DECISIONS_FIXTURE),
      2,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe('2026-05-22');
    // The 2026-04-06 confirmed entry is more recent than nothing else of higher date
    expect(entries[1].date! <= entries[0].date!).toBe(true);
  });
});

describe('filterConfirmedAsOf', () => {
  it('excludes decisions that did not exist when a historical reply was sent', () => {
    const entries = parseConfirmedDecisions(DECISIONS_FIXTURE);
    const filtered = filterConfirmedAsOf(entries, '2026-04-30');

    expect(
      filtered.every((entry) => !entry.date || entry.date <= '2026-04-30'),
    ).toBe(true);
    expect(filtered.map((entry) => entry.heading)).toContain(
      'Capstone language clarified',
    );
    expect(filtered.map((entry) => entry.heading)).not.toContain(
      'ELC 550 stats prep: CRS 572 modules confirmed',
    );
  });

  it('keeps every decision for a live review with no cutoff', () => {
    const entries = parseConfirmedDecisions(DECISIONS_FIXTURE);
    expect(filterConfirmedAsOf(entries)).toEqual(entries);
  });
});

describe('tokenize', () => {
  it('keeps 3-char content tokens (course codes) and drops stopwords', () => {
    const t = tokenize('The ELC 550 prep uses ToolBeta');
    expect(t.has('elc')).toBe(true); // 3-char course code, high signal
    expect(t.has('550')).toBe(true);
    expect(t.has('toolbeta')).toBe(true);
    expect(t.has('the')).toBe(false); // stopword
    expect(t.has('uses')).toBe(false); // stopword
  });
});

describe('selectRelevantConfirmed', () => {
  it('prefers a topically-relevant decision over more-recent irrelevant ones', () => {
    // Capstone decision (2026-04-06) is OLDER than the prep decisions
    // (2026-05-22), but a capstone question must still surface it.
    const all = parseConfirmedDecisions(DECISIONS_FIXTURE);
    const sel = selectRelevantConfirmed(
      all,
      'How is the capstone portfolio sequenced into its two parts?',
      1,
    );
    expect(sel[0].heading).toBe('Capstone language clarified');
  });

  it('falls back to recency when nothing in the reply matches', () => {
    const all = parseConfirmedDecisions(DECISIONS_FIXTURE);
    const sel = selectRelevantConfirmed(all, 'xyzzy plugh frobnicate', 2);
    expect(sel[0].date).toBe('2026-05-22'); // most recent wins on zero overlap
  });
});

describe('formatConfirmedDecisionsBlock', () => {
  it('renders bullets with date + heading + decision', () => {
    const block = formatConfirmedDecisionsBlock(
      parseConfirmedDecisions(DECISIONS_FIXTURE),
    );
    expect(block).toContain('[2026-05-22]');
    expect(block).toContain('CRS 572 modules');
  });

  it('returns "(none)" when there are no entries', () => {
    expect(formatConfirmedDecisionsBlock([])).toBe('(none)');
  });
});

describe('extractCourseCodes', () => {
  it('normalizes spacing, hyphens, and case', () => {
    expect(extractCourseCodes('CRS 554 and crs-554 and ELC550')).toEqual([
      'crs554',
      'elc550',
    ]);
  });

  it('finds codes embedded in prose', () => {
    expect(
      extractCourseCodes('Module 3 of LAB 513 is in production.'),
    ).toContain('lab513');
  });

  it('returns empty for text with no course codes', () => {
    expect(extractCourseCodes('When does the program launch?')).toEqual([]);
  });
});

describe('loadSyncRosters', () => {
  it('includes the roster for a mentioned course that has a sync folder', () => {
    const block = loadSyncRosters(
      stubReader,
      'How is CRS 554 production going?',
    );
    expect(block).toContain('courses/crs554/sync/activity-roster.md');
    expect(block).toContain('Recorded 2026-05-29');
  });

  it('returns a "(none ...)" block when the mentioned course has no roster', () => {
    // ELC 550 has no sync/ fixture — the probe simply finds nothing.
    const block = loadSyncRosters(stubReader, 'ELC 550 question');
    expect(block).toContain('(none');
  });

  it('returns a "(none ...)" block when no course is mentioned', () => {
    expect(loadSyncRosters(stubReader, 'general program question')).toContain(
      '(none',
    );
  });

  // Regression: a false positive. Coordinator wrote "M2I6 and M4I6 now
  // show Final project milestone" WITHOUT naming the course, so no roster was
  // loaded and the sensor couldn't verify the (true) claim. Milestone codes
  // must trigger a scan of all synced rosters for the codes themselves.
  describe('milestone-code fallback (July 2026 scope-blindness FP)', () => {
    const ROSTER_WITH_MILESTONES = [
      '# LAB 513 — Instructional Activity Roster (Box sync)',
      '',
      '| Sequence | Title | Item Type |',
      '|---|---|---|',
      '| M2I6 | Final project milestone: Dataset selection | Canvas Assignment |',
      '| M4I6 | Final project milestone: Exploratory visualizations | Canvas Assignment |',
    ].join('\n');
    const listingReader = {
      refresh: () => ({ advanced: false, sha: 'stub-sha' }),
      readFile: (relPath: string) =>
        relPath === 'courses/lab513/sync/activity-roster.md'
          ? ROSTER_WITH_MILESTONES
          : (FIXTURE_FILES[relPath] ?? null),
      exists: (relPath: string) => relPath in FIXTURE_FILES,
      listDir: (relPath: string) =>
        relPath === 'courses' ? ['crs554', 'lab513', 'elc550'] : null,
    };

    it('loads the roster containing a cited milestone code when no course is named', () => {
      const block = loadSyncRosters(
        listingReader,
        'Done. M2I6 and M4I6 now show "Final project milestone" in the roster.',
      );
      expect(block).toContain('courses/lab513/sync/activity-roster.md');
      expect(block).toContain('M2I6');
    });

    it('does not scan rosters when the reply has no milestone codes', () => {
      const block = loadSyncRosters(listingReader, 'general program question');
      expect(block).toContain('(none');
    });

    it('does not duplicate a roster already loaded via course-code mention', () => {
      const block = loadSyncRosters(
        listingReader,
        'LAB 513 update: M2I6 relabeled.',
      );
      const occurrences = block.split(
        'courses/lab513/sync/activity-roster.md',
      ).length;
      expect(occurrences).toBe(2); // one header hit only
    });

    it('degrades gracefully when the reader has no listDir (older stubs)', () => {
      const block = loadSyncRosters(
        stubReader,
        'M2I6 relabeled without course mention.',
      );
      expect(block).toContain('(none');
    });
  });
});

describe('pickTriageFile', () => {
  // Regression: a day-file closed to done/ mid-day collides when
  // a later same-day entry recreates the pending file and is then also closed.
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-test-'));
    fs.mkdirSync(path.join(dir, 'done'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the plain day-file name when nothing exists yet', () => {
    expect(pickTriageFile(dir, '2026-07-15')).toBe(
      path.join(dir, '2026-07-15-response-error.md'),
    );
  });

  it('appends to an existing pending day file', () => {
    fs.writeFileSync(path.join(dir, '2026-07-15-response-error.md'), 'x');
    expect(pickTriageFile(dir, '2026-07-15')).toBe(
      path.join(dir, '2026-07-15-response-error.md'),
    );
  });

  it('suffixes -2 when the day file was already closed to done/', () => {
    fs.writeFileSync(
      path.join(dir, 'done', '2026-07-15-response-error.md'),
      'x',
    );
    expect(pickTriageFile(dir, '2026-07-15')).toBe(
      path.join(dir, '2026-07-15-response-error-2.md'),
    );
  });

  it('appends to the -2 pending file when it exists after a mid-day closure', () => {
    fs.writeFileSync(
      path.join(dir, 'done', '2026-07-15-response-error.md'),
      'x',
    );
    fs.writeFileSync(path.join(dir, '2026-07-15-response-error-2.md'), 'x');
    expect(pickTriageFile(dir, '2026-07-15')).toBe(
      path.join(dir, '2026-07-15-response-error-2.md'),
    );
  });
});

describe('buildSensorPrompt', () => {
  it('substitutes the request context and all evidence sections with contradiction rules', () => {
    const prompt = buildSensorPrompt(
      'reply text',
      'curriculum text',
      'decisions block',
      'rosters block',
      'citations block',
      'user supplied paper text',
    );
    expect(prompt).toContain('reply text');
    expect(prompt).toContain('CURRENT USER REQUEST');
    expect(prompt).toContain('user supplied paper text');
    expect(prompt).toContain('curriculum text');
    expect(prompt).toContain('decisions block');
    expect(prompt).toContain('rosters block');
    expect(prompt).toContain('citations block');
    expect(prompt).toContain('PROPAGATION LAG');
    expect(prompt).toContain('do NOT emit FAIL');
    // Roster precedence: fresher than curriculum, authoritative for status.
    expect(prompt).toContain('roster is authoritative');
    // G40 scope revert: ACTION_ITEMS is out of the bundle; the prompt tells
    // the model tracking state is out of scope, not a third ground truth.
    expect(prompt).not.toContain('{{ACTION_ITEMS}}');
    expect(prompt).toContain('TRACKING STATE IS OUT OF SCOPE');
    expect(prompt).toContain('NOT evidence of error');
    expect(prompt).toContain('same subject, property, and timeframe');
    expect(prompt).toContain('soft launch');
    expect(prompt).toContain('internal component');
    expect(prompt).toContain('explicitly rejects');
    expect(prompt).toContain('newer dated decision controls');
    expect(prompt).toContain('need not narrate the older history');
    expect(prompt).toContain('Omission is not contradiction');
    expect(prompt).toContain('exact precomputed CITED PATHS line says MISSING');
    expect(prompt).toContain('reports the stale source; it does not endorse');
    expect(prompt).toContain('not Coordinator claims');
    // SHA semantics documented in the prompt (registry open question).
    expect(prompt).toContain('review time');
  });

  it('does not interpret $-sequences in ground-truth content', () => {
    // A naive String.replace(pattern, str) would mangle "$&" / "$1".
    const prompt = buildSensorPrompt(
      'r',
      'tuition is $40,000 ($2k/credit)',
      'd',
      'ro',
      'c',
    );
    expect(prompt).toContain('$40,000 ($2k/credit)');
  });
});

// --- G40 (scope revert): out-of-scope claim classifier ----------------------

describe('classifyOutOfScope', () => {
  it('tracking-state claims are out of scope (acceptance #1)', () => {
    expect(
      classifyOutOfScope(
        'Ines owns the accreditation report action item, and it remains open. It was assigned at the June planning meeting and is tracked under her section of the tracking file, along with two other outstanding items she is responsible for following up on before the next review cycle begins later.',
      ),
    ).toBe('tracking-state');
  });

  it('infrastructure terminology is out of scope (acceptance #2)', () => {
    expect(
      classifyOutOfScope(
        'The kb-conflict-check gate ran clean and the entry was committed by the NanoClaw pipeline; PeerAgent dropped the corresponding note into the agent-inbox for the host session to pick up, and the audit-log now carries the gate result entry with the full verdict JSON attached for traceability purposes.',
      ),
    ).toBe('infrastructure');
    expect(classifyOutOfScope('G56 is working as intended.')).toBe(
      'infrastructure',
    );
    expect(
      classifyOutOfScope('All eight exemplars are recorded in commit 2e16475.'),
    ).toBe('infrastructure');
  });

  it('generic program language does not pull an infrastructure scaling answer into scope', () => {
    expect(
      classifyOutOfScope(
        'Coordinator could scale across the college through NanoClaw plumbing, hierarchical Coordinator routing, and shared program infrastructure for students and faculty.',
      ),
    ).toBe('infrastructure');
    expect(
      classifyOutOfScope(
        'NanoClaw could trial ToolZeta for its alarm layer and evaluate whether it stabilizes over 4-6 weeks before expanding it.',
      ),
    ).toBe('infrastructure');
  });

  it('an explicit program fact keeps a mixed infrastructure answer in scope', () => {
    expect(
      classifyOutOfScope(
        'NanoClaw handles the plumbing, and the Program program is 31 credits.',
      ),
    ).toBeNull();
    expect(
      classifyOutOfScope(
        'NanoClaw handles the plumbing, and Program is a 11-month degree program.',
      ),
    ).toBeNull();
  });

  it('a one-line ack is out of scope (acceptance #3)', () => {
    expect(classifyOutOfScope('Yes, go ahead.')).toBe('conversational-ack');
    expect(classifyOutOfScope('Thanks — noted, I will file this.')).toBe(
      'conversational-ack',
    );
  });

  it('program-fact claims stay in scope even when mixed with tracking talk', () => {
    // Acceptance #4: a wrong credit claim must still be evaluated.
    expect(classifyOutOfScope('CRS 554 is 3 credits.')).toBeNull();
    expect(
      classifyOutOfScope(
        'Paige owns the webpage item, and by the way the program is 30 credits across ten courses, which is what the curriculum confirms for the full twelve-month sequence students follow from admission through the capstone experience at the end.',
      ),
    ).toBeNull();
  });

  it('a short reply containing a program fact is not an ack', () => {
    expect(classifyOutOfScope('ELC 550 is 4 credits.')).toBeNull();
    // Short replies with dates/production facts must stay in scope.
    expect(classifyOutOfScope('Module 2 launches August 17.')).toBeNull();
    expect(
      classifyOutOfScope('The screencasts are due 2026-08-17.'),
    ).toBeNull();
  });

  it('facts mixed into tracking or ack phrasing stay in scope (codex R3)', () => {
    expect(
      classifyOutOfScope(
        'Ines owns this item; students must maintain a 3.0 GPA.',
      ),
    ).toBeNull();
    expect(
      classifyOutOfScope('Confirmed: students must maintain a 3.0 GPA.'),
    ).toBeNull();
  });

  it('a short non-ack statement is not an ack (positive detection, codex R2)', () => {
    // No fact keyword, no ack lead — must go to the model, not skip.
    expect(
      classifyOutOfScope('The Program includes eleven required classes.'),
    ).toBeNull();
    expect(
      classifyOutOfScope('That vendor quote covers two seats.'),
    ).toBeNull();
  });

  it('ordinary long factual prose stays in scope', () => {
    expect(
      classifyOutOfScope(
        'The admissions timeline was confirmed for the fall cohort and the assessment framework applies per course. '.repeat(
          3,
        ),
      ),
    ).toBeNull();
  });
});

describe('failTypeFromDesc', () => {
  it('extracts the type tail from a FAIL description', () => {
    expect(failTypeFromDesc('overstated as Core | type: factual')).toBe(
      'factual',
    );
    expect(failTypeFromDesc('missing path | type: citation')).toBe('citation');
    expect(failTypeFromDesc('no type tail')).toBe('unspecified');
  });

  it('ignores a "type:" inside the description body (codex P2)', () => {
    expect(
      failTypeFromDesc(
        'roster mismatch: item type: Lecture video misstated | type: factual',
      ),
    ).toBe('factual');
    // No pipe tail, but a recognized type token later in the text: last wins.
    expect(
      failTypeFromDesc('item type: Lecture video; classified type: citation'),
    ).toBe('citation');
  });
});

describe('checkCitations', () => {
  // Regression: sensor FAILs were false positives where
  // Coordinator cited a repo file without its `discussions/` prefix (e.g.
  // `kb-triage/2026-07-08-conflicts.md` for a file that lives at
  // `discussions/kb-triage/2026-07-08-conflicts.md`). The exact-path check
  // reported MISSING and the prompt hard-FAILs any MISSING citation.
  const citationReader = {
    refresh: () => ({ advanced: false, sha: 'stub-sha' }),
    readFile: () => null,
    exists: (relPath: string) =>
      [
        'discussions/kb-triage/2026-07-08-conflicts.md',
        'discussions/kb-triage/2026-06-20-response-error.md',
        'program/curriculum.md',
      ].includes(relPath),
  };

  it('resolves a citation missing its discussions/ prefix (July FP case)', () => {
    const { block } = checkCitations(
      'Held for review; details in kb-triage/2026-07-08-conflicts.md.',
      citationReader,
    );
    expect(block).toContain('kb-triage/2026-07-08-conflicts.md: exists');
    expect(block).not.toContain('MISSING');
  });

  it('resolves the second July FP case (kb-triage response-error file)', () => {
    const { block } = checkCitations(
      'See kb-triage/2026-06-20-response-error.md for the earlier incident.',
      citationReader,
    );
    expect(block).toContain('kb-triage/2026-06-20-response-error.md: exists');
  });

  it('still reports exact-path citations as exists', () => {
    const { block } = checkCitations(
      'Per program/curriculum.md the program is 30 credits.',
      citationReader,
    );
    expect(block).toContain('program/curriculum.md: exists');
  });

  it('still flags genuinely missing files as MISSING', () => {
    const { block } = checkCitations(
      'As documented in program/no-such-file.md and kb-triage/fabricated.md.',
      citationReader,
    );
    expect(block).toContain('program/no-such-file.md: MISSING');
    expect(block).toContain('kb-triage/fabricated.md: MISSING');
  });

  it('does not double-prefix paths already under discussions/', () => {
    const { block } = checkCitations(
      'Logged in discussions/kb-triage/2026-07-08-conflicts.md today.',
      citationReader,
    );
    expect(block).toContain(
      'discussions/kb-triage/2026-07-08-conflicts.md: exists',
    );
  });

  it('returns (none) when the reply cites no paths', () => {
    const { block } = checkCitations('No citations here.', citationReader);
    expect(block).toBe('(none)');
  });
});

describe('premise-dead pre-check (G37 v2 read-path backstop)', () => {
  // Case: Coordinator surfaced "onboard Lin/Jonas/
  // Arjun to Coordinator testing" as an open gap — all three already allowlisted.
  const ALLOWLIST_MD = `# Allowlist

| Name | Email | Title | Access | Role |
|------|-------|-------|--------|------|
| Avery Morgan | avery@example.edu | Faculty | read-write | Director |
| June Hale | jhl@example.edu | Admissions | read-only | Admissions |
| Caleb Park | cpark@example.edu | Faculty | read-write | Faculty |
| Lin Chen | lchen12@example.edu | Faculty | read-write | Faculty |
| Avery Morgan (PeerAgent Agent) | averybot@gmail.com | agent | read-write | G52 |

> **Retired access (revoked, no longer authorized):**
> - **Greta J. Nash** (user111@example.edu) — access retired.
`;
  const reader = {
    refresh: () => null,
    readFile: (p: string) =>
      p === 'program/EMAIL_ALLOWLIST.md' ? ALLOWLIST_MD : null,
    exists: () => false,
  };

  describe('parseAllowlistNames', () => {
    it('reads names from table rows and strips parentheticals', () => {
      const names = parseAllowlistNames(ALLOWLIST_MD);
      expect(names).toContain('June Hale');
      expect(names).toContain('Avery Morgan');
      expect(names).not.toContain('Avery Morgan (PeerAgent Agent)');
    });

    it('does NOT read the Retired-access blockquote as authorized', () => {
      expect(parseAllowlistNames(ALLOWLIST_MD).join(' ')).not.toContain(
        'Greta',
      );
    });
  });

  describe('checkPremiseDeadClaims', () => {
    it('flags an open onboarding gap for an allowlisted person', () => {
      const res = checkPremiseDeadClaims(
        'Open action item: onboard Lin Chen to Coordinator testing.',
        reader,
      );
      expect(res.flagged).toEqual(['Lin Chen']);
    });

    it('flags shorthand phrasing ("set up on the KB bot")', () => {
      const res = checkPremiseDeadClaims(
        'Next step: get Caleb Park set up on the KB bot.',
        reader,
      );
      expect(res.flagged).toEqual(['Caleb Park']);
    });

    it('does not flag onboarding stated as HISTORY', () => {
      const res = checkPremiseDeadClaims(
        'June Hale was onboarded to Coordinator on 2030-01-07 and is active.',
        reader,
      );
      expect(res.flagged).toEqual([]);
    });

    it('does not flag an allowlisted name in a non-onboarding ask', () => {
      const res = checkPremiseDeadClaims(
        'Action item: ask June Hale for the Fall webinar schedule.',
        reader,
      );
      expect(res.flagged).toEqual([]);
    });

    it('does not flag a genuinely un-onboarded person', () => {
      const res = checkPremiseDeadClaims(
        'Open item: onboard Tariq Nouri to Coordinator before the semester.',
        reader,
      );
      expect(res.flagged).toEqual([]);
    });

    it('skips silently when the allowlist cannot be read', () => {
      const res = checkPremiseDeadClaims(
        'Open action item: onboard Lin Chen to Coordinator testing.',
        { refresh: () => null, readFile: () => null, exists: () => false },
      );
      expect(res.flagged).toEqual([]);
    });
  });

  describe('applyPremiseDeadVerdict', () => {
    const pass = { annotation: '[sensor: pass]', isFail: false, desc: '' };

    it('turns a PASS into a distinct premise-dead FLAG naming the person', () => {
      const v = applyPremiseDeadVerdict(pass, ['Lin Chen']);
      expect(v.isFail).toBe(false);
      expect(v.annotation).toContain(
        '[sensor: flag: premise-dead-item-surfaced',
      );
      expect(v.annotation).toContain('Lin Chen');
      expect(v.annotation).toContain('EMAIL_ALLOWLIST.md');
    });

    it('never downgrades or alters a FAIL', () => {
      const fail = {
        annotation: '[sensor: fail — wrong | type: factual]',
        isFail: true,
        desc: 'wrong | type: factual',
      };
      expect(applyPremiseDeadVerdict(fail, ['Lin Chen'])).toEqual(fail);
    });

    it('is a no-op when nothing flagged', () => {
      expect(applyPremiseDeadVerdict(pass, [])).toEqual(pass);
    });
  });
});

describe('person-name mismatch pre-check (people-facts ground truth)', () => {
  // Case: a reply expands instructors' first names to surnames the
  // allowlist does not back. No KB ground-truth file carries the surnames,
  // so the expansion is unverifiable — this deterministic check makes
  // EMAIL_ALLOWLIST.md the people ground truth.
  const NAMES_ALLOWLIST_MD = `# Allowlist

| Name | Email | Title | Access | Role |
|------|-------|-------|--------|------|
| Avery Morgan | avery@example.edu | Faculty | read-write | Director |
| June Hale | jhl@example.edu | Admissions | read-only | Admissions |
| Caleb Park | cpark@example.edu | Faculty | read-write | Faculty |
| Caleb Reed | user109@example.edu | Advisor | read-only | Advising |
| Lin Chen | lchen12@example.edu | Faculty | read-write | Faculty |
| Jonas Berg | jberg@example.edu | Faculty | read-write | Faculty |
| Robin Jo Keller | rkeller@example.edu | Staff | read-only | Staff |
| Samuel Rivera | srivera2@example.edu | Faculty | read-write | Faculty |
| Avery Morgan (PeerAgent Agent) | averybot@gmail.com | agent | read-write | G52 |
`;
  const reader = {
    refresh: () => null,
    readFile: (p: string) =>
      p === 'program/EMAIL_ALLOWLIST.md' ? NAMES_ALLOWLIST_MD : null,
    exists: () => false,
  };

  describe('checkPersonNameMismatch', () => {
    it('flags a surname expansion the allowlist does not back', () => {
      const res = checkPersonNameMismatch(
        'ELC 550 is taught by Lin Zhang this fall.',
        reader,
      );
      expect(res.flagged).toEqual([
        { written: 'Lin Zhang', expected: 'Lin Chen' },
      ]);
    });

    it('flags multiple mismatches in one reply (the incident shape)', () => {
      const res = checkPersonNameMismatch(
        'ELC 550 instructors are Lin Zhang and Jonas Steiner.',
        reader,
      );
      expect(res.flagged).toEqual([
        { written: 'Lin Zhang', expected: 'Lin Chen' },
        { written: 'Jonas Steiner', expected: 'Jonas Berg' },
      ]);
    });

    it('does not flag the correct full name', () => {
      const res = checkPersonNameMismatch(
        'Lin Chen and Jonas Berg teach ELC 550.',
        reader,
      );
      expect(res.flagged).toEqual([]);
    });

    it('does not flag a middle-name-dropped form', () => {
      const res = checkPersonNameMismatch(
        'Robin Keller and Robin Jo Keller both refer to the same person.',
        reader,
      );
      expect(res.flagged).toEqual([]);
    });

    it('never flags a NON-unique allowlist first name', () => {
      // Two Calebs (Park, Reed) — "Caleb Zhang" is uncheckable, skip.
      const res = checkPersonNameMismatch(
        'Loop in Caleb Zhang on the analytics module.',
        reader,
      );
      expect(res.flagged).toEqual([]);
    });

    it('never flags an unknown first name (incl. sentence-leading capitals)', () => {
      // "Sam" is not an allowlist first name (his row says Samuel), and
      // "Get" is a sentence-leading capital, not a person.
      const res = checkPersonNameMismatch(
        'Sam Rivera can advise. Get Caleb looped in too.',
        reader,
      );
      expect(res.flagged).toEqual([]);
    });

    it('treats identical duplicate rows as ONE person (still unique)', () => {
      // Two "Avery Morgan" rows (agent marker stripped) — same person, so
      // "Avery" stays unique and a wrong surname still flags.
      const res = checkPersonNameMismatch(
        'Please forward this to Avery Kumar.',
        reader,
      );
      expect(res.flagged).toEqual([
        { written: 'Avery Kumar', expected: 'Avery Morgan' },
      ]);
    });

    it('considers overlapping windows (a preceding Proper word cannot hide a pair)', () => {
      // A consuming regex would match "Professor Lin" and never see
      // "Lin Zhang" — the lookahead-overlap technique catches it.
      const res = checkPersonNameMismatch(
        'Contact Professor Lin Zhang about the syllabus.',
        reader,
      );
      expect(res.flagged).toEqual([
        { written: 'Lin Zhang', expected: 'Lin Chen' },
      ]);
    });

    it('dedupes a repeated mismatch', () => {
      const res = checkPersonNameMismatch(
        'Lin Zhang teaches ELC 550. Reach Lin Zhang via email.',
        reader,
      );
      expect(res.flagged).toEqual([
        { written: 'Lin Zhang', expected: 'Lin Chen' },
      ]);
    });

    it('skips silently when the allowlist cannot be read', () => {
      const res = checkPersonNameMismatch('ELC 550 is taught by Lin Zhang.', {
        refresh: () => null,
        readFile: () => null,
        exists: () => false,
      });
      expect(res.flagged).toEqual([]);
    });
  });

  describe('applyPersonNameVerdict', () => {
    const pass = { annotation: '[sensor: pass]', isFail: false, desc: '' };
    const mismatch = { written: 'Lin Zhang', expected: 'Lin Chen' };

    it('turns a PASS into a person-name-mismatch FLAG with the expected name', () => {
      const v = applyPersonNameVerdict(pass, [mismatch]);
      expect(v.isFail).toBe(false);
      expect(v.annotation).toBe(
        '[sensor: flag: person-name-mismatch — reply says "Lin Zhang", EMAIL_ALLOWLIST.md says Lin Chen]',
      );
    });

    it('joins multiple mismatches with "; "', () => {
      const v = applyPersonNameVerdict(pass, [
        mismatch,
        { written: 'Jonas Steiner', expected: 'Jonas Berg' },
      ]);
      expect(v.desc).toBe(
        'person-name-mismatch — reply says "Lin Zhang", EMAIL_ALLOWLIST.md says Lin Chen; ' +
          'person-name-mismatch — reply says "Jonas Steiner", EMAIL_ALLOWLIST.md says Jonas Berg',
      );
    });

    it('prepends to an existing model FLAG description', () => {
      const flag = {
        annotation: '[sensor: flag: something else]',
        isFail: false,
        desc: 'something else',
      };
      const v = applyPersonNameVerdict(flag, [mismatch]);
      expect(v.desc).toBe(
        'person-name-mismatch — reply says "Lin Zhang", EMAIL_ALLOWLIST.md says Lin Chen; something else',
      );
    });

    it('never downgrades or alters a FAIL', () => {
      const fail = {
        annotation: '[sensor: fail — wrong | type: factual]',
        isFail: true,
        desc: 'wrong | type: factual',
      };
      expect(applyPersonNameVerdict(fail, [mismatch])).toEqual(fail);
    });

    it('leaves error annotations untouched', () => {
      const err = {
        annotation: '[sensor: error: malformed-verdict]',
        isFail: false,
        desc: 'gibberish',
      };
      expect(applyPersonNameVerdict(err, [mismatch])).toEqual(err);
    });

    it('is a no-op when nothing flagged', () => {
      expect(applyPersonNameVerdict(pass, [])).toEqual(pass);
    });
  });
});

describe('reference-existence pre-checks (site URLs, G-rules, course codes)', () => {
  const GOVERNANCE_MD = `# Registry
| ID | Rule |
| G1 | conflict gate |
| G37 | entry gate |
| G55 | stamps |
`;
  const COURSE_NAMES_MD = `| CRS 554 | Introductory Topics One | 4 |
| LAB 513 | Communication Studio | 4 |
| ELC 550 | Applied Methods | 4 |
`;
  const CURRICULUM_SNIPPET = `Prep uses CRS 572 modules. Core includes CRS 557 and CRS 558.`;
  const FILES: Record<string, string> = {
    'program/kb-governance.md': GOVERNANCE_MD,
    'program/course_names.md': COURSE_NAMES_MD,
    'program/curriculum.md': CURRICULUM_SNIPPET,
    'governance.md': '# gov page',
    'updates.md': '# updates page',
    'docs/faq.md': '# faq',
    'docs/coordinator-gate-simulator.html': '<html>',
    'courses/crs554_topics_one.md': '# course',
    'reference/harness-review-2026-07.md': '# internal',
  };
  const refReader = {
    refresh: () => null,
    readFile: (p: string) => FILES[p] ?? null,
    exists: (p: string) => p in FILES,
  };

  describe('checkSiteUrls', () => {
    it('passes root-served pages (/governance, /updates) and real docs', () => {
      const res = checkSiteUrls(
        'See https://program-repo.example.org/governance and https://program-repo.example.org/updates plus https://program-repo.example.org/docs/faq.',
        refReader,
      );
      expect(res.unresolved).toEqual([]);
      expect(res.excluded).toEqual([]);
    });

    it('passes raw .html paths and strips anchors/queries', () => {
      const res = checkSiteUrls(
        'Demo: https://program-repo.example.org/docs/coordinator-gate-simulator.html#run?x=1',
        refReader,
      );
      expect(res.unresolved).toEqual([]);
    });

    it('flags a dead link (the topic_omega class)', () => {
      const res = checkSiteUrls(
        'Your page: https://program-repo.example.org/courses/topic_omega',
        refReader,
      );
      expect(res.unresolved).toEqual(['/courses/topic_omega']);
    });

    it('flags an existing file inside a site-excluded dir, separately', () => {
      const res = checkSiteUrls(
        'https://program-repo.example.org/reference/harness-review-2026-07',
        refReader,
      );
      expect(res.unresolved).toEqual([]);
      expect(res.excluded).toEqual(['/reference/harness-review-2026-07']);
    });

    it('ignores external domains and the bare origin', () => {
      const res = checkSiteUrls(
        'https://github.com/x/y and https://program-repo.example.org/',
        refReader,
      );
      expect(res.unresolved).toEqual([]);
      expect(res.excluded).toEqual([]);
    });
  });

  describe('checkGRuleRefs', () => {
    it('passes known rule IDs and flags phantom ones', () => {
      const res = checkGRuleRefs(
        'Per G37 and G55 this is gated; G99 requires review.',
        refReader,
      );
      expect(res.phantom).toEqual(['G99']);
    });

    it('skips silently when the registry is unreadable', () => {
      const res = checkGRuleRefs('Per G99.', {
        refresh: () => null,
        readFile: () => null,
        exists: () => false,
      });
      expect(res.phantom).toEqual([]);
    });

    it('is quiet when the reply cites no rules', () => {
      expect(checkGRuleRefs('No rules here.', refReader).phantom).toEqual([]);
    });
  });

  describe('checkCourseCodeRefs', () => {
    it('passes canon codes from BOTH canon files (incl. CRS 572 prep)', () => {
      const res = checkCourseCodeRefs(
        'CRS 554 and ELC 550 use CRS 572 prep.',
        refReader,
      );
      expect(res.unknown).toEqual([]);
    });

    it('flags a hallucinated code with a known prefix', () => {
      const res = checkCourseCodeRefs('Enroll in CRS 999.', refReader);
      expect(res.unknown).toEqual(['CRS 999']);
    });

    it('never flags prose numerics with non-canon prefixes', () => {
      const res = checkCourseCodeRefs(
        'A top 100 program with room 204 sessions.',
        refReader,
      );
      expect(res.unknown).toEqual([]);
    });

    it('skips silently when canon files are unreadable', () => {
      const res = checkCourseCodeRefs('CRS 999.', {
        refresh: () => null,
        readFile: () => null,
        exists: () => false,
      });
      expect(res.unknown).toEqual([]);
    });
  });

  describe('tags + mergeFlagIntoVerdict', () => {
    const pass = { annotation: '[sensor: pass]', isFail: false, desc: '' };

    it('builds a combined site-url tag for dead + excluded', () => {
      const tag = siteUrlTag({
        unresolved: ['/x'],
        excluded: ['/reference/y'],
      });
      expect(tag).toContain('site-url-unverified — /x');
      expect(tag).toContain('excluded from the site build');
    });

    it('merges a tag into PASS as a FLAG, chains with existing desc', () => {
      const once = mergeFlagIntoVerdict(
        pass,
        'g-rule-unverified — G99 not found',
      );
      expect(once.annotation).toContain('[sensor: flag: g-rule-unverified');
      const twice = mergeFlagIntoVerdict(
        once,
        'course-code-unverified — CRS 999',
      );
      expect(twice.desc).toContain('course-code-unverified');
      expect(twice.desc).toContain('g-rule-unverified');
    });

    it('null tag is a no-op; FAIL and error are never touched', () => {
      expect(mergeFlagIntoVerdict(pass, null)).toEqual(pass);
      const fail = {
        annotation: '[sensor: fail — x | type: factual]',
        isFail: true,
        desc: 'x',
      };
      expect(mergeFlagIntoVerdict(fail, 'anything')).toEqual(fail);
      const err = {
        annotation: '[sensor: error: malformed-verdict]',
        isFail: false,
        desc: 'g',
      };
      expect(mergeFlagIntoVerdict(err, 'anything')).toEqual(err);
    });
  });
});

describe('commit-hash pre-check (G51)', () => {
  // Case: a reply cites a fabricated commit hash.
  describe('extractCommitHashRefs', () => {
    it('extracts a short hash presented as a commit', () => {
      expect(
        extractCommitHashRefs('Recorded in commit 9990ffa and pushed.'),
      ).toEqual(['9990ffa']);
    });

    it('extracts multiple hashes on a commit-context line', () => {
      expect(
        extractCommitHashRefs('Commits a1b2c3d4 and 55ee66f cover this.'),
      ).toEqual(['a1b2c3d4', '55ee66f']);
    });

    it('ignores hex-looking tokens without commit context', () => {
      // No "commit/sha/hash/rev" wording — a short hex-ish id is not
      // presented as a commit reference.
      expect(
        extractCommitHashRefs('Ticket 9990ffa1 tracks the request.'),
      ).toEqual([]);
    });

    it('always extracts a full 40-char SHA, context or not', () => {
      const sha = 'a'.repeat(39) + '1';
      expect(extractCommitHashRefs(`See ${sha} for details.`)).toEqual([sha]);
    });

    it('ignores English words that are pure a-f hex (no digit)', () => {
      expect(
        extractCommitHashRefs('The commit effaced decades of debate.'),
      ).toEqual([]);
    });
  });

  describe('checkCommitHashes', () => {
    const readerWith = (known: string[]) => ({
      refresh: () => null,
      readFile: () => null,
      exists: () => false,
      commitExists: (h: string) => known.includes(h),
    });

    it('separates verified from unverified hashes', () => {
      const res = checkCommitHashes(
        'Fixed in commit a1b2c3d, follow-up commit 9990ffa pending.',
        readerWith(['a1b2c3d']),
      );
      expect(res.hashes.sort()).toEqual(['9990ffa', 'a1b2c3d']);
      expect(res.unverified).toEqual(['9990ffa']);
    });

    it('skips the check when the reader cannot resolve commits', () => {
      const res = checkCommitHashes('See commit 9990ffa.', {
        refresh: () => null,
        readFile: () => null,
        exists: () => false,
      });
      expect(res.hashes).toEqual(['9990ffa']);
      expect(res.unverified).toEqual([]);
    });
  });

  describe('applyCommitHashVerdict', () => {
    const pass = { annotation: '[sensor: pass]', isFail: false, desc: '' };

    it('turns a PASS into a distinct commit-hash-unverified FLAG', () => {
      const v = applyCommitHashVerdict(pass, ['9990ffa']);
      expect(v.isFail).toBe(false);
      expect(v.annotation).toContain('[sensor: flag: commit-hash-unverified');
      expect(v.annotation).toContain('9990ffa');
    });

    it('keeps the model FLAG description alongside the hash flag', () => {
      const v = applyCommitHashVerdict(
        {
          annotation: '[sensor: flag: propagation-lag — stale]',
          isFail: false,
          desc: 'propagation-lag — stale',
        },
        ['9990ffa'],
      );
      expect(v.annotation).toContain('commit-hash-unverified');
      expect(v.annotation).toContain('propagation-lag');
    });

    it('never downgrades or alters a FAIL', () => {
      const fail = {
        annotation: '[sensor: fail — wrong | type: factual]',
        isFail: true,
        desc: 'wrong | type: factual',
      };
      expect(applyCommitHashVerdict(fail, ['9990ffa'])).toEqual(fail);
    });

    it('is a no-op when every hash verified', () => {
      expect(applyCommitHashVerdict(pass, [])).toEqual(pass);
    });

    it('leaves error annotations untouched', () => {
      const errV = {
        annotation: '[sensor: error: malformed-verdict]',
        isFail: false,
        desc: 'gibberish',
      };
      expect(applyCommitHashVerdict(errV, ['9990ffa'])).toEqual(errV);
    });
  });
});

describe('parseVerdict', () => {
  it('maps PASS to non-fail', () => {
    expect(parseVerdict('PASS').isFail).toBe(false);
  });

  it('maps a propagation-lag FLAG to non-fail', () => {
    const v = parseVerdict(
      'FLAG: propagation-lag — curriculum.md still shows ToolAlpha',
    );
    expect(v.isFail).toBe(false);
    expect(v.annotation).toContain('propagation-lag');
  });

  it('maps FAIL to fail', () => {
    const v = parseVerdict('FAIL: course X overstated as Core | type: factual');
    expect(v.isFail).toBe(true);
  });

  it('treats malformed output as a non-fail error annotation', () => {
    const v = parseVerdict('I think this is fine maybe');
    expect(v.isFail).toBe(false);
    expect(v.annotation).toContain('malformed-verdict');
  });

  it('keeps the trailing | type: tail on a long FAIL description (2026-07-17 truncation)', () => {
    // Regression: a ~230-char description was cut at
    // 200 chars mid-sentence, losing the trailing "| type:" tail and making
    // failTypeFromDesc report "unspecified".
    const longBody =
      'Response claims "no duplicates or status conflicts found" but ACTION_ITEMS.md shows Paige E. Foster has 14 open items — the "gate result" cannot be verified without seeing the actual action item being appended in this session';
    const v = parseVerdict(`FAIL: ${longBody} | type: factual`);
    expect(v.desc).toContain('| type: factual');
    expect(v.desc).toContain('appended in this session');
  });

  it('still caps a runaway single-line description with visible ellipsis', () => {
    const v = parseVerdict(`FAIL: ${'x'.repeat(1000)} | type: factual`);
    expect(v.desc.length).toBeLessThanOrEqual(620);
    expect(v.desc).toContain('…');
  });
});

// --- Integration: runBehaviourSensor with a fixture repo + mocked fetch ---

describe('runBehaviourSensor', () => {
  let repo: string;
  let auditFile: string;
  let sensorId: string;
  let previousHostRepo: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = makeRepo();
    // Triage files and annotations are written in the host-owned repository.
    previousHostRepo = process.env.PROGRAM_HOST_REPO;
    process.env.PROGRAM_HOST_REPO = repo;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    sensorId = makeSensorId('12:00:00');
    auditFile = path.join(repo, 'discussions', 'audit-log', '2026-05-28.md');
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.writeFileSync(
      auditFile,
      `### 12:00:00 — email — outbound\nbody\n${placeholderFor(sensorId)}\n---\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    process.env.PROGRAM_HOST_REPO = previousHostRepo;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('with no SENSOR_MODEL override, the live request names Haiku 5.5 with its shape', async () => {
    expect(process.env.SENSOR_MODEL).toBeUndefined();
    let body: Record<string, unknown> = {};
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      body = JSON.parse(init.body);
      return Promise.resolve(modelReply('PASS'));
    });
    await runBehaviourSensor(
      'Applied Topics Studio is a Core course in the program.',
      auditFile,
      sensorId,
      stubReader,
    );
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body.max_tokens as number).toBeGreaterThanOrEqual(2048);
  });

  it('(symlink) never writes a triage entry through a planted link', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-outside-'));
    const target = path.join(outside, 'secret.env');
    fs.writeFileSync(target, 'KEEP=1\n');
    const triageDir = path.join(repo, 'discussions', 'kb-triage');
    fs.mkdirSync(triageDir, { recursive: true });
    for (const name of fs.readdirSync(triageDir))
      fs.rmSync(path.join(triageDir, name));
    // Plant every plausible daily triage name.
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'America/Chicago',
    });
    fs.symlinkSync(target, path.join(triageDir, `${today}-response-error.md`));
    mockFetch.mockResolvedValue(
      modelReply('FAIL: Applied Topics is Draft, not Core | type: factual'),
    );
    await runBehaviourSensor(
      'Applied Topics Studio is a Core course in the program.',
      auditFile,
      sensorId,
      stubReader,
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP=1\n');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('(symlink) never reads or rewrites an audit file through a planted link', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-outside-'));
    const target = path.join(outside, 'secret.env');
    fs.writeFileSync(target, `ROOT-ONLY ${placeholderFor(sensorId)}\n`);
    fs.rmSync(auditFile);
    fs.symlinkSync(target, auditFile);
    mockFetch.mockResolvedValue(modelReply('PASS'));
    await runBehaviourSensor(
      'The program is 30 credits over 12 months.',
      auditFile,
      sensorId,
      stubReader,
    );
    // Target untouched, and its content was not copied into the repo.
    expect(fs.readFileSync(target, 'utf8')).toBe(
      `ROOT-ONLY ${placeholderFor(sensorId)}\n`,
    );
    expect(fs.lstatSync(auditFile).isSymbolicLink()).toBe(true);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('(a) stale-curriculum / fresh-Confirmed-decision is NOT failed', async () => {
    // Reply matches the Confirmed 2026-05-22 decision but contradicts the
    // stale curriculum.md (which still shows ToolAlpha).
    const reply =
      'LAB 513 Python prep is now sourced from ToolBeta, replacing ToolAlpha.';

    let capturedPrompt = '';
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      capturedPrompt = JSON.parse(init.body).messages[0].content;
      // A correct model, given the Confirmed decision + precedence rule,
      // returns propagation-lag rather than a factual FAIL.
      return Promise.resolve(
        modelReply(
          'FLAG: propagation-lag — curriculum.md still lists ToolAlpha',
        ),
      );
    });

    await runBehaviourSensor(reply, auditFile, sensorId, stubReader);

    // The sensor handed the model the decisive context...
    expect(capturedPrompt).toContain('ToolBeta replaces ToolAlpha');
    expect(capturedPrompt).toContain('PROPAGATION LAG');
    // ...and the verdict was recorded as a non-fail flag.
    const out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: flag:');
    expect(out).not.toContain('[sensor: fail');
    expect(out).not.toContain(placeholderFor(sensorId));
    // No triage file is written for a non-fail.
    expect(fs.existsSync(path.join(repo, 'discussions', 'kb-triage'))).toBe(
      false,
    );
  });

  it('(c) roster-grounded production status reaches the model with roster precedence', async () => {
    // The "8 vs 13" class: curriculum.md says "8 videos recorded" (stale);
    // the Box-synced roster is fresher. The sensor must hand the model the
    // roster + the precedence rule so a roster-matching reply is not failed.
    const reply =
      'CRS 554 Module 2: M2I1 and M2I2 are Recorded as of 2026-05-29; the worked example is still Scripted.';

    let capturedPrompt = '';
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      capturedPrompt = JSON.parse(init.body).messages[0].content;
      return Promise.resolve(modelReply('PASS'));
    });

    await runBehaviourSensor(reply, auditFile, sensorId, stubReader);

    // The roster content and its precedence rule made it into the prompt...
    expect(capturedPrompt).toContain('courses/crs554/sync/activity-roster.md');
    expect(capturedPrompt).toContain('Recorded 2026-05-29');
    expect(capturedPrompt).toContain('roster is authoritative');
    // ...and the verdict landed as a pass.
    const out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: pass]');
    expect(out).not.toContain(placeholderFor(sensorId));
  });

  it('(d) a reply that mentions no synced course gets the "(none)" roster block', async () => {
    const reply = 'The program is 30 credits over 12 months.';

    let capturedPrompt = '';
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      capturedPrompt = JSON.parse(init.body).messages[0].content;
      return Promise.resolve(modelReply('PASS'));
    });

    await runBehaviourSensor(reply, auditFile, sensorId, stubReader);

    expect(capturedPrompt).toContain('(none — no synced roster');
    // Roster fixture content must NOT be injected when off-topic.
    expect(capturedPrompt).not.toContain('Topic Two Overview');
  });

  it('(stop) max_tokens with no text is an explicit error, not a malformed verdict', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        stop_reason: 'max_tokens',
        content: [{ type: 'thinking', thinking: '' }],
      }),
    });
    await runBehaviourSensor(
      'The program is 30 credits over 12 months.',
      auditFile,
      sensorId,
      stubReader,
    );
    const out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: error: max_tokens]');
    expect(out).not.toContain('malformed-verdict');
  });

  it('(stop) a refusal is logged as a refusal', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber' },
        content: [],
      }),
    });
    await runBehaviourSensor(
      'The program is 30 credits over 12 months.',
      auditFile,
      sensorId,
      stubReader,
    );
    expect(fs.readFileSync(auditFile, 'utf-8')).toContain(
      '[sensor: error: refusal]',
    );
  });

  it('(stop) the verdict is read from the text block after a thinking block', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'PASS' },
        ],
      }),
    });
    await runBehaviourSensor(
      'The program is 30 credits over 12 months.',
      auditFile,
      sensorId,
      stubReader,
    );
    expect(fs.readFileSync(auditFile, 'utf-8')).toContain('[sensor: pass]');
  });

  it('(b) a genuine contradiction still FAILs and writes a triage file', async () => {
    // Reply overstates a Draft course as Core — no Confirmed decision backs it.
    const reply = 'Applied Topics Studio is a Core course in the program.';

    mockFetch.mockResolvedValue(
      modelReply('FAIL: Applied Topics is Draft, not Core | type: factual'),
    );

    await runBehaviourSensor(reply, auditFile, sensorId, stubReader);

    const out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: fail');
    expect(out).not.toContain(placeholderFor(sensorId));
    // Triage file recorded for the host to review.
    const triageDir = path.join(repo, 'discussions', 'kb-triage');
    expect(fs.existsSync(triageDir)).toBe(true);
    expect(fs.readdirSync(triageDir).length).toBeGreaterThan(0);
  });

  it('evaluates a replayed FAIL without touching the audit or triage files', async () => {
    mockFetch.mockResolvedValue(
      modelReply('FAIL: CRS 554 is 4 credits, not 3 | type: factual'),
    );
    const before = fs.readFileSync(auditFile, 'utf-8');

    const result = await evaluateBehaviourReply(
      'CRS 554 is 3 credits.',
      stubReader,
      { requestContext: 'How many credits is CRS 554?', refresh: false },
    );

    expect(result.verdict).toBe('fail');
    expect(result.isFail).toBe(true);
    expect(fs.readFileSync(auditFile, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(repo, 'discussions', 'kb-triage'))).toBe(
      false,
    );
  });

  it('labels the triggering request as context rather than a Coordinator claim', async () => {
    let capturedPrompt = '';
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      capturedPrompt = JSON.parse(init.body).messages[0].content;
      return Promise.resolve(modelReply('PASS'));
    });

    await runBehaviourSensor(
      'That analysis follows the paper you supplied.',
      auditFile,
      sensorId,
      stubReader,
      'The paper argues that digital systems have a material layer.',
    );

    expect(capturedPrompt).toContain('CURRENT USER REQUEST');
    expect(capturedPrompt).toContain('The paper argues');
    expect(capturedPrompt).toContain('not Coordinator claims');
  });

  it('applies a decision cutoff only for historical replay evaluation', async () => {
    let capturedPrompt = '';
    mockFetch.mockImplementation((_url: string, init: { body: string }) => {
      capturedPrompt = JSON.parse(init.body).messages[0].content;
      return Promise.resolve(modelReply('PASS'));
    });

    await evaluateBehaviourReply(
      'The Program program is 30 credits.',
      stubReader,
      { asOfDate: '2026-04-30', refresh: false },
    );

    expect(capturedPrompt).toContain('Capstone language clarified');
    expect(capturedPrompt).not.toContain('ToolBeta replaces ToolAlpha');
  });

  it('(e/G40 revert) a tracking-state reply skips the model and passes out-of-scope', async () => {
    // Acceptance #1: correct-or-not, action-item state is operational, not a
    // program fact — the model is never consulted and no ACTION_ITEMS content
    // is loaded.
    const reply =
      'Paige, you have 2 open items: the draft pages corrections and the messaging language update (both assigned at the 2026-06-10 meeting). Both remain open in the tracking file, and the Monday alert will surface them to you again if they are still outstanding at the start of next week.';

    mockFetch.mockImplementation(() => {
      throw new Error('model must not be called for out-of-scope replies');
    });

    await runBehaviourSensor(reply, auditFile, sensorId, stubReader);

    const out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: pass — out-of-scope: tracking-state]');
    expect(out).not.toContain(placeholderFor(sensorId));
  });

  it('(f/G40 revert) out-of-scope replies still run the deterministic pre-checks', async () => {
    // A status-y reply citing a fabricated commit hash must still FLAG (G51)
    // even though the model is skipped — fabrications live in exactly these
    // replies.
    const reply =
      'The action item was checked off and pushed as commit deadbee1234 to the repo; ownership is tracked under her section, and there is nothing further currently tracked for this thread until the owner responds to the follow-up that was assigned at the last meeting.';

    mockFetch.mockImplementation(() => {
      throw new Error('model must not be called for out-of-scope replies');
    });

    // The plain stubReader has no commitExists, which silently skips the
    // hash check — this test needs a reader that can resolve commits.
    const readerWithCommits = {
      ...stubReader,
      commitExists: () => false,
    };
    await runBehaviourSensor(reply, auditFile, sensorId, readerWithCommits);

    const out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: flag:');
    expect(out).toContain('commit-hash-unverified');
  });

  it('(f2/G40 revert) a wrong program-fact claim still fails (acceptance #4)', async () => {
    const reply =
      'Quick status: Paige owns the webpage item, and for context CRS 554 is 3 credits in the current curriculum, which is what I told the faculty member who asked about the introductory topics course earlier today.';
    mockFetch.mockResolvedValue(
      modelReply('FAIL: CRS 554 is 4 credits, not 3 | type: factual'),
    );

    await runBehaviourSensor(reply, auditFile, sensorId, stubReader);

    const out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: fail');
  });

  it('(g/G41) triage entries get a stable time+type anchor heading', async () => {
    const reply = 'Applied Topics Studio is a Core course in the program.';
    mockFetch.mockResolvedValue(
      modelReply('FAIL: Applied Topics is Draft, not Core | type: factual'),
    );

    await runBehaviourSensor(reply, auditFile, sensorId, stubReader);

    const triageDir = path.join(repo, 'discussions', 'kb-triage');
    const file = fs.readdirSync(triageDir)[0];
    const content = fs.readFileSync(path.join(triageDir, file), 'utf-8');
    // Anchorable entry heading: "## HH:MM:SS — <type>" (G41 ask 4).
    expect(content).toMatch(/^## \d{2}:\d{2}:\d{2} — factual$/m);
    expect(content).toContain('**Reviewer note:**');
  });

  it('(h/G51) a fabricated commit hash FLAGs a model-passed reply, verified one does not', async () => {
    // Coordinator cites a commit that does not
    // exist. The model cannot know this; the deterministic pre-check must.
    const hashReader = {
      ...stubReader,
      commitExists: (h: string) => h === 'a1b2c3d',
    };
    mockFetch.mockResolvedValue(modelReply('PASS'));

    await runBehaviourSensor(
      'Recorded the decision and pushed commit 9990ffa to the repo.',
      auditFile,
      sensorId,
      hashReader,
    );

    let out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: flag: commit-hash-unverified');
    expect(out).toContain('9990ffa');
    expect(out).not.toContain('[sensor: fail');
    // FLAG, not FAIL: no triage file.
    expect(fs.existsSync(path.join(repo, 'discussions', 'kb-triage'))).toBe(
      false,
    );

    // A verifiable hash sails through as pass.
    const sensorId2 = makeSensorId('12:05:00');
    fs.appendFileSync(auditFile, `\n${placeholderFor(sensorId2)}\n`);
    await runBehaviourSensor(
      'Recorded the decision and pushed commit a1b2c3d to the repo.',
      auditFile,
      sensorId2,
      hashReader,
    );
    out = fs.readFileSync(auditFile, 'utf-8');
    expect(out).toContain('[sensor: pass');
    expect(out).not.toContain(placeholderFor(sensorId2));
  });
});
