import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

import { describe, expect, it } from 'vitest';

const SCRIPT = join(
  process.cwd(),
  'container',
  'skills',
  'kb-entry-gate',
  'check-kb-entry.mjs',
);

function withTempFiles<T>(
  currentText: string,
  proposedText: string,
  fn: (paths: { current: string; proposed: string }) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), 'kb-entry-gate-'));
  try {
    const current = join(dir, 'current.md');
    const proposed = join(dir, 'proposed.md');
    writeFileSync(current, currentText);
    writeFileSync(proposed, proposedText);
    return fn({ current, proposed });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runGate(currentText: string, proposedText: string) {
  return withTempFiles(currentText, proposedText, ({ current, proposed }) => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--current', current, '--proposed', proposed],
      { encoding: 'utf-8' },
    );
    return {
      ...result,
      json: result.stdout ? JSON.parse(result.stdout) : null,
    };
  });
}

describe('kb-entry-gate script', () => {
  it('blocks a duplicate open action item before append', () => {
    const current = `# Program Action Items

## Paige

- [ ] **Partner with Chet on Canvas development for preparatory coursework** — develop Canvas-based modules for preparatory courses.
`;
    const proposed = `- [ ] **Partner with Chet on Canvas development for preparatory coursework** — Chet and Paige should build the Canvas prep modules.`;

    const result = runGate(current, proposed);

    expect(result.status).toBe(2);
    expect(result.json.status).toBe('blocked');
    expect(result.json.issues[0].kind).toBe('duplicate-open-item');
  });

  it('blocks a resolved update that should close an existing open question', () => {
    const current = `# Program Open Questions

## Synchronous Requirements

- [ ] **Live Session and Project Studio day/time scheduling:** Will the weekly Live Session and Project Studio be held on the same day, or staggered?
`;
    const proposed = `- [x] **Live Session and Project Studio day/time scheduling resolved** — Dana confirmed the two days.`;

    const result = runGate(current, proposed);

    expect(result.status).toBe(2);
    expect(result.json.status).toBe('blocked');
    expect(result.json.issues[0].kind).toBe('resolves-existing-open-item');
  });

  it('blocks a new open item that reopens a resolved question without saying so', () => {
    const current = `# Program Open Questions

## Onboarding & Prerequisites

- [x] **Prep-course passing threshold (Canvas quiz score).** Resolved 2030-01-15: the quizzes are self-diagnostic.
`;
    const proposed = `- [ ] **Prep-course passing threshold for Canvas quizzes** — decide what score students must achieve.`;

    const result = runGate(current, proposed);

    expect(result.status).toBe(2);
    expect(result.json.status).toBe('blocked');
    expect(result.json.issues[0].kind).toBe('reopens-resolved-item');
  });

  it('passes a genuinely new open item', () => {
    const current = `# Program Open Questions

## Vendor Partnership

- [ ] **Vendor Alpha partnership: scope and structure.** Should Program pursue a formal Vendor Alpha partnership?
`;
    const proposed = `- [ ] **Should the August retreat include a Coordinator live demo?** Decide whether Coordinator should be part of the August retreat agenda.`;

    const result = runGate(current, proposed);

    expect(result.status).toBe(0);
    expect(result.json.status).toBe('clean');
    expect(result.json.issues).toEqual([]);
  });

  it('treats an imperative "Complete X" as duplicate open work, not a resolution', () => {
    const current = `# Program Action Items

## Avery

- [ ] **Complete Course Map generator for synced courses** — build the generator that renders Course Map.xlsx into markdown.
`;
    const proposed = `- [ ] **Complete Course Map generator for synced courses** — generator still needed for the Box-synced Course Map files.`;

    const result = runGate(current, proposed);

    expect(result.status).toBe(2);
    // Must NOT be classified as resolving the existing item — both are open work.
    expect(result.json.issues[0].kind).toBe('duplicate-open-item');
  });
});

/** Same as runGate, but the current file is literally named OPEN_QUESTIONS.md
 *  — the stamping path keys off that filename. */
