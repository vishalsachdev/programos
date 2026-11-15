import { describe, it, expect } from 'vitest';

import {
  extractCourseCodes,
  extractDistinctiveTerms,
  parseDecisions,
  parseOpenQuestions,
  scanForAutoCloseCandidates,
} from './open-questions-scan.js';

const OPEN_QUESTIONS = `# Program Open Questions

## Vendor Partnership

- [ ] **Platform Alpha partnership: scope and structure.** What is the scope of the Platform Alpha partnership for the program cloud stack? PFA is used in CRS 554 and CRS 558. (Owner: Avery)

## Naming

- [ ] **Topics II canonical name.** Short vs long name for the advanced topics course.
  - (1) sub-point about advanced topics naming
  - (2) another continuation line
- [x] **Already closed item.** This one is checked off and must be skipped.

## Misc

- [ ] **ELC 550 format: SIB vs weekly?** Bianca to confirm with the department. (Owner: Bianca)
`;

const DECISIONS = `# Program Decision Registry

---

### PFA confirmed as program cloud stack

- **Date:** 2026-07-18
- **Stakeholders:** Avery Morgan
- **Decision:** Platform Alpha (PFA) confirmed as the cloud stack for CRS 554 and CRS 558. No formal vendor partnership pursued at launch.
- **Status:** Confirmed

---

### Old decision outside the window

- **Date:** 2026-05-01
- **Decision:** Platform Alpha partnership scope settled long ago.
- **Status:** Confirmed

---

### Undated entry

- **Decision:** Platform Alpha partnership related but has no date field.

---

### Unrelated decision

- **Date:** 2026-07-19
- **Decision:** Orientation welcome packet finalized for onboarding cohort communications.
- **Status:** Confirmed
`;

describe('parseOpenQuestions', () => {
  it('extracts open bullets with titles, skipping checked items', () => {
    const items = parseOpenQuestions(OPEN_QUESTIONS);
    expect(items.map((i) => i.title)).toEqual([
      'Platform Alpha partnership: scope and structure.',
      'Topics II canonical name.',
      'ELC 550 format: SIB vs weekly?',
    ]);
  });

  it('includes indented continuation lines in the item text', () => {
    const items = parseOpenQuestions(OPEN_QUESTIONS);
    const naming = items.find((i) => i.title.startsWith('Topics II'));
    expect(naming?.text).toContain('sub-point about advanced topics');
    expect(naming?.text).toContain('another continuation line');
  });
});

describe('parseDecisions', () => {
  it('parses headings and Date fields', () => {
    const entries = parseDecisions(DECISIONS);
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({
      title: 'PFA confirmed as program cloud stack',
      date: '2026-07-18',
    });
    expect(entries[2].date).toBeNull(); // undated entry
  });
});

describe('term extraction (ported from G47)', () => {
  it('extracts distinctive bigrams and filters noise', () => {
    const terms = extractDistinctiveTerms(
      'Platform Alpha confirmed as the cloud stack',
    );
    expect(terms).toContain('platform alpha');
    expect(terms).toContain('cloud stack');
  });

  it('extracts course codes in all common shapes', () => {
    expect(extractCourseCodes('CRS 554, crs558 and ELC-550')).toEqual([
      'crs 554',
      'crs 558',
      'elc 550',
    ]);
  });
});

describe('scanForAutoCloseCandidates', () => {
  it('flags a question answered by a window-dated decision', () => {
    const result = scanForAutoCloseCandidates(
      OPEN_QUESTIONS,
      DECISIONS,
      '2026-07-15',
    );
    expect(result.openQuestions).toBe(3);
    // PFA + unrelated are in-window; old and undated are excluded.
    expect(result.scannedDecisions).toBe(2);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      question: 'Platform Alpha partnership: scope and structure.',
      decision: 'PFA confirmed as program cloud stack',
      decisionDate: '2026-07-18',
    });
    expect(result.candidates[0].matchedTerms.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes decisions dated before the window (flag-once semantics)', () => {
    const result = scanForAutoCloseCandidates(
      OPEN_QUESTIONS,
      DECISIONS,
      '2026-07-19',
    );
    // Only the unrelated 07-19 decision is in-window → no candidates,
    // even though the old PFA decision would match the open question.
    expect(result.scannedDecisions).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it('keeps one candidate per question — strongest decision wins', () => {
    const decisions = `### Weak match

- **Date:** 2026-07-18
- **Decision:** Platform Alpha partnership mentioned once.

### Strong match

- **Date:** 2026-07-19
- **Decision:** Platform Alpha partnership scope and structure for the program cloud stack settled: PFA for CRS 554 and CRS 558.
`;
    const result = scanForAutoCloseCandidates(
      OPEN_QUESTIONS,
      decisions,
      '2026-07-15',
    );
    const pfa = result.candidates.filter((c) =>
      c.question.startsWith('Platform Alpha'),
    );
    expect(pfa).toHaveLength(1);
    expect(pfa[0].decision).toBe('Strong match');
  });

  it('matches on course code + one distinctive term', () => {
    const decisions = `### ELC 550 format settled

- **Date:** 2026-07-18
- **Decision:** ELC 550 format SIB option ruled out; it will be weekly.
`;
    const result = scanForAutoCloseCandidates(
      OPEN_QUESTIONS,
      decisions,
      '2026-07-15',
    );
    expect(result.candidates.map((c) => c.question)).toContain(
      'ELC 550 format: SIB vs weekly?',
    );
  });

  it('returns an empty scan for empty inputs', () => {
    const result = scanForAutoCloseCandidates('', '', '2026-07-15');
    expect(result).toEqual({
      scannedDecisions: 0,
      openQuestions: 0,
      candidates: [],
    });
  });

  it('caps candidates at 10', () => {
    const questions = Array.from(
      { length: 15 },
      (_, i) =>
        `- [ ] **Question ${i}.** The zanzibar widget rollout question variant about zanzibar widget rollout.`,
    ).join('\n');
    const decisions = `### Zanzibar widget rollout decided

- **Date:** 2026-07-18
- **Decision:** The zanzibar widget rollout is approved everywhere.
`;
    const result = scanForAutoCloseCandidates(
      questions,
      decisions,
      '2026-07-15',
    );
    expect(result.candidates).toHaveLength(10);
  });
});
