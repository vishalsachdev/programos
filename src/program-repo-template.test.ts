import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import {
  checkCourseCodeRefs,
  checkGRuleRefs,
  parseActionItemSections,
  parseAllowlistNames,
  parseConfirmedDecisions,
  type GroundTruthReader,
} from './behaviour-sensor.js';
import { parseTelegramAllowlist } from './channels/telegram-allowlist.js';
import {
  parseAgentPrincipals,
  parseEmailAllowlist,
} from './channels/webhook-allowlist.js';
import { checkGovernanceContracts } from './exceptions-report.js';
import { parseDecisions, parseOpenQuestions } from './open-questions-scan.js';

// Drift guard: templates/program-repo/ is the skeleton an adopter copies. These
// tests run the real parsers over it, so the template and the code that reads
// a program repo cannot disagree without a failing test. Nothing here uses a
// synthetic fixture for the template side.

const ROOT = process.cwd();
const TEMPLATE = join(ROOT, 'templates', 'program-repo');
const CROSSCHECK = join(
  ROOT,
  'container',
  'skills',
  'kb-conflict-check',
  'check-ingestion-crosscheck.mjs',
);

/** Files the code reads by name that the template leaves out on purpose. */
const OPTIONAL_PROGRAM_FILES = ['course_names.md', 'target_profile.md'];

function read(rel: string): string {
  return readFileSync(join(TEMPLATE, rel), 'utf-8');
}

function templateReader(
  overrides: Record<string, string> = {},
): GroundTruthReader & { listDir(relPath: string): string[] | null } {
  const readFile = (rel: string): string | null => {
    if (rel in overrides) return overrides[rel];
    const full = join(TEMPLATE, rel);
    return existsSync(full) && statSync(full).isFile()
      ? readFileSync(full, 'utf-8')
      : null;
  };
  return {
    refresh: () => undefined,
    readFile,
    exists: (rel) => rel in overrides || existsSync(join(TEMPLATE, rel)),
    listDir: (rel) => {
      const full = join(TEMPLATE, rel);
      return existsSync(full) && statSync(full).isDirectory()
        ? readdirSync(full)
        : null;
    },
  };
}

function runCrosscheck(proposedText: string) {
  const dir = mkdtempSync(join(tmpdir(), 'template-crosscheck-'));
  try {
    const proposed = join(dir, 'proposed.md');
    writeFileSync(proposed, proposedText);
    const result = spawnSync(
      process.execPath,
      [CROSSCHECK, '--proposed', proposed, '--kb', TEMPLATE],
      { encoding: 'utf-8' },
    );
    return {
      status: result.status,
      json: result.stdout ? JSON.parse(result.stdout) : null,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every text file under the given repo folders, as [relative path, text]. */
function textFilesUnder(folders: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) walk(child);
      else if (/\.(md|ts|mjs|cjs|js|json|sh)$/.test(entry.name)) {
        out.push([child, readFileSync(join(ROOT, child), 'utf-8')]);
      }
    }
  };
  for (const folder of folders) walk(folder);
  return out;
}

