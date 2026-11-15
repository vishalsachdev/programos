#!/usr/bin/env node

// Ingestion cross-check (conflict gate v2) — retrieval helper.
//
// Before a fact sourced from an EXTERNAL DOCUMENT (spreadsheet, policy doc,
// meeting notes, attachment) is recorded to DECISIONS.md, this script searches
// the wider KB — courses/*.md, program/curriculum.md, program/course_names.md,
// program/target_profile.md — for incumbent statements about the same entities
// (course prep, instructor, credits, schedule). It does NOT judge conflicts:
// it surfaces the incumbent excerpts so the kb-conflict-check skeptical
// reviewer can compare them against the source document's claim.
//
// v2.1 (G47 amendments):
//   - Distinctive terms are EXTRACTED from the proposed entry text (2-3-gram
//     phrases whose tokens survive a stoplist) instead of a hand-curated
//     SPECIFIC_TERMS list. Nothing course-specific is hardcoded: a
//     "Linear Algebra on the wrong row" error is caught because
//     "linear algebra" is a distinctive bigram of the proposed entry itself.
//   - When NO incumbents are found and the proposed entry is sourced from a
//     spreadsheet cell, the JSON carries `route: "open-questions"` — such a
//     fact must go to discussions/OPEN_QUESTIONS.md for human confirmation,
//     never into DECISIONS.md at any confidence (see SKILL.md Step 2b).
//
// Failure prevented: a source spreadsheet lists a fact on the wrong course's
// row while a course file already states the correct fact.
//
// Exit codes:
//   0 — no incumbent statements found (proceed with the normal DECISIONS-only
//       review path; check `route` for the open-questions hint)
//   3 — incumbent statements found (MUST be included in the skeptical-reviewer
//       context; a contradiction routes the entry to kb-triage/, never to
//       DECISIONS.md)
//   1 — usage / IO error

import fs from 'node:fs';
import path from 'node:path';

// Function words — an n-gram containing any of these is not distinctive.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'will', 'would',
  'with', 'from', 'by', 'as', 'that', 'this', 'these', 'those', 'it',
  'its', 'per', 'not', 'no', 'now', 'new', 'any', 'all', 'we', 'our',
  'they', 'their', 'has', 'have', 'had', 'do', 'does', 'did', 'can',
  'could', 'should', 'must', 'may', 'more', 'most', 'other', 'than',
  'then', 'so', 'if', 'but', 'about', 'into', 'over', 'under', 'before',
  'after', 'between', 'during', 'each', 'every', 'both', 'also', 'only',
  'via', 'see', 'e', 'g', 'i', 'set', 'held', 'covers', 'requires',
]);

// Domain / provenance boilerplate that appears in nearly every proposed entry
// (headers, provenance lines, source-document references) — an n-gram
// containing any of these is registry plumbing, not a distinctive fact.
const DOMAIN_NOISE = new Set([
  'date', 'dates', 'source', 'confidence', 'session', 'status', 'category',
  'decision', 'decisions', 'confirmed', 'proposed', 'superseded',
  'supersedes', 'stakeholder', 'stakeholders', 'rationale', 'spreadsheet',
  'sheet', 'row', 'rows', 'cell', 'cells', 'column', 'attachment',
  'document', 'email', 'telegram', 'meeting', 'notes', 'update', 'updated',
  'course', 'courses', 'program', 'program', 'week', 'weeks', 'student',
  'students', 'high', 'medium', 'low', 'tbd', 'fw', 're',
]);

// Generic single-word attributes: matched only in the proposed entry's OWN
// subject course files and the program/ files — otherwise every course file
// that mentions "credits" would flood the reviewer with noise. (Substring
// detection against the proposed text, prefix match against target lines —
// unchanged from v2.)
const GENERIC_TERMS = [
  'prerequisite',
  'prereq',
  'prep',
  'instructor',
  'faculty',
  'lead',
  'credit',
  'capstone',
  'semester',
  'schedule',
  'tuition',
];

// Token-level view of the generic attributes (incl. common inflections):
// an extracted n-gram made ENTIRELY of these is attribute boilerplate
// ("credit count", "prep schedule") and is not distinctive on its own.
const GENERIC_TOKENS = new Set([
  ...GENERIC_TERMS,
  'prerequisites', 'prereqs', 'preps', 'instructors', 'credits',
  'capstones', 'semesters', 'schedules', 'leads',
]);

