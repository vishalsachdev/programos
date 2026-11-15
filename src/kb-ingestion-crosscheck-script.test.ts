import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = join(
  process.cwd(),
  'container',
  'skills',
  'kb-conflict-check',
  'check-ingestion-crosscheck.mjs',
);

// Synthetic program-repo KB for the reversed-row case:
// the Network course file ALREADY carries a linear-algebra pre-course module,
// while the spreadsheet mis-attributed it to the Applied Topics row.
let kbRoot: string;

beforeAll(() => {
  kbRoot = mkdtempSync(join(tmpdir(), 'kb-crosscheck-'));
  mkdirSync(join(kbRoot, 'courses'));
  mkdirSync(join(kbRoot, 'program'));

  writeFileSync(
    join(kbRoot, 'courses', 'network_optimization.md'),
    `# Network Methods for Optimization

### Pre-Course Module: Linear Algebra Foundations

Students complete a linear algebra pre-course module before Week 1 (vectors,
matrices, eigenvalues). Self-paced, with a self-check quiz.

### Weekly Schedule

Week 1: Lattice formulations.
`,
  );

  writeFileSync(
    join(kbRoot, 'courses', 'applied_topics_studio.md'),
    `# Applied Topics

### Course Overview

Team project course on applied topics. No pre-course module.
`,
  );

  writeFileSync(
    join(kbRoot, 'courses', 'elc550_applied_methods.md'),
    `# ELC 550 — Applied Methods

4 credits. Part one of the methods sequence only.
`,
  );

  writeFileSync(
    join(kbRoot, 'program', 'curriculum.md'),
    `# Program Curriculum

30 credits over 12 months.

## Preparatory Coursework

| Course | Prep |
|--------|------|
| ELC 550 | ToolBeta stats prereqs |
| Network Methods for Optimization | Linear algebra pre-course module |
`,
  );

  writeFileSync(
    join(kbRoot, 'program', 'course_names.md'),
    `# Canonical Course Names

- CRS 554 — Introductory Topics One
- ELC 550 — Applied Methods
- Applied Topics (renamed from "Applied Topics Studio", 2030-01-15)
`,
  );

  writeFileSync(
    join(kbRoot, 'program', 'target_profile.md'),
    `# Target Profile

Working professionals from a range of backgrounds.
`,
  );
});

afterAll(() => {
  rmSync(kbRoot, { recursive: true, force: true });
});

