#!/usr/bin/env node

import fs from 'node:fs';

const STOP_WORDS = new Set([
  'a',
  'about',
  'after',
  'all',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'before',
  'by',
  'can',
  'check',
  'confirm',
  'decide',
  'define',
  'determine',
  'do',
  'does',
  'for',
  'from',
  'get',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'new',
  'of',
  'on',
  'or',
  'other',
  'provide',
  'question',
  'review',
  'should',
  'the',
  'to',
  'update',
  'with',
]);

function usage() {
  console.error(
    'Usage: node check-kb-entry.mjs --current discussions/ACTION_ITEMS.md ' +
      '[--current discussions/OPEN_QUESTIONS.md ...] --proposed /tmp/proposed.md ' +
      '[--kb-root /workspace/extra/program-repo] [--emit-candidates]',
  );
}

function parseArgs(argv) {
  const args = { currents: [] };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--current') {
      args.currents.push(argv[i + 1]);
      i += 1;
    } else if (argv[i] === '--proposed') {
      args.proposed = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--kb-root') {
      args.kbRoot = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--emit-candidates') {
      args.emitCandidates = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  // First --current is the append target; stamping (G55) keys off its name.
  args.current = args.currents[0];
  return args;
}

function stripMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~>#]/g, ' ')
    .replace(/\[[ xX]\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
}

function singularize(token) {
  if (token.length > 5 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && token.endsWith('es')) {
    return token.slice(0, -2);
  }
  if (token.length > 4 && token.endsWith('s')) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text) {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map(singularize)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function firstSentence(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.split(/(?<=[.!?])\s+/)[0] || cleaned;
}

function extractTitle(text) {
  const bold = text.match(/\*\*([^*]+)\*\*/);
  if (bold) return bold[1].trim();

  return text
    .replace(/^\s*-\s*\[[ xX]\]\s*/, '')
    .split(/\s+[—-]\s+|:\s+/)[0]
    .trim();
}

function parseItems(markdown) {
  const lines = markdown.split(/\r?\n/);
  const items = [];
  let current = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const itemMatch = line.match(/^(\s*)-\s*\[([ xX])\]\s+(.*)$/);

    if (itemMatch) {
      if (current) items.push(current);
      const checked = itemMatch[2].toLowerCase() === 'x';
      current = {
        line: i + 1,
        checked,
        text: line.trim(),
      };
      continue;
    }

    if (!current) continue;
    if (/^\s*-\s*\[[ xX]\]\s+/.test(line) || /^#{1,6}\s+/.test(line)) {
      items.push(current);
      current = null;
      continue;
    }
    if (line.trim()) {
      current.text += ` ${line.trim()}`;
    }
  }

  if (current) items.push(current);
  return items;
}

function proposedItems(markdown) {
  const items = parseItems(markdown);
  if (items.length > 0) return items;

  const text = markdown.trim();
  return text
    ? [
        {
          line: 1,
          checked: false,
          text,
        },
      ]
    : [];
}

function isResolutionText(item) {
  if (item.checked) return true;
  const text = item.text.toLowerCase();
  // Past-tense / stative markers only. Bare imperatives like "Complete the
  // Course Map generator" or "Close the loop with Sam" describe open WORK,
  // not a resolution — matching them would tell the agent to check off an
  // existing open item instead of recognizing duplicate open work.
  return (
    text.includes('✅') ||
    /\b(resolved|completed|confirmed|cancelled|canceled|superseded|moot|no longer needed|not needed)\b/.test(
      text,
    ) ||
    /\b(done|closed)\b(?!\s+(with|the|a|an|by|on|via|for))/.test(text)
  );
}

function isExplicitReopen(item) {
  return /\b(reopen|re-open|revisit|reinstat|reactivat)\b/i.test(item.text);
}

function overlap(a, b) {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function scoreItems(proposed, existing) {
  const proposedTitleTokens = tokenSet(extractTitle(proposed.text));
  const existingTitleTokens = tokenSet(extractTitle(existing.text));
  const proposedAllTokens = tokenSet(proposed.text);
  const existingAllTokens = tokenSet(existing.text);

  const titleOverlap = overlap(proposedTitleTokens, existingTitleTokens);
  const fullOverlap = overlap(proposedAllTokens, existingAllTokens);
  const minTitleSize = Math.min(
    proposedTitleTokens.size,
    existingTitleTokens.size,
  );
  const minFullSize = Math.min(proposedAllTokens.size, existingAllTokens.size);

  const titleScore = minTitleSize === 0 ? 0 : titleOverlap / minTitleSize;
  const fullScore = minFullSize === 0 ? 0 : fullOverlap / minFullSize;

  const strongTitleMatch =
    titleOverlap >= 3 && titleScore >= 0.72 && fullOverlap >= 3;
  const strongFullMatch = fullOverlap >= 5 && fullScore >= 0.58;
  const exactTitle =
    extractTitle(proposed.text).toLowerCase() ===
    extractTitle(existing.text).toLowerCase();

  return {
    isMatch: exactTitle || strongTitleMatch || strongFullMatch,
    titleScore,
    fullScore,
    sharedTokens: [...proposedAllTokens].filter((token) =>
      existingAllTokens.has(token),
    ),
  };
}

function classifyIssue(proposed, existing, match) {
  const proposedResolves = isResolutionText(proposed);

  if (!existing.checked && proposedResolves) {
    return {
      kind: 'resolves-existing-open-item',
      reason:
        'The proposed entry appears to resolve or close an existing open item.',
      action:
        'Update/check off the existing item instead of appending a new one.',
    };
  }

  if (!existing.checked) {
    return {
      kind: 'duplicate-open-item',
      reason: 'A similar item is already open.',
      action:
        'Update the existing item with new context instead of appending a duplicate.',
    };
  }

  if (!proposedResolves && !isExplicitReopen(proposed)) {
    return {
      kind: 'reopens-resolved-item',
      reason:
        'A similar item is already marked closed or resolved, but the proposed entry is open.',
      action:
        'Do not append a fresh open item unless the source explicitly reopens it; otherwise update the resolved item with context.',
    };
  }

  if (existing.checked && proposedResolves) {
    return {
      kind: 'duplicate-resolved-item',
      reason: 'A similar resolved item already exists.',
      action:
        'Leave the existing resolved item as-is or add a short update there if useful.',
    };
  }

  return {
    kind: 'similar-existing-item',
    reason: 'A similar item already exists.',
    action: 'Review the existing item before appending.',
  };
}

function check(currentFiles, proposedText) {
  // currentFiles: [{ path, text }] — proposal is scored against every file's
  // items; the reported issue names which file the match lives in.
  const allExisting = [];
  for (const cf of currentFiles) {
    for (const item of parseItems(cf.text)) {
      allExisting.push({ ...item, file: cf.path });
    }
  }
  const proposed = proposedItems(proposedText);
  const issues = [];

  for (const proposedItem of proposed) {
    let best = null;
    for (const existing of allExisting) {
      const match = scoreItems(proposedItem, existing);
      if (!match.isMatch) continue;
      if (!best || match.titleScore + match.fullScore > best.score) {
        best = {
          existing,
          match,
          score: match.titleScore + match.fullScore,
        };
      }
    }

    if (!best) continue;

    const classified = classifyIssue(proposedItem, best.existing, best.match);
    issues.push({
      ...classified,
      proposed: firstSentence(proposedItem.text),
      existing: firstSentence(best.existing.text),
      existingLine: best.existing.line,
      existingFile: best.existing.file,
      match: {
        titleScore: Number(best.match.titleScore.toFixed(2)),
        fullScore: Number(best.match.fullScore.toFixed(2)),
        sharedTokens: best.match.sharedTokens.slice(0, 10),
      },
    });
  }

  return {
    status: issues.length > 0 ? 'blocked' : 'clean',
    checked: {
      proposedItems: proposed.length,
      existingItems: allExisting.length,
    },
    issues,
  };
}

/* ------------------------------------------------------------------ */
/* Candidate retrieval for the v2 semantic pass (SKILL.md step 3).     */
/* Deliberately over-generates: the lexical thresholds above are       */
/* exactly what misses paraphrases, so candidates use a much lower bar */
/* (>=2 shared tokens, or an entity hit). The subagent judges;         */
/* this only bounds its reading list.                                  */
/* ------------------------------------------------------------------ */

/** Proper-name pairs ("June Hale") and course codes ("ELC 550").
 *  Lookahead makes matches overlap: "Get Caleb Park" yields both
 *  "Get Caleb" and "Caleb Park" — over-generation is fine here, the
 *  subagent judges; a consuming match would hide the real name behind a
 *  capitalized sentence-starter. */
export function extractEntities(text) {
  const entities = new Set();
  for (const m of text.matchAll(
    /(?=\b([A-Z][a-z]+\s+(?:[A-Z]\.\s+)?[A-Z][a-z]+)\b)/g,
  )) {
    entities.add(m[1].replace(/\s+/g, ' '));
  }
  for (const m of text.matchAll(/\b(CRS|LAB|ELC|ACCY|MBA)\s?-?\s?(\d{3})\b/gi)) {
    entities.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return [...entities];
}

function entityHit(entities, line) {
  const lower = line.toLowerCase();
  return entities.filter((e) => lower.includes(e.toLowerCase()));
}

/** Low-bar tracking-file candidates for the semantic reviewer. */
function trackingCandidates(currentFiles, proposedText) {
  const entities = extractEntities(proposedText);
  const proposedTokens = tokenSet(proposedText);
  const out = [];
  for (const cf of currentFiles) {
    for (const item of parseItems(cf.text)) {
      const shared = overlap(proposedTokens, tokenSet(item.text));
      const ents = entityHit(entities, item.text);
      if (shared >= 2 || ents.length > 0) {
        out.push({
          file: cf.path,
          line: item.line,
          checked: item.checked,
          sharedTokens: shared,
          entities: ents,
          text: firstSentence(item.text).slice(0, 240),
        });
      }
    }
  }
  out.sort(
    (a, b) => b.sharedTokens + b.entities.length * 3 - (a.sharedTokens + a.entities.length * 3),
  );
  return out.slice(0, 10);
}

const KB_SCAN_DIRS = ['program', 'courses', 'design', 'strategy'];
const KB_EXTRA_FILES = ['discussions/DECISIONS.md'];

function listKbFiles(kbRoot) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        // sync/ snapshots are auto-generated (G14) — noise for judgment.
        if (e.name === 'sync' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (e.name.endsWith('.md')) {
        files.push(full);
      }
    }
  };
  for (const d of KB_SCAN_DIRS) walk(`${kbRoot}/${d}`);
  for (const f of KB_EXTRA_FILES) {
    if (fs.existsSync(`${kbRoot}/${f}`)) files.push(`${kbRoot}/${f}`);
  }
  return files;
}

/** Line-level KB snippets sharing distinctive tokens/entities with the
 *  proposal. This is where "already satisfied" evidence usually lives
 *  (allowlist rows, decision entries, course-file facts). */
function kbCandidates(kbRoot, proposedText) {
  const entities = extractEntities(proposedText);
  const proposedTokens = tokenSet(proposedText);
  const scored = [];
  for (const file of listKbFiles(kbRoot)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim() || line.trim().length < 20) continue;
      const shared = overlap(proposedTokens, tokenSet(line));
      const ents = entityHit(entities, line);
      const score = shared + ents.length * 3;
      if (score >= 3) {
        scored.push({
          file: file.slice(kbRoot.length + 1),
          line: i + 1,
          score,
          entities: ents,
          text: line.trim().slice(0, 240),
        });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // One best line per file first, then runners-up — diversity over depth.
  const byFile = new Map();
  const rest = [];
  for (const s of scored) {
    if (!byFile.has(s.file)) byFile.set(s.file, s);
    else rest.push(s);
  }
  return [...byFile.values(), ...rest].slice(0, 12);
}

/** Today's date in Central, matching the rest of the audit/digest stack. */
export function todayCentral(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Append `(Added: YYYY-MM-DD)` to every open `- [ ]` bullet that lacks one
 * (G55). Emitted as `stampedProposal` so the agent appends deterministic text
 * rather than being asked to remember the convention — the host-side aged
 * monitor reports any open question that still arrives unstamped.
 *
 * Only `- [ ]` bullets are stamped: a `- [x]` entry is already resolved and
 * cannot age.
 */
export function stampAdded(proposedText, today = todayCentral()) {
  return proposedText
    .split('\n')
    .map((line) => {
      if (!/^- \[ \]/.test(line)) return line;
      if (/\(Added:\s*\d{4}-\d{2}-\d{2}\)/.test(line)) return line;
      return `${line.replace(/\s+$/, '')} (Added: ${today})`;
    })
    .join('\n');
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

  if (!args.current || !args.proposed) {
    usage();
    process.exit(1);
  }

  let currentFiles;
  let proposedText;
  try {
    currentFiles = args.currents.map((p) => ({
      path: p,
      text: fs.readFileSync(p, 'utf-8'),
    }));
    proposedText = fs.readFileSync(args.proposed, 'utf-8');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const result = check(currentFiles, proposedText);

  // v2 semantic pass input: over-generated candidates for the subagent.
  // Additive — default output and exit semantics are unchanged.
  if (args.emitCandidates) {
    result.candidates = {
      trackingTwins: trackingCandidates(currentFiles, proposedText),
      kbSnippets: args.kbRoot ? kbCandidates(args.kbRoot, proposedText) : [],
      entities: extractEntities(proposedText),
    };
  }

  // OPEN_QUESTIONS entries carry an `(Added: …)` stamp so the weekly aged
  // monitor can age them (G55). Emit the stamped text for the agent to append
  // verbatim; nothing to remember, nothing to compute by hand.
  if (/OPEN_QUESTIONS\.md$/.test(args.current) && result.status === 'clean') {
    result.stampedProposal = stampAdded(proposedText);
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.status === 'blocked' ? 2 : 0);
}

main();