const PROGRAM_FILES = ['curriculum.md', 'course_names.md', 'target_profile.md'];

const MAX_MATCHES_PER_FILE = 8;
const MAX_MATCHES_TOTAL = 40;
const MAX_DISTINCTIVE_TERMS = 80;

// A proposed entry whose provenance/body references a spreadsheet artifact.
// Used only for the open-questions routing hint on a no-incumbents result.
const SPREADSHEET_SOURCE_RE =
  /spreadsheet|\.xlsx\b|\.csv\b|\bsheet\b|\brow\s*\d+|\bcell\b/i;

function usage() {
  console.error(
    'Usage: node check-ingestion-crosscheck.mjs --proposed /tmp/proposed.md --kb /workspace/extra/program-repo',
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--proposed') {
      args.proposed = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--kb') {
      args.kb = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministic distinctive-phrase extraction (no LLM): contiguous 2- and
 * 3-grams from each line of the proposed entry whose tokens are all
 * "content" tokens (>=2 chars, no digits, not stopwords, not domain noise)
 * and that are not made entirely of generic attribute words. First-appearance
 * order, deduped, capped. "linear algebra", "qubo formulations",
 * "preparatory coursework" fall out of the entry text itself.
 */
function extractDistinctiveTerms(text) {
  const terms = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const tokens = normalize(line).split(' ').filter(Boolean);
    const eligible = tokens.map(
      (t) =>
        t.length >= 2 &&
        !/\d/.test(t) &&
        !STOPWORDS.has(t) &&
        !DOMAIN_NOISE.has(t),
    );
    for (const n of [2, 3]) {
      for (let i = 0; i + n <= tokens.length; i += 1) {
        let ok = true;
        let allGeneric = true;
        for (let j = i; j < i + n; j += 1) {
          if (!eligible[j]) {
            ok = false;
            break;
          }
          if (!GENERIC_TOKENS.has(tokens[j])) allGeneric = false;
        }
        if (!ok || allGeneric) continue;
        const phrase = tokens.slice(i, i + n).join(' ');
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        terms.push(phrase);
        if (terms.length >= MAX_DISTINCTIVE_TERMS) return terms;
      }
    }
  }
  return terms;
}

// "CRS 554", "crs554", "ELC-550" → "crs 554" / "elc 550"
function extractCourseCodes(text) {
  const codes = new Set();
  const re = /\b(crs|lab|elc)[\s-]?(\d{3})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    codes.add(`${m[1].toLowerCase()} ${m[2]}`);
  }
  return [...codes];
}

// courses/quantum_optimization.md → { code: null, phrase: 'quantum optimization' }
// courses/CRS554_enterprise_db.md → { code: 'crs 554', phrase: 'enterprise db' }
function courseFileIdentity(filename) {
  const base = path.basename(filename, '.md');
  const codeMatch = base.match(/(crs|lab|elc)[\s_-]?(\d{3})/i);
  const code = codeMatch
    ? `${codeMatch[1].toLowerCase()} ${codeMatch[2]}`
    : null;
  const phrase = normalize(
    codeMatch ? base.replace(codeMatch[0], ' ') : base,
  );
  return { code, phrase };
}

// A course file is a "subject" of the proposed entry when the entry mentions
// its course code, its full name phrase, or any contiguous bigram of the name
// ("agentic ai" ⊂ "agentic ai analytics" matches "Agentic AI prep decision").
function isSubjectFile(identity, proposedNorm, proposedCodes) {
  if (identity.code && proposedCodes.includes(identity.code)) return true;
  const words = identity.phrase.split(' ').filter(Boolean);
  if (words.length === 0) return false;
  const phrases = [identity.phrase];
  for (let i = 0; i + 1 < words.length; i += 1) {
    phrases.push(`${words[i]} ${words[i + 1]}`);
  }
  return phrases.some(
    (p) => p.split(' ').length >= 2 && proposedNorm.includes(p),
  );
}

function termsInText(terms, normText) {
  return terms.filter((term) => normText.includes(normalize(term)));
}