function runCrosscheck(proposedText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-crosscheck-proposed-'));
  try {
    const proposed = join(dir, 'proposed.md');
    writeFileSync(proposed, proposedText);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--proposed', proposed, '--kb', kbRoot],
      { encoding: 'utf-8' },
    );
    return {
      ...result,
      json: result.stdout ? JSON.parse(result.stdout) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('kb ingestion cross-check script (conflict gate v2)', () => {
  it('flags a mis-attributed prep-course spreadsheet row so it routes to triage, not DECISIONS.md', () => {
    // The deliberately WRONG row: linear algebra prep attached to Applied Topics.
    const proposed = `### Applied Topics preparatory coursework: Linear Algebra (2026-06-24)

- **Date:** 2026-06-24
- **Category:** Onboarding & Prerequisites
- **Decision:** Per the AY30-31 curriculum spreadsheet (row 14), the Applied Topics
  course requires a Linear Algebra prep module — TBD, Dana to lead.

> _Source: spreadsheet AY30-31 curriculum, row 14 | Date: 2026-06-24 | Confidence: low_
`;

    const result = runCrosscheck(proposed);

    // Exit 3 = incumbents found: the SKILL.md gate forbids auto-recording and
    // requires these excerpts in the skeptical-reviewer context; the resulting
    // contradiction routes the entry to discussions/kb-triage/.
    expect(result.status).toBe(3);
    expect(result.json.status).toBe('incumbents-found');

    // G47 amendment (b): "linear algebra" is NOT hardcoded in the script —
    // it must appear among the n-grams extracted from the entry text itself.
    expect(result.json.entities.distinctiveTerms).toContain('linear algebra');

    // The incumbent linear-algebra statement lives in a DIFFERENT course's
    // file — the reversed-row signal.
    const elsewhere = result.json.matches.filter(
      (m: { kind: string; file: string }) =>
        m.kind === 'incumbent-statement-elsewhere' &&
        m.file === 'courses/network_optimization.md',
    );
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(elsewhere[0].term).toBe('linear algebra');
    expect(elsewhere[0].excerpt.toLowerCase()).toContain('linear algebra');

    // The curriculum prep table is also surfaced as evidence.
    expect(
      result.json.matches.some(
        (m: { file: string }) => m.file === 'program/curriculum.md',
      ),
    ).toBe(true);
  });

  it('surfaces the incumbent as corroboration (not "elsewhere") when the row names the right course', () => {
    const proposed = `### Network Optimization preparatory coursework: Linear Algebra (2026-06-24)

- **Decision:** Per the AY30-31 curriculum spreadsheet, the Network Optimization
  course requires a linear algebra prep module before Week 1.
`;

    const result = runCrosscheck(proposed);

    expect(result.status).toBe(3);
    expect(result.json.entities.subjectFiles).toContain(
      'courses/network_optimization.md',
    );
    const subjectMatches = result.json.matches.filter(
      (m: { file: string }) => m.file === 'courses/network_optimization.md',
    );
    expect(subjectMatches.length).toBeGreaterThan(0);
    for (const m of subjectMatches) {
      expect(m.kind).toBe('incumbent-statement');
    }
  });

  it('passes a fact with no incumbent KB statements', () => {
    const proposed = `### Welcome webinar date set (2026-07-17)

- **Decision:** The cohort welcome webinar will be held on January 15.
`;

    const result = runCrosscheck(proposed);

    expect(result.status).toBe(0);
    expect(result.json.status).toBe('no-incumbents');
    expect(result.json.matches).toEqual([]);
    // Sender-stated fact, not a spreadsheet cell: no open-questions hint.
    expect(result.json.route).toBeUndefined();
  });

  it('routes a bare spreadsheet-cell fact with no incumbent to open-questions (G47a)', () => {
    const proposed = `### Orientation platform (2026-07-17)

- **Decision:** Per the AY30-31 planning spreadsheet ("Logistics" sheet, row 8),
  orientation runs on Platform Alpha.

> _Source: pfoster1@example.edu (AY30-31 planning spreadsheet, "Logistics" sheet, row 8) | Date: 2026-07-17 | Confidence: low_
`;

    const result = runCrosscheck(proposed);

    // No incumbent anywhere in the KB + bare spreadsheet-cell source →
    // the fact must be recorded in OPEN_QUESTIONS.md pending human
    // confirmation, never in DECISIONS.md at any confidence.
    expect(result.status).toBe(0);
    expect(result.json.status).toBe('no-incumbents');
    expect(result.json.spreadsheetSourced).toBe(true);
    expect(result.json.route).toBe('open-questions');
  });

  it('catches a reversed-row fact via extracted n-grams with no hardcoded term list (G47b)', () => {
    // "Lattice formulations" appears in NO curated list anywhere — it must be
    // caught purely because the bigram extracted from the proposed entry
    // already lives in a DIFFERENT course's file (the reversed-row signal).
    const proposed = `### CRS 554 Week 1 topic (2026-07-17)

- **Decision:** Per the AY30-31 curriculum spreadsheet (row 3), CRS 554
  Week 1 covers Lattice formulations.
`;

    const result = runCrosscheck(proposed);

    expect(result.status).toBe(3);
    expect(result.json.entities.distinctiveTerms).toContain(
      'lattice formulations',
    );
    const elsewhere = result.json.matches.filter(
      (m: { kind: string; file: string; term: string }) =>
        m.kind === 'incumbent-statement-elsewhere' &&
        m.file === 'courses/network_optimization.md',
    );
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(elsewhere[0].term).toBe('lattice formulations');
  });

  it('does not drag unrelated course files in on generic terms like "credits"', () => {
    const proposed = `### CRS 554 credit count confirmed (2026-07-17)

- **Decision:** Per the AY30-31 spreadsheet, CRS 554 is 4 credits.
`;

    const result = runCrosscheck(proposed);

    // elc550 mentions "4 credits" too, but it is not a subject of this entry
    // and "credit" is a generic term — must not match there.
    expect(
      result.json.matches.some(
        (m: { file: string }) => m.file === 'courses/elc550_applied_methods.md',
      ),
    ).toBe(false);
    // The program-level curriculum file IS checked for generic terms.
    expect(
      result.json.matches.some(
        (m: { file: string }) => m.file === 'program/curriculum.md',
      ),
    ).toBe(true);
  });
});