describe('templates/program-repo matches the code that reads it', () => {
  it('contains every path SPEC.md section 5 lists', () => {
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf-8');
    const section = spec.slice(
      spec.indexOf('## 5. Program repository contract'),
      spec.indexOf('## 6. Audit log contract'),
    );
    const paths = [...section.matchAll(/^\| `([^`]+)`/gm)].map((m) => m[1]);
    expect(paths).toContain('docs/faq.md');
    expect(paths.length).toBeGreaterThanOrEqual(12);
    const missing = paths
      // skills/ is marked optional in the table itself.
      .filter((p) => p !== 'skills/')
      .filter((p) => !existsSync(join(TEMPLATE, p)));
    expect(missing).toEqual([]);
  });

  it('allowlist: the email and Telegram parsers read the template rows', () => {
    const md = read('program/EMAIL_ALLOWLIST.md');
    expect([...parseEmailAllowlist(md)].sort()).toEqual([
      'avery@example.edu',
      'dortiz@example.edu',
      'jhl@example.edu',
    ]);
    // The "Retired access" note must not add a handle or an address.
    expect([...parseTelegramAllowlist(md)]).toEqual(['example_admin']);
    expect(parseAgentPrincipals(md).size).toBe(0);
    expect(parseAllowlistNames(md)).toEqual(
      expect.arrayContaining(['Avery Morgan', 'Dana Ortiz', 'June Hale']),
    );
  });

  it('CLAUDE.md passes the host contract check', () => {
    expect(checkGovernanceContracts(templateReader())).toEqual([]);
  });

  it('the empty decision and question logs parse to nothing, without an error', () => {
    const decisions = read('discussions/DECISIONS.md');
    expect(parseConfirmedDecisions(decisions)).toEqual([]);
    expect(parseDecisions(decisions)).toEqual([]);
    expect(parseOpenQuestions(read('discussions/OPEN_QUESTIONS.md'))).toEqual(
      [],
    );
  });

  it('ACTION_ITEMS.md: the example section parses as one owner with one open item', () => {
    const sections = parseActionItemSections(
      read('discussions/ACTION_ITEMS.md'),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].owner).toBe('Avery Morgan');
    expect(sections[0].openCount).toBe(1);
  });

  it('the decision entry format in CLAUDE.md is the one both decision parsers read', () => {
    const claudeMd = read('CLAUDE.md');
    const block = claudeMd.match(/```\n(### <short title>[\s\S]*?)```/);
    expect(block).not.toBeNull();
    const entry = block![1]
      .replace('<short title>', 'Kickoff moved')
      .replace('YYYY-MM-DD', '2030-02-03')
      .replace('<topic>', 'Calendar')
      .replace('<one or two sentences>', 'Kickoff is on the tenth.');
    const md = `${read('discussions/DECISIONS.md')}\n${entry}`;
    expect(parseConfirmedDecisions(md)).toHaveLength(1);
    const scanned = parseDecisions(md);
    expect(scanned).toHaveLength(1);
    expect(scanned[0].date).toBe('2030-02-03');
  });

  it('reply sensor: the registry and course-code checks skip on the template', () => {
    const reader = templateReader();
    // kb-governance.md has no `| G<N> |` rows yet, so nothing is judged.
    expect(checkGRuleRefs('Recorded per G39.', reader)).toEqual({
      phantom: [],
    });
    // No course codes in curriculum.md and no course_names.md: nothing is judged.
    expect(checkCourseCodeRefs('See CRS 999.', reader)).toEqual({
      unknown: [],
    });
  });

  it('reply sensor: program/course_names.md is optional; curriculum.md alone is the canon', () => {
    expect(existsSync(join(TEMPLATE, 'program', 'course_names.md'))).toBe(
      false,
    );
    const reader = templateReader({
      'program/curriculum.md': `${read('program/curriculum.md')}\n- CRS 554 Introductory Topics\n`,
    });
    expect(reader.readFile('program/course_names.md')).toBeNull();
    expect(checkCourseCodeRefs('CRS 554 then CRS 999.', reader)).toEqual({
      unknown: ['CRS 999'],
    });
  });

  it('ingestion cross-check: every program/ file it names is in the template or documented as optional', () => {
    const script = readFileSync(CROSSCHECK, 'utf-8');
    const list = script.match(/const PROGRAM_FILES = \[([^\]]+)\]/);
    expect(list).not.toBeNull();
    const named = [...list![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(named).toContain('curriculum.md');
    const absent = named.filter(
      (f) => !existsSync(join(TEMPLATE, 'program', f)),
    );
    expect(absent.sort()).toEqual([...OPTIONAL_PROGRAM_FILES].sort());
    const readme = read('README.md');
    const spec = readFileSync(join(ROOT, 'SPEC.md'), 'utf-8');
    for (const f of absent) {
      expect(readme).toContain(`program/${f}`);
      expect(spec).toContain(`program/${f}`);
    }
  });

  it('ingestion cross-check: runs on the template with the optional files missing', () => {
    const result = runCrosscheck(`### Kickoff room (2030-02-03)

- **Date:** 2030-02-03
- **Category:** Logistics
- **Decision:** Per the planning spreadsheet (row 4), kickoff uses the
  Maple Atrium.
`);
    expect(result.status).toBe(0);
    expect(result.json.status).toBe('no-incumbents');
    // Only program/curriculum.md: courses/ holds no .md file, and the two
    // optional program files are not there.
    expect(result.json.filesScanned).toBe(1);
    expect(result.json.route).toBe('open-questions');
  });

  it('ingestion cross-check: finds an incumbent in the template curriculum file', () => {
    const result = runCrosscheck(
      'The reply sensor checks answers against a new file.\n',
    );
    expect(result.status).toBe(3);
    expect(result.json.matches[0].file).toBe('program/curriculum.md');
  });

  it('one FAQ path: nothing shipped names discussions/FAQ.md', () => {
    expect(existsSync(join(TEMPLATE, 'docs', 'faq.md'))).toBe(true);
    const offenders = textFilesUnder([
      'src',
      'container',
      'groups',
      'setup',
      'scripts',
      'templates',
    ])
      .filter(([rel]) => !rel.startsWith('scripts/upstream-sync/'))
      .filter(([rel]) => rel !== 'src/program-repo-template.test.ts')
      .filter(([, text]) => /discussions\/faq\.md/i.test(text))
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it('the skills that maintain the FAQ write docs/faq.md', () => {
    for (const skill of ['knowledge-builder', 'quality-review']) {
      const text = readFileSync(
        join(ROOT, 'container', 'skills', skill, 'SKILL.md'),
        'utf-8',
      );
      expect(text).toContain('/workspace/extra/program-repo/docs/faq.md');
    }
  });
});