function listTargetFiles(kbRoot) {
  const targets = [];

  const coursesDir = path.join(kbRoot, 'courses');
  if (fs.existsSync(coursesDir)) {
    for (const entry of fs.readdirSync(coursesDir)) {
      const full = path.join(coursesDir, entry);
      if (entry.toLowerCase().endsWith('.md') && fs.statSync(full).isFile()) {
        targets.push({ rel: `courses/${entry}`, full, kind: 'course' });
      }
    }
  }

  const programDir = path.join(kbRoot, 'program');
  if (fs.existsSync(programDir)) {
    const wanted = new Set(PROGRAM_FILES.map((f) => f.toLowerCase()));
    for (const entry of fs.readdirSync(programDir)) {
      if (wanted.has(entry.toLowerCase())) {
        targets.push({
          rel: `program/${entry}`,
          full: path.join(programDir, entry),
          kind: 'program',
        });
      }
    }
  }

  return targets;
}

function scanFile(target, terms, matches) {
  if (terms.length === 0) return;
  const regexes = terms.map((term) => ({
    term,
    // Prefix match on the last token so 'credit' hits 'credits',
    // 'prereq' hits 'prereqs'/'prerequisites'.
    re: new RegExp(`\\b${escapeRegExp(term).replace(/ /g, '\\s+')}\\w*`, 'i'),
  }));

  const lines = fs.readFileSync(target.full, 'utf-8').split(/\r?\n/);
  let section = '';
  let perFile = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,6}\s+/.test(line)) section = line.replace(/^#+\s*/, '').trim();
    if (!line.trim()) continue;

    const hit = regexes.find(({ re }) => re.test(line));
    if (!hit) continue;

    matches.push({
      file: target.rel,
      line: i + 1,
      section,
      term: hit.term,
      kind:
        target.kind === 'course' && !target.isSubject
          ? 'incumbent-statement-elsewhere'
          : 'incumbent-statement',
      excerpt: line.trim().slice(0, 300),
    });

    perFile += 1;
    if (perFile >= MAX_MATCHES_PER_FILE || matches.length >= MAX_MATCHES_TOTAL)
      return;
  }
}

function check(proposedText, kbRoot) {
  const proposedNorm = normalize(proposedText);
  const proposedCodes = extractCourseCodes(proposedText);

  const distinctiveTerms = extractDistinctiveTerms(proposedText);
  const genericTerms = termsInText(GENERIC_TERMS, proposedNorm);

  const targets = listTargetFiles(kbRoot);
  const subjectFiles = [];
  for (const target of targets) {
    if (target.kind !== 'course') continue;
    const identity = courseFileIdentity(target.rel);
    target.isSubject = isSubjectFile(identity, proposedNorm, proposedCodes);
    if (target.isSubject) subjectFiles.push(target.rel);
  }

  const matches = [];
  for (const target of targets) {
    const applyGeneric = target.kind === 'program' || target.isSubject;
    const terms = applyGeneric
      ? [...distinctiveTerms, ...genericTerms]
      : distinctiveTerms;
    scanFile(target, terms, matches);
    if (matches.length >= MAX_MATCHES_TOTAL) break;
  }

  const status = matches.length > 0 ? 'incumbents-found' : 'no-incumbents';
  const spreadsheetSourced = SPREADSHEET_SOURCE_RE.test(proposedText);

  const result = {
    status,
    entities: {
      courseCodes: proposedCodes,
      subjectFiles,
      distinctiveTerms,
      genericTerms,
    },
    spreadsheetSourced,
    filesScanned: targets.length,
    matches,
  };

  // G47 amendment (a): a spreadsheet-cell fact with NO incumbent anywhere in
  // the KB has nothing corroborating it — route to OPEN_QUESTIONS.md for
  // human confirmation, never into DECISIONS.md at any confidence. (The
  // SKILL.md caller additionally verifies there is no corroborating prose in
  // the source document before following this hint.)
  if (status === 'no-incumbents' && spreadsheetSourced) {
    result.route = 'open-questions';
  }

  return result;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    usage();
    process.exit(1);
  }

  if (args.help) {
    usage();
    process.exit(0);
  }

  if (!args.proposed || !args.kb) {
    usage();
    process.exit(1);
  }

  let proposedText;
  try {
    proposedText = fs.readFileSync(args.proposed, 'utf-8');
    fs.accessSync(args.kb);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const result = check(proposedText, args.kb);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'incumbents-found' ? 3 : 0);
}

main();