function runGateOnOpenQuestions(currentText: string, proposedText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-entry-gate-oq-'));
  try {
    const current = join(dir, 'OPEN_QUESTIONS.md');
    const proposed = join(dir, 'proposed.md');
    writeFileSync(current, currentText);
    writeFileSync(proposed, proposedText);
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '--current', current, '--proposed', proposed],
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

describe('kb-entry-gate v2: multi-file + candidates (G37 v2)', () => {
  function runV2(opts: {
    files: Record<string, string>; // relative name -> content; first key = append target
    proposed: string;
    kbFiles?: Record<string, string>; // kb-root relative path -> content
    emitCandidates?: boolean;
  }) {
    const dir = mkdtempSync(join(tmpdir(), 'kb-entry-gate-v2-'));
    try {
      const argv: string[] = [SCRIPT];
      for (const [name, content] of Object.entries(opts.files)) {
        const p = join(dir, name);
        writeFileSync(p, content);
        argv.push('--current', p);
      }
      const proposed = join(dir, 'proposed.md');
      writeFileSync(proposed, opts.proposed);
      argv.push('--proposed', proposed);
      if (opts.kbFiles) {
        const kbRoot = join(dir, 'kb');
        for (const [rel, content] of Object.entries(opts.kbFiles)) {
          const full = join(kbRoot, rel);
          mkdirSync(join(full, '..'), { recursive: true });
          writeFileSync(full, content);
        }
        argv.push('--kb-root', kbRoot);
      }
      if (opts.emitCandidates) argv.push('--emit-candidates');
      const result = spawnSync(process.execPath, argv, { encoding: 'utf-8' });
      return {
        ...result,
        json: result.stdout ? JSON.parse(result.stdout) : null,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('blocks against a twin in the SECOND --current file, naming it', () => {
    const result = runV2({
      files: {
        'OPEN_QUESTIONS.md':
          '# OQ\n\n- [ ] **Unrelated question?** something else entirely.\n',
        'ACTION_ITEMS.md':
          '# AI\n\n- [ ] **ELC 550 format: SIB vs weekly?** Bianca to confirm with the department whether ELC 550 will be delivered as a Single Intensive Block (SIB) or weekly.\n',
      },
      proposed:
        '- [ ] **ELC 550 format: SIB vs weekly?** confirm SIB or weekly with the department.',
    });
    expect(result.status).toBe(2);
    expect(result.json.status).toBe('blocked');
    expect(result.json.issues[0].existingFile).toMatch(/ACTION_ITEMS\.md$/);
  });

  it('still stamps off the FIRST --current file when it is OPEN_QUESTIONS.md', () => {
    const result = runV2({
      files: {
        'OPEN_QUESTIONS.md': '# OQ\n\n',
        'ACTION_ITEMS.md': '# AI\n\n- [ ] **Something else entirely** here.\n',
      },
      proposed: '- [ ] **Brand new question?** with fresh content. (Owner: V)',
    });
    expect(result.json.status).toBe('clean');
    expect(result.json.stampedProposal).toMatch(
      /\(Added: \d{4}-\d{2}-\d{2}\)$/,
    );
  });

  it('emit-candidates: over-generates below block threshold (paraphrase case)', () => {
    const result = runV2({
      files: {
        'ACTION_ITEMS.md':
          '# AI\n\n- [ ] **ELC 550 format: SIB vs weekly?** Bianca to confirm with the department whether ELC 550 will be delivered as a Single Intensive Block (SIB) or weekly.\n',
      },
      proposed:
        '- [ ] **How will the ELC 550 instructor deliver it?** Need to settle whether that teaching is a single intensive block or spread across regular weeks.',
      emitCandidates: true,
    });
    // Lexical gate misses the paraphrase (this is the measured v1 gap)…
    expect(result.json.status).toBe('clean');
    // …but the candidate pre-filter must still surface the twin for the subagent.
    const twins = result.json.candidates.trackingTwins;
    expect(twins.length).toBeGreaterThan(0);
    expect(twins[0].file).toMatch(/ACTION_ITEMS\.md$/);
    expect(result.json.candidates.entities).toContain('ELC 550');
  });

  it('emit-candidates: kb snippets surface allowlist rows via entity hit', () => {
    const result = runV2({
      files: { 'ACTION_ITEMS.md': '# AI\n\n' },
      proposed:
        '- [ ] **Get Caleb Park set up on the KB bot** so he can send updates.',
      kbFiles: {
        'program/EMAIL_ALLOWLIST.md':
          '# Allowlist\n\n| Caleb Park | cpark@example.edu | Faculty | read-write | Faculty — course content |\n',
        'program/other.md':
          '# Other\n\nNothing relevant in this file at all.\n',
      },
      emitCandidates: true,
    });
    expect(result.json.status).toBe('clean'); // lexical layer sees nothing
    const snippets = result.json.candidates.kbSnippets;
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets[0].file).toBe('program/EMAIL_ALLOWLIST.md');
    expect(snippets[0].entities).toContain('Caleb Park');
  });

  it('emit-candidates: skips auto-generated sync/ dirs', () => {
    const result = runV2({
      files: { 'ACTION_ITEMS.md': '# AI\n\n' },
      proposed: '- [ ] **Check ELC 550 roster status** for production.',
      kbFiles: {
        'courses/elc550/sync/activity-roster.md':
          'ELC 550 ELC 550 ELC 550 roster roster production status status\n',
        'courses/elc550.md':
          '# ELC 550\n\nELC 550 production roster status notes.\n',
      },
      emitCandidates: true,
    });
    const files = result.json.candidates.kbSnippets.map(
      (s: { file: string }) => s.file,
    );
    expect(files).toContain('courses/elc550.md');
    expect(files.every((f: string) => !f.includes('/sync/'))).toBe(true);
  });

  it('without --emit-candidates the output shape is unchanged (no candidates key)', () => {
    const result = runV2({
      files: { 'ACTION_ITEMS.md': '# AI\n\n' },
      proposed: '- [ ] **Anything at all** new here.',
    });
    expect(result.json.candidates).toBeUndefined();
  });
});

const TODAY_CENTRAL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

describe('kb-entry-gate Added: stamping (G55)', () => {
  const EMPTY_OQ = '# Program Open Questions\n\n';

  it('stamps a clean open-question proposal with today (Central)', () => {
    const result = runGateOnOpenQuestions(
      EMPTY_OQ,
      '- [ ] **Should we pilot X in cohort 1?** context here. (Owner: Avery)',
    );
    expect(result.status).toBe(0);
    expect(result.json.status).toBe('clean');
    expect(result.json.stampedProposal).toBe(
      `- [ ] **Should we pilot X in cohort 1?** context here. (Owner: Avery) (Added: ${TODAY_CENTRAL})`,
    );
  });

  it('does not double-stamp an already-stamped bullet', () => {
    const already = `- [ ] **Already dated?** body (Added: 2026-01-15)`;
    const result = runGateOnOpenQuestions(EMPTY_OQ, already);
    expect(result.json.stampedProposal).toBe(already);
  });

  it('leaves resolved [x] bullets unstamped — they cannot age', () => {
    const result = runGateOnOpenQuestions(
      EMPTY_OQ,
      '- [x] **Already answered.** resolved inline.',
    );
    expect(result.json.stampedProposal).toBe(
      '- [x] **Already answered.** resolved inline.',
    );
  });

  it('stamps each bullet of a multi-item proposal', () => {
    const result = runGateOnOpenQuestions(
      EMPTY_OQ,
      '- [ ] **First?** a\n- [ ] **Second?** b',
    );
    const lines = result.json.stampedProposal.split('\n');
    expect(lines[0]).toBe(`- [ ] **First?** a (Added: ${TODAY_CENTRAL})`);
    expect(lines[1]).toBe(`- [ ] **Second?** b (Added: ${TODAY_CENTRAL})`);
  });

  it('omits stampedProposal for ACTION_ITEMS.md (no aging there)', () => {
    const result = runGate(
      '# Program Action Items\n\n## Avery\n\n',
      '- [ ] **Do a brand new thing** with no overlap whatsoever.',
    );
    expect(result.json.status).toBe('clean');
    expect(result.json.stampedProposal).toBeUndefined();
  });

  it('omits stampedProposal when the gate blocks — nothing to append', () => {
    const current = `# Program Open Questions

- [ ] **Should cybersecurity be a named thread in the curriculum?** panelists cited it as a differentiator.
`;
    const result = runGateOnOpenQuestions(
      current,
      '- [ ] **Should cybersecurity be a named thread in the curriculum?** recruiters keep raising it as a differentiator.',
    );
    expect(result.json.status).toBe('blocked');
    expect(result.json.stampedProposal).toBeUndefined();
  });
});
