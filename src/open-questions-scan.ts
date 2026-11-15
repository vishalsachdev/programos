/**
 * OPEN_QUESTIONS auto-close scanner (advisory only).
 *
 * Finds open questions that recent DECISIONS.md entries appear to answer,
 * so implicitly-resolved questions don't sit open for weeks.
 *
 * Design:
 * - Scans only decisions DATED within the report window (7 days) against
 *   ALL open questions — each decision gets one chance to flag matches, so
 *   an ignored candidate is not re-nagged every Monday and no suppression
 *   state is maintained (derive, don't maintain).
 * - Deterministic text matching, no LLM. Term extraction is ported from the
 *   G47 ingestion cross-check (container/skills/kb-conflict-check/
 *   check-ingestion-crosscheck.mjs) — kept as a copy because that file is
 *   container-side plain JS copied into agent containers; importing it from
 *   host TS would couple across the container boundary.
 * - Advisory only: results go into the Monday Health Report digest
 *   (exceptions-report.ts design rule: new monitors report INTO the digest).
 *   Nothing writes to OPEN_QUESTIONS.md; a human confirms each closure.
 */

// --- term extraction (ported from check-ingestion-crosscheck.mjs, G47) ---

const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'in',
  'on',
  'at',
  'to',
  'for',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'will',
  'would',
  'with',
  'from',
  'by',
  'as',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'per',
  'not',
  'no',
  'now',
  'new',
  'any',
  'all',
  'we',
  'our',
  'they',
  'their',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'must',
  'may',
  'more',
  'most',
  'other',
  'than',
  'then',
  'so',
  'if',
  'but',
  'about',
  'into',
  'over',
  'under',
  'before',
  'after',
  'between',
  'during',
  'each',
  'every',
  'both',
  'also',
  'only',
  'via',
  'see',
  'e',
  'g',
  'i',
  'set',
  'held',
  'covers',
  'requires',
]);

const DOMAIN_NOISE = new Set([
  'date',
  'dates',
  'source',
  'confidence',
  'session',
  'status',
  'category',
  'decision',
  'decisions',
  'confirmed',
  'proposed',
  'superseded',
  'supersedes',
  'stakeholder',
  'stakeholders',
  'rationale',
  'spreadsheet',
  'sheet',
  'row',
  'rows',
  'cell',
  'cells',
  'column',
  'attachment',
  'document',
  'email',
  'telegram',
  'meeting',
  'notes',
  'update',
  'updated',
  'course',
  'courses',
  'program',
  'program',
  'week',
  'weeks',
  'student',
  'students',
  'high',
  'medium',
  'low',
  'tbd',
  'fw',
  're',
  // Scanner-specific noise: open-question plumbing words that would
  // otherwise match nearly every item ("(Owner: Avery)" etc.).
  'owner',
  'owners',
  'voice',
  'resolved',
  'open',
  'question',
  'questions',
  // URL / file-path boilerplate — real-data validation showed "exampleonline
  // example", "example edu", "strategy md" flagging unrelated questions.
  'http',
  'https',
  'www',
  'com',
  'edu',
  'org',
  'md',
  'example',
  'example-college',
  'exampleonline',
]);

const GENERIC_TOKENS = new Set([
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
  'prerequisites',
  'prereqs',
  'preps',
  'instructors',
  'credits',
  'capstones',
  'semesters',
  'schedules',
  'leads',
]);

const MAX_DISTINCTIVE_TERMS = 80;

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic distinctive-phrase extraction (no LLM): contiguous 2- and
 * 3-grams from each line whose tokens are all "content" tokens (>=2 chars,
 * no digits, not stopwords, not domain noise) and that are not made
 * entirely of generic attribute words.
 */
export function extractDistinctiveTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
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

/** "CRS 554", "crs554", "ELC-550" → "crs 554" / "elc 550" */
export function extractCourseCodes(text: string): string[] {
  const codes = new Set<string>();
  const re = /\b(crs|lab|elc)[\s-]?(\d{3})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    codes.add(`${m[1].toLowerCase()} ${m[2]}`);
  }
  return [...codes];
}

// --- parsers ---

export interface OpenQuestionItem {
  /** Bold title of the bullet (or its first 100 chars when untitled). */
  title: string;
  /** Full text of the bullet incl. indented continuation lines. */
  text: string;
}

/**
 * Open (unchecked) `- [ ]` bullets, each with its indented continuation
 * lines. Checked `- [x]` items and section headings are skipped.
 */
export function parseOpenQuestions(content: string): OpenQuestionItem[] {
  const items: OpenQuestionItem[] = [];
  const lines = content.split(/\r?\n/);
  let current: string[] | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.join('\n');
    const titleMatch = text.match(/\*\*(.+?)\*\*/);
    items.push({
      title: (titleMatch ? titleMatch[1] : text.slice(6, 106)).trim(),
      text,
    });
    current = null;
  };
  for (const line of lines) {
    if (/^- \[ \]/.test(line)) {
      flush();
      current = [line];
    } else if (current && /^\s+\S/.test(line)) {
      current.push(line); // indented continuation (sub-bullets, corrections)
    } else {
      flush();
    }
  }
  flush();
  return items;
}

export interface DecisionEntry {
  /** `### ` heading of the entry. */
  title: string;
  /** `- **Date:** YYYY-MM-DD` field value, or null when missing/unparseable. */
  date: string | null;
  /** Full entry text (heading through the end of the block). */
  text: string;
}

/** `### `-headed DECISIONS.md entries with their `- **Date:**` field. */
export function parseDecisions(content: string): DecisionEntry[] {
  const entries: DecisionEntry[] = [];
  const blocks = content.split(/^### /m).slice(1);
  for (const block of blocks) {
    const title = (block.split(/\r?\n/, 1)[0] || '').trim();
    const dateMatch = block.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    entries.push({
      title,
      date: dateMatch ? dateMatch[1] : null,
      text: block,
    });
  }
  return entries;
}

// --- scanner ---

export interface AutoCloseCandidate {
  question: string;
  decision: string;
  decisionDate: string;
  matchedTerms: string[];
}

export interface ScanResult {
  /** Decisions dated within the window that were scanned. */
  scannedDecisions: number;
  openQuestions: number;
  candidates: AutoCloseCandidate[];
}

const MAX_CANDIDATES = 10;

/**
 * Decision text used for term extraction: metadata fields and provenance
 * lines are dropped. Real-data validation showed the `Stakeholders:` field
 * producing name-pair terms ("paige foster", "felix stone") that flag any
 * question mentioning the same people, regardless of topic — names only
 * count when they appear in the Decision/Rationale body itself.
 */
export function decisionMatchText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*-\s*\*\*(Stakeholders|Source|Date|Status|Category|Confidence|Evidence|Supersedes):/i.test(
          line,
        ) && !/^\s*>\s*_?Source:/i.test(line),
    )
    .join('\n');
}

/**
 * Match rule: a decision flags a question when >=2 of the decision's
 * distinctive terms appear in the question text, or a shared course code
 * plus >=1 term. One candidate per question (strongest decision wins),
 * strongest-first, capped at MAX_CANDIDATES.
 */
export function scanForAutoCloseCandidates(
  openQuestionsMd: string,
  decisionsMd: string,
  sinceDate: string,
): ScanResult {
  const questions = parseOpenQuestions(openQuestionsMd);
  const recent = parseDecisions(decisionsMd).filter(
    (d) => d.date !== null && d.date >= sinceDate,
  );

  // strength per question title, keeping only the best-matching decision
  const best = new Map<
    string,
    { candidate: AutoCloseCandidate; strength: number }
  >();

  for (const decision of recent) {
    const matchText = decisionMatchText(decision.text);
    const terms = extractDistinctiveTerms(matchText);
    const codes = extractCourseCodes(matchText);
    if (terms.length === 0 && codes.length === 0) continue;
    for (const q of questions) {
      const qNorm = normalize(q.text);
      const termHits = terms.filter((t) => qNorm.includes(t));
      const codeHits = codes.filter((c) => qNorm.includes(c));
      const isMatch =
        termHits.length >= 2 || (codeHits.length >= 1 && termHits.length >= 1);
      if (!isMatch) continue;
      const strength = termHits.length + codeHits.length;
      const prev = best.get(q.title);
      if (prev && prev.strength >= strength) continue;
      best.set(q.title, {
        strength,
        candidate: {
          question: q.title.slice(0, 160),
          decision: decision.title.slice(0, 160),
          decisionDate: decision.date as string,
          matchedTerms: [...codeHits, ...termHits].slice(0, 6),
        },
      });
    }
  }

  const candidates = [...best.values()]
    .sort((a, b) => b.strength - a.strength)
    .slice(0, MAX_CANDIDATES)
    .map((b) => b.candidate);

  return {
    scannedDecisions: recent.length,
    openQuestions: questions.length,
    candidates,
  };
}
