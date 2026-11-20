/**
 * Behaviour Sensor — Post-outbound response check.
 *
 * Runs as a host-side hook after each outbound message is logged. Calls the
 * Anthropic API with a separate skeptical-reviewer prompt (Haiku 4.5 by default)
 * to verify the reply against ground-truth files in the program-repo repo:
 *
 *   - program/CURRICULUM.md  (primary factual ground truth)
 *   - discussions/DECISIONS.md  (Confirmed entries, relevance-selected; newer
 *     than curriculum.md, so a match there means propagation-lag, not a FAIL)
 *   - courses/<code>/sync/activity-roster.md  (Box-synced production rosters,
 *     topic-gated: only courses the reply mentions; freshest source for module
 *     items, video details, and production status)
 *   - precomputed citation existence
 *
 * The verdict is written back into the audit-log file by replacing the
 * `[sensor: pending:<id>]` placeholder that logOutbound wrote alongside
 * the entry. Phase 1 of docs/behaviour-sensor-spec.md (program-repo).
 *
 * Why host-side and not a container skill: audit-log writes happen on the
 * host AFTER Coordinator's container exits, so the container can't annotate its
 * own entry. The host has the reply text in hand and can run a separate
 * inferential pass deterministically — matching the spec's "separate
 * reviewer" intent more reliably than a probabilistic CLAUDE.md instruction.
 */
import fs from 'fs';
import path from 'path';

import { TIMEZONE } from './config.js';
import { stripInternalTags } from './delivery-gate.js';
import { readEnvFile } from './env.js';
import {
  messagesUrl,
  readFoundrySettings,
  readPrimaryProviderName,
} from './model-provider.js';
import { logger } from './logger.js';
import { getRepoReader } from './repo-reader.js';
import { ensureHostRepo, getHostRepoPath } from './host-repo.js';
import {
  appendToCheckout,
  readFromCheckout,
  writeToCheckout,
} from './checkout-fs.js';
import { localDateYmd } from './timezone.js';

/**
 * Default behaviour-sensor model. Haiku 4.5 (claude-haiku-4-5-20251001) is
 * no longer used here; Haiku 5.5 is the current Haiku.
 * scripts/eval-sensor.ts imports this so the eval artifact names the same
 * model the service runs.
 */
export const DEFAULT_SENSOR_MODEL = 'claude-haiku-5-5';
const SENSOR_MODEL = process.env.SENSOR_MODEL || DEFAULT_SENSOR_MODEL;
const SENSOR_TIMEOUT_MS = 30000;
const SENSOR_REQUEST_CONTEXT_CAP = 4000;

/**
 * Ground-truth reads come from the pinned read-mirror SHA (RepoReader), never
 * the writable checkout. Tests inject a stub. Writes (triage files, audit-log
 * placeholder replacement) stay on the live filesystem — Phase 2 scope.
 */
export interface GroundTruthReader {
  refresh(opts?: { force?: boolean }): unknown;
  readFile(relPath: string): string | null;
  exists(relPath: string): boolean;
  /** Optional (RepoReader has it); enables the milestone-code roster scan. */
  listDir?(relPath: string): string[] | null;
  /** Optional (RepoReader has it); enables the G51 commit-hash pre-check. */
  commitExists?(hashRef: string): boolean;
}

/**
 * Write-side repo path (triage files, audit annotations): the host-owned
 * repository, never the agent's checkout (see host-repo.ts). Read
 * dynamically (not a module const) so tests can point at a fixture repo.
 */
function getRepoPath(): string {
  ensureHostRepo();
  return getHostRepoPath();
}

const PROMPT_TEMPLATE = `You are a skeptical fact-checker reviewing the outbound response an AI agent (Coordinator) just sent. Your only job is to detect failure modes. Do not rewrite, soften, or judge tone.

OUTBOUND RESPONSE:
{{REPLY}}

CURRENT USER REQUEST (context only — statements here are not Coordinator claims):
{{REQUEST_CONTEXT}}

PRIMARY GROUND TRUTH (program/CURRICULUM.md):
{{CURRICULUM}}

RECENT CONFIRMED DECISIONS (discussions/DECISIONS.md — authoritative for recency):
{{DECISIONS}}

COURSE PRODUCTION ROSTERS (courses/<code>/sync/activity-roster.md — auto-synced from the Box production tracker ~4x/day):
{{ROSTERS}}

CITED PATHS (precomputed existence check):
{{CITATIONS}}

All ground truth above reflects the repo at review time (the read mirror's HEAD when this check runs, at or shortly after the reply was sent) — not the commit the reply was generated against.

GROUND-TRUTH PRECEDENCE (read carefully):
- CURRICULUM.md is the primary source for facts.
- A Confirmed DECISIONS.md entry is NEWER than CURRICULUM.md. CURRICULUM.md routinely lags a logged decision until the decision is propagated into it.
- When two Confirmed decisions make incompatible claims about the same current property, the newer dated decision controls unless it explicitly says it is historical, additive, or does not supersede the older one. A response that states the current value need not narrate the older history or the transition between decisions.
- If the response matches a Confirmed decision above but contradicts CURRICULUM.md, this is PROPAGATION LAG (CURRICULUM.md is stale) — it is NOT a factual error. Emit "FLAG: propagation-lag — <what curriculum.md still shows>" and do NOT emit FAIL.
- A production roster above is FRESHER than both CURRICULUM.md and any narrative course file. For module items, video titles/types/lengths, and production status (Defined/Scripted/Recorded/Edited/Final, including counts of items in each state), the roster is authoritative. A response that matches a roster above must NOT be flagged or failed for contradicting an older count or status elsewhere.
- Production-status claims about a course with NO roster above remain unverifiable — handle per the FLAG rule below.
- TRACKING STATE IS OUT OF SCOPE (G40 scope revert): claims about action-item ownership, open/closed status, open-item counts, deadlines, or open-question resolution are operational state, not program facts — you have no ground truth for them. Do NOT flag or fail a claim for being tracking state; simply ignore those claims. Absence of a claim from the ground truth above is NOT evidence of error.
- The CURRENT USER REQUEST is context, not an additional ground-truth source. Facts quoted, pasted, or asserted there are not Coordinator claims. Judge whether Coordinator represented or analyzed that supplied material accurately; do not fail it merely because the supplied material is absent from the KB.

CONTRADICTION TEST (required before FAIL):
- FAIL only when the response and ground truth make incompatible claims about the same subject, property, and timeframe or status.
- Evaluate only claims the response actually makes. Omission is not contradiction: do not penalize the response for omitting an older history, an alternative option, or other context unless it explicitly claims its account is exhaustive or exclusive.
- A soft launch or early-access date and an official start date are different event types and may both be true.
- An internal component allocation (for example, two sequential parts inside one course) does not imply separate registered entities.
- Quoting or mentioning a stale value while the response explicitly rejects it, labels it stale, or opens remediation is not endorsement of that value.
- Wording such as "the roster still says X," "still marked X," or "identify a fallback for items marked X" reports the stale source; it does not endorse X as the current policy. This may justify a propagation-lag FLAG, but never a FAIL for claiming X is current.
- A citation FAIL is permitted only when an exact precomputed CITED PATHS line says MISSING. Do not invent a missing-citation verdict for filenames, section labels, URLs, or documents not listed as MISSING in that block.
- Absence from the supplied evidence is never a factual contradiction. Use FLAG for a material unverifiable claim; reserve FAIL for direct contradiction or a deterministically missing citation.

Check these failure modes:

1. FACTUAL — Does the response contradict CURRICULUM.md on a verifiable fact (credit count, course code, semester assignment, instructor, program length) AND is it NOT supported by any Confirmed decision above? (A response backed by a Confirmed decision is propagation-lag, never factual.) For production-status facts, check against the roster, not CURRICULUM.md.
2. CITATION — Does an exact precomputed CITED PATHS line say MISSING?
3. STALE — Does the response conflict with a Confirmed decision above, or with a production roster above?

Severity rules:
- FAIL: factual contradiction not backed by any Confirmed decision, OR an exact precomputed CITED PATHS line says MISSING
- FLAG: propagation-lag (matches a Confirmed decision but contradicts stale curriculum), stale-decision risk, ambiguous wording that could mislead, or a claim that cannot be verified from the provided ground truth (but is not contradicted)
- PASS: no issues found

Output exactly one of:
PASS
FLAG: [one-line description]
FAIL: [one-line description] | type: factual|citation

Do not output anything else. Do not propose corrections. Do not echo the response back.`;

/** Match repo-relative markdown paths inside the reply (e.g. `program/CURRICULUM.md`). */
const PATH_REGEX = /(?:^|[\s`"(])([\w_-]+\/[\w./_-]+\.md)(?=[\s`"):,.]|$)/gm;

interface AnthropicResponse {
  stop_reason?: string;
  content: Array<{ type: string; text?: string }>;
}

/**
 * Per-model request shape for the short verdict call. Thinking rules differ
 * by family, and a wrong one either 400s or lets thinking eat the output cap
 * before any verdict text:
 *   - Haiku 4.5 / Sonnet 4.x / Opus 4.7-4.8: thinking is off unless asked for.
 *   - Sonnet 5, Opus 5: thinking is on by default; {type:'disabled'} is
 *     accepted (Opus 5 only at effort high or below, and high is its default).
 *   - Opus 5.5, Fable 5.x, Mythos 5.x, and any model not listed here:
 *     thinking cannot be disabled ({type:'disabled'} is a 400), so send
 *     low effort and leave room for thinking plus the verdict.
 *   - Haiku 5.5 (the default) takes the same shape. It thinks by default at
 *     medium effort; {type:'disabled'} is accepted at high or below, but the
 *     API guidance is to lower effort instead. Thinking counts toward
 *     max_tokens, so 320 could end before the verdict. Never send
 *     temperature/top_p/top_k: non-default sampling values are a 400.
 */
export function sensorRequestShape(model: string): {
  max_tokens: number;
  thinking?: { type: 'disabled' };
  output_config?: { effort: 'low' };
} {
  if (/^claude-(haiku-4|sonnet-4|opus-4-[5-8])/.test(model))
    return { max_tokens: 320 };
  if (/^claude-(sonnet-5|opus-5)$/.test(model))
    return { max_tokens: 320, thinking: { type: 'disabled' } };
  return { max_tokens: 2048, output_config: { effort: 'low' } };
}

/** A stop reason that means no usable verdict was produced. */
class SensorStopError extends Error {
  constructor(readonly stopReason: string) {
    super(`sensor model stopped: ${stopReason}`);
  }
}

export function shouldSkipSensor(replyText: string): boolean {
  if (!replyText) return true;
  const stripped = stripInternalTags(replyText).trim();
  if (!stripped) return true;
  if (/lore:\s*intentional/i.test(replyText)) return true;
  return false;
}

/**
 * Whether the sensor also checks email replies (SENSOR_EMAIL_REPLIES), off
 * by default. Chat replies are always checked while the sensor is on. Turning
 * this on sends the text of each delivered email reply, the start of the
 * message it answers and ground-truth excerpts to the sensor's provider, so
 * it is a choice and not a default. BEHAVIOUR_SENSOR_DISABLED=1 still turns
 * every check off. Process environment first, then `.env`. Read on each call.
 */
export function sensorEmailRepliesEnabled(): boolean {
  const value = (
    process.env.SENSOR_EMAIL_REPLIES ||
    readEnvFile(['SENSOR_EMAIL_REPLIES']).SENSOR_EMAIL_REPLIES ||
    ''
  )
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

export function makeSensorId(time: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${time}-${suffix}`;
}

export function placeholderFor(sensorId: string): string {
  return `[sensor: pending:${sensorId}]`;
}

/**
 * Replace the LAST occurrence of `placeholder` in `file` with `replacement`.
 * No-op if the file or placeholder is absent. Sensor placeholders carry a
 * unique id so concurrent sensors don't stomp on each other.
 */
function replacePlaceholder(
  file: string,
  placeholder: string,
  replacement: string,
): void {
  // The audit file lives in the container-writable checkout: read and write
  // it as the checkout owner, never root (a planted link to a root-only file
  // would otherwise be read, rewritten, and pushed to GitHub).
  const root = getRepoPath();
  const content = readFromCheckout(root, file);
  if (content === null) return;
  const idx = content.lastIndexOf(placeholder);
  if (idx === -1) return;
  const updated =
    content.slice(0, idx) +
    replacement +
    content.slice(idx + placeholder.length);
  writeToCheckout(root, file, updated);
}

function loadCurriculum(reader: GroundTruthReader): string | null {
  // File is lowercase in the program-repo repo despite the spec referring
  // to it as `CURRICULUM.md`. Try both for resilience.
  for (const relPath of ['program/curriculum.md', 'program/CURRICULUM.md']) {
    const content = reader.readFile(relPath);
    if (content !== null) return content;
  }
  return null;
}

/** A single decision entry parsed from DECISIONS.md. */
export interface ConfirmedDecision {
  heading: string;
  date: string | null;
  decision: string;
  status: string;
  lifecycle: string[];
}

/** True for a line that opens a new `- **Field:**` (the boundary of a value). */
function isFieldMarker(line: string): boolean {
  return /^\s*-?\s*\*\*[A-Za-z][\w /]*:\*\*/.test(line);
}

/**
 * Extract the full `**Decision:**` value, including continuation lines such as
 * indented bullet lists, up to the next field marker, provenance blockquote,
 * or entry separator. Returns a single flattened string. Many real entries put
 * the substantive facts (course/week/instructor) in continuation bullets under
 * a lead-in line, so first-line-only capture would drop the ground truth.
 */
function extractDecision(block: string): string {
  const lines = block.split('\n');
  const collected: string[] = [];
  let collecting = false;
  for (const line of lines) {
    const start = line.match(/^\s*-?\s*\*\*Decision:\*\*\s*(.*)$/);
    if (start) {
      collecting = true;
      if (start[1].trim()) collected.push(start[1].trim());
      continue;
    }
    if (!collecting) continue;
    // A new field, a provenance trailer (>), or a separator ends the value.
    if (isFieldMarker(line) || /^\s*>/.test(line) || /^\s*---\s*$/.test(line)) {
      break;
    }
    if (line.trim()) collected.push(line.trim());
  }
  return collected.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Parse DECISIONS.md into entries, returning only those whose Status begins
 * with "Confirmed" (so "Confirmed (pending X)" counts; "Proposed" /
 * "Superseded" do not). Pure — operates on the markdown string only.
 */
export function parseConfirmedDecisions(md: string): ConfirmedDecision[] {
  // The chunk before the first "### " heading is the file preamble — drop it.
  const blocks = md.split(/^### /m).slice(1);
  const out: ConfirmedDecision[] = [];
  for (const block of blocks) {
    const heading = block.split('\n', 1)[0].trim();
    const statusMatch = block.match(/\*\*Status:\*\*\s*(.+)/);
    const status = statusMatch ? statusMatch[1].trim() : '';
    if (!/^confirmed\b/i.test(status)) continue;
    const dateMatch = block.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/);
    const lifecycle = Array.from(
      block.matchAll(
        /^\s*(?:-\s*)?\*\*(Superseded|Supersedes|Additive to):?\*\*\s*(?:—\s*)?(.+)$/gim,
      ),
    ).map((match) => `${match[1]}: ${match[2].trim()}`);
    out.push({
      heading,
      date: dateMatch ? dateMatch[1] : null,
      decision: extractDecision(block),
      status,
      lifecycle,
    });
  }
  return out;
}

/** Most-recent-first by date (undated entries sort last), capped at `limit`. */
export function selectRecentConfirmed(
  entries: ConfirmedDecision[],
  limit = 25,
): ConfirmedDecision[] {
  return [...entries]
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, limit);
}

/** Limit replay evidence to decisions available when a historical reply ran. */
export function filterConfirmedAsOf(
  entries: ConfirmedDecision[],
  asOfDate?: string,
): ConfirmedDecision[] {
  if (!asOfDate) return entries;
  return entries.filter((entry) => !entry.date || entry.date <= asOfDate);
}

// Common words that carry no topical signal. Kept short on purpose — course
// codes (elc, lab, 550, 513) are 3 chars and ARE high-signal, so the length
// floor is 3 and these are filtered explicitly instead.
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'was',
  'not',
  'but',
  'has',
  'you',
  'our',
  'its',
  'can',
  'all',
  'any',
  'who',
  'how',
  'why',
  'from',
  'this',
  'that',
  'with',
  'will',
  'have',
  'into',
  'your',
  'their',
  'there',
  'which',
  'what',
  'when',
  'where',
  'about',
  'course',
  'courses',
  'program',
  'student',
  'students',
  'program',
  'decision',
  'confirmed',
  'uses',
  'use',
]);

/** Lowercased content tokens (≥3 chars, stopwords removed) for overlap scoring. */
export function tokenize(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
      (w) => w.length >= 3 && !STOPWORDS.has(w),
    ),
  );
}

/**
 * Select the Confirmed decisions most worth showing the sensor for THIS reply.
 * Relevance-first (token overlap between the reply and each decision's
 * heading+text), recency as the tiebreaker. This ensures a topically-relevant
 * decision is included even when it is not among the newest — fixing the case
 * where a still-stale curriculum.md could re-trigger a false FAIL once the
 * relevant decision aged out of a pure recency window.
 */
export function selectRelevantConfirmed(
  entries: ConfirmedDecision[],
  replyText: string,
  limit = 25,
): ConfirmedDecision[] {
  const replyTokens = tokenize(replyText);
  return entries
    .map((e) => {
      const eTokens = tokenize(
        `${e.heading} ${e.decision} ${e.lifecycle.join(' ')}`,
      );
      let overlap = 0;
      for (const t of eTokens) if (replyTokens.has(t)) overlap++;
      return { e, overlap };
    })
    .sort(
      (a, b) =>
        b.overlap - a.overlap || (b.e.date || '').localeCompare(a.e.date || ''),
    )
    .slice(0, limit)
    .map((s) => s.e);
}

/** Render confirmed decisions as a bullet block for the sensor prompt. */
export function formatConfirmedDecisionsBlock(
  entries: ConfirmedDecision[],
): string {
  if (entries.length === 0) return '(none)';
  return entries
    .map((e) => {
      const lifecycle = e.lifecycle.length
        ? ` [LIFECYCLE — ${e.lifecycle.join('; ')}]`
        : '';
      return `- [${e.date || 'n.d.'}] ${e.heading}${lifecycle}: ${e.decision}`;
    })
    .join('\n');
}

function loadConfirmedDecisions(
  reader: GroundTruthReader,
  replyText: string,
  asOfDate?: string,
): string {
  const md = reader.readFile('discussions/DECISIONS.md');
  if (md === null) return '(none)';
  const all = filterConfirmedAsOf(parseConfirmedDecisions(md), asOfDate);
  const selected = selectRelevantConfirmed(all, replyText);
  if (all.length > selected.length) {
    // Not a silent cap: record how many Confirmed decisions didn't make the
    // prompt so a missed-decision false-flag is debuggable.
    logger.debug(
      { total: all.length, included: selected.length },
      'Behaviour sensor: Confirmed decisions truncated for prompt',
    );
  }
  return formatConfirmedDecisionsBlock(selected);
}

/**
 * Course codes mentioned in the text, normalized to the repo's folder naming
 * (e.g. "CRS 554", "crs-554", "ELC550" → "crs554" / "elc550").
 */
export function extractCourseCodes(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b([a-z]{2,4})[\s-]?(\d{3})\b/gi)) {
    out.add(`${m[1].toLowerCase()}${m[2]}`);
  }
  return [...out];
}

/**
 * Load Box-synced activity rosters for courses the reply mentions. Topic-gated
 * on purpose: rosters are sizeable and most replies touch at most one course,
 * so only mentioned courses are probed. The existence probe doubles as
 * discovery — there is no hardcoded list of synced courses to drift out of
 * date when a new course's sync/ folder appears.
 */
export function loadSyncRosters(
  reader: GroundTruthReader,
  replyText: string,
): string {
  const blocks: string[] = [];
  const loaded = new Set<string>();
  for (const code of extractCourseCodes(replyText)) {
    const relPath = `courses/${code}/sync/activity-roster.md`;
    const content = reader.readFile(relPath);
    if (content !== null) {
      blocks.push(`--- ${relPath} ---\n${content}`);
      loaded.add(relPath);
    }
  }

  // Milestone-code fallback: a reply like "M2I6 and M4I6 now show Final
  // project milestone" names roster rows but not the course, so the loop
  // above loads nothing and the sensor can't verify a true claim.
  // Scan synced rosters for the codes themselves.
  const milestoneCodes = Array.from(
    new Set(Array.from(replyText.matchAll(/\bM\d+I\d+\b/g)).map((m) => m[0])),
  );
  if (milestoneCodes.length > 0 && reader.listDir) {
    for (const course of reader.listDir('courses') ?? []) {
      const relPath = `courses/${course}/sync/activity-roster.md`;
      if (loaded.has(relPath)) continue;
      const content = reader.readFile(relPath);
      if (content !== null && milestoneCodes.some((c) => content.includes(c))) {
        blocks.push(`--- ${relPath} ---\n${content}`);
        loaded.add(relPath);
      }
    }
  }

  return blocks.length > 0
    ? blocks.join('\n\n')
    : '(none — no synced roster matches this reply)';
}

// --- ACTION_ITEMS parsing (used by the Monday outreach counts, NOT the ------
// --- sensor since the G40 scope revert) -------------------------------------

/** A per-owner section parsed from ACTION_ITEMS.md (`## <Owner>` blocks). */
export interface ActionItemSection {
  owner: string;
  /** Full section text including its `## Owner` heading. */
  text: string;
  /** Unchecked `- [ ]` items in this section. */
  openCount: number;
}

/**
 * Still the single owner of ACTION_ITEMS.md section parsing: the task
 * scheduler derives the per-owner `action_item_counts.json` IPC artifact
 * from it (src/task-scheduler.ts). The sensor itself no longer calls this.
 */
export function parseActionItemSections(md: string): ActionItemSection[] {
  // The chunk before the first "## " heading is the file preamble — drop it.
  return md
    .split(/^## /m)
    .slice(1)
    .map((block) => ({
      owner: block.split('\n', 1)[0].trim(),
      text: `## ${block.trimEnd()}`,
      openCount: (block.match(/^\s*- \[ \]/gm) || []).length,
    }));
}

// --- G40 (scope revert): out-of-scope claim classifier ----------------------
//
// The original G40 added ACTION_ITEMS.md to the ground-truth bundle so the
// model could verify tracking-state claims. That conflated two claim types:
// program facts ("CRS 554 is 4 credits") are stable and fully covered by
// CURRICULUM + Confirmed DECISIONS; tracking state ("Ines owns the AACSB
// item") is operational and fluid, and evaluating it produced a false-positive
// rate that made the flags unusable.
// The revert: ACTION_ITEMS leaves the bundle entirely, and replies whose
// content is only tracking-state / infrastructure / conversational-ack are
// classified out of scope BEFORE the model runs — the deterministic
// pre-checks (G51 commit hashes, premise-dead, person-names, URL/G-rule/
// course-code refs) still run on every reply, since fabrications appear in
// exactly these status-y replies and those checks don't generate the noise
// class this revert targets.

/**
 * Broad ownership/tracking language (kept broad: a
 * narrow pattern misses legitimate ownership claims). Now used only to
 * classify a reply as tracking-state, never to pull ground truth.
 */
const TRACKING_STATE_RE =
  /action[ -]?items?|open items?|outstanding (items?|tasks?)|assigned (at|to|you|this)|tracked under|checked off|to-?do list|items? (open|closed|completed|tracked)|meeting (assigned|outcomes?)|nothing (is )?(currently )?tracked|\bowns?\b|\bowners?(ship)?\b|responsible for|following up on|follow-?up (on|item)|open questions?|OPEN_QUESTIONS|PENDING\.md|\bresolved\b|\bunresolved\b/i;

/** Bot/infrastructure terminology (the program never discusses these as facts). */
const INFRASTRUCTURE_RE =
  /\bnanoclaw\b|\bpeeragent\b|\bG\d{1,3}\b|\bcommits?\b|agent[- ]inbox|kb-conflict-check|kb-entry-gate|kb-triage|audit[- ]log|behaviour[- ]sensor|working[- ]context/i;

/**
 * Program-fact signal: if any of this appears, the reply stays in scope no
 * matter what else it contains — a reply can mix an ownership claim with a
 * wrong credit count, and the credit count must still be evaluated.
 */
const PROGRAM_FACT_RE =
  /\b(crs|lab|elc)\s?\d{3}\b|\bcredits?\b|\bsemesters?\b|\bcohorts?\b|\bcurriculum\b|\bsyllab(us|i)\b|\bassessment\b|\bcourses?\b|\bclass(es)?\b|\bprogram\b|\bfaculty\b|\binstructors?\b|\bteach(es|ing)?\b|\bcapstone\b|\bpracticum\b|\bdegree\b|\bstudents?\b|\bgpa\b|\bgrad(e|es|ing)\b|\brubrics?\b|\bmodules?\b|\blaunch(es|ed|ing)?\b|\b(deadline|due date)\b|\b(video|recording|screencast)s?\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,4}\b|\b\d+\s?(months?|weeks?)\b|\b(tuition|enrol|admission|prerequisite)/i;

export type OutOfScopeType =
  | 'tracking-state'
  | 'infrastructure'
  | 'conversational-ack';

/**
 * Classify a reply as out of the sensor's scope (G40). Returns null when the
 * reply makes (or may make) program-fact claims and must be evaluated.
 * Conservative by construction: any program-fact signal keeps it in scope.
 */
export function classifyOutOfScope(replyText: string): OutOfScopeType | null {
  const stripped = stripInternalTags(replyText).trim();
  // Infrastructure explanations routinely use generic words such as
  // "program", "students", and "faculty". Those words alone do not turn an
  // architecture/scaling answer into a curriculum claim. Keep mixed replies
  // in scope only when they contain a concrete, checkable program fact.
  const directProgramFact =
    /\b(crs|lab|elc)\s?\d{3}\b|\b\d+(?:\.\d+)?\s*credits?\b|\b\d+(?:\.\d+)?\s*gpa\b|\b(?:gpa|tuition)\b|\b(?:soft launch|official start|starts?|launches?|deadline|due date)\b[^.\n]{0,50}\b(?:\d{4}-\d{2}-\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)\b|\bno traditional exams?\b/i.test(
      stripped,
    );
  const academicDuration =
    /\b(?:program|degree|program|course|semester)\b[^.\n]{0,40}\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?[- ]?(?:months?|weeks?)\b|\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?[- ]?(?:months?|weeks?)\b[^.\n]{0,40}\b(?:program|degree|program|course|semester)\b/i.test(
      stripped,
    );
  const specificProgramFact = directProgramFact || academicDuration;
  if (INFRASTRUCTURE_RE.test(stripped) && !specificProgramFact) {
    return 'infrastructure';
  }
  // Any program-fact signal keeps the reply in scope, full stop.
  if (PROGRAM_FACT_RE.test(stripped)) return null;
  // Specific labels before the generic short-ack fallback.
  if (TRACKING_STATE_RE.test(stripped)) return 'tracking-state';
  if (INFRASTRUCTURE_RE.test(stripped)) return 'infrastructure';
  // Ack detection is positive, not residual ("The Program includes
  // eleven required classes" is short and matches no fact keyword, but is
  // not an ack). Real acks in the corpus all LEAD with an ack token:
  // "Yes, go ahead" / "Ready — ..." / "Filed. ..." / "Done (`<hash>`)...".
  const ACK_LEAD_RE =
    /^(yes|no|ok(ay)?|sure|thanks?|thank you|done|filed|ready|noted|got it|will do|sounds good|confirmed|ack(nowledged)?|perfect|understood|great)\b/i;
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length <= 50 && ACK_LEAD_RE.test(stripped)) {
    return 'conversational-ack';
  }
  return null;
}

/**
 * Assemble the sensor prompt. Uses function replacements so `$`-sequences in
 * the ground-truth content aren't interpreted as replacement patterns.
 */
export function buildSensorPrompt(
  reply: string,
  curriculum: string,
  decisionsBlock: string,
  rostersBlock: string,
  citationsBlock: string,
  requestContext = '(not available)',
): string {
  return PROMPT_TEMPLATE.replace('{{REPLY}}', () => reply)
    .replace('{{REQUEST_CONTEXT}}', () => requestContext)
    .replace('{{CURRICULUM}}', () => curriculum)
    .replace('{{DECISIONS}}', () => decisionsBlock)
    .replace('{{ROSTERS}}', () => rostersBlock)
    .replace('{{CITATIONS}}', () => citationsBlock);
}

/**
 * A cited path counts as existing if it resolves as written OR under
 * `discussions/`. Coordinator routinely cites files relative to `discussions/`
 * (e.g. `kb-triage/YYYY-MM-DD-conflicts.md`), and the prompt hard-FAILs any
 * MISSING citation, so an exact-path check alone produces false FAILs.
 */
function citationExists(p: string, reader: GroundTruthReader): boolean {
  if (reader.exists(p)) return true;
  return !p.startsWith('discussions/') && reader.exists(`discussions/${p}`);
}

export function checkCitations(
  replyText: string,
  reader: GroundTruthReader,
): {
  paths: string[];
  block: string;
} {
  const matches = Array.from(replyText.matchAll(PATH_REGEX));
  const paths = Array.from(new Set(matches.map((m) => m[1])));
  if (paths.length === 0) return { paths: [], block: '(none)' };
  const block = paths
    .map((p) => `${p}: ${citationExists(p, reader) ? 'exists' : 'MISSING'}`)
    .join('\n');
  return { paths, block };
}

// --- G51 phase 1: commit-hash existence pre-check ---------------------------

/**
 * Marker for the deterministic commit-hash pre-check's FLAG annotations.
 * A distinct, greppable type so digests can group these separately from
 * model-emitted flags (G51). A fabricated commit hash in a reply would
 * otherwise go unchecked.
 */
export const COMMIT_HASH_FLAG_TYPE = 'commit-hash-unverified';

/** A line that presents hex strings as commit/revision references. */
const COMMIT_CONTEXT_RE = /\b(commits?|sha|hash(?:es)?|rev(?:ision)?s?)\b/i;

/**
 * Hex strings (7-40 chars) presented as commit references in the reply.
 * Deterministic and deliberately conservative:
 *   - a 40-char hex token is always a candidate (full SHA is unambiguous);
 *   - shorter tokens count only on lines with commit-context wording
 *     ("commit", "sha", "hash", "rev") AND when they contain at least one
 *     digit (filters English words that happen to be pure a-f hex, e.g.
 *     "efface", "decade").
 */
export function extractCommitHashRefs(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const inCommitContext = COMMIT_CONTEXT_RE.test(line);
    for (const m of line.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
      const token = m[0].toLowerCase();
      if (token.length === 40 || (inCommitContext && /\d/.test(token))) {
        out.add(token);
      }
    }
  }
  return [...out];
}

/**
 * Deterministic pre-check: look up every presented commit hash in the repo
 * mirror. Skipped entirely (empty result) when the reader can't resolve
 * commits (test stubs without commitExists) — no false flags on missing
 * capability. Follows the citation-existence pre-check pattern.
 */
export function checkCommitHashes(
  replyText: string,
  reader: GroundTruthReader,
): { hashes: string[]; unverified: string[] } {
  const hashes = extractCommitHashRefs(replyText);
  if (hashes.length === 0 || typeof reader.commitExists !== 'function') {
    return { hashes, unverified: [] };
  }
  const unverified = hashes.filter((h) => !reader.commitExists!(h));
  return { hashes, unverified };
}

/**
 * Merge the deterministic commit-hash verdict into the model's. An
 * unverifiable hash FLAGs (never FAILs — an abbreviation can be ambiguous or
 * the mirror momentarily behind): a PASS/FLAG verdict gains a
 * `commit-hash-unverified` flag annotation; a FAIL keeps its (more severe)
 * annotation unchanged.
 */
export function applyCommitHashVerdict(
  parsed: { annotation: string; isFail: boolean; desc: string },
  unverified: string[],
): { annotation: string; isFail: boolean; desc: string } {
  const tag =
    unverified.length > 0
      ? `${COMMIT_HASH_FLAG_TYPE} — ${unverified.join(', ')} not found in repo mirror`
      : null;
  return mergeFlagIntoVerdict(parsed, tag);
}

// --- G37 v2 read-path backstop: premise-dead onboarding claims --------------

/**
 * Marker for the deterministic premise-dead pre-check's FLAG annotations.
 * Failure prevented: an onboarding item surfaced as an open gap when the
 * people are already on EMAIL_ALLOWLIST.md. Write gates can't catch surfacing — this post-hoc
 * check can, deterministically (no metered LLM call: the sensor bills the
 * Messages API directly, so this stays a table lookup).
 */
export const PREMISE_DEAD_FLAG_TYPE = 'premise-dead-item-surfaced';

/** A line that talks about getting someone onto Coordinator / the bot / the allowlist. */
const ONBOARDING_CLAIM_RE =
  /\b(onboard(?:ing|ed)?|add(?:ing|ed)?\s+(?:\S+\s+){0,4}to\s+(?:co-?ordinator|the\s+(?:kb\s+)?bot|the\s+allowlist)|set(?:ting)?\s+up\s+on\s+(?:co-?ordinator|the\s+(?:kb\s+)?bot)|needs?\s+(?:co-?ordinator\s+)?access|not\s+(?:yet\s+)?on\s+co-?ordinator)\b/i;

/** …framed as OPEN work (a gap), not as history. Conservative on purpose:
 *  "June was onboarded on 2030-01-07" must not flag. */
const GAP_FRAMING_RE =
  /\b(need(?:s|ed)?\s+to|should|still\s+(?:need|pending|open)|not\s+yet|to-?do|open\s+(?:item|action|task)|action\s+item|remains?\s+open|outstanding|next\s+step|gap)\b/i;

/** Names from the enforced allowlist table: `| Name | email@… |` rows only —
 *  the Retired-access blockquote is prose, not a row, so a departed person
 *  never counts as "already has access". */
export function parseAllowlistNames(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is empty (leading pipe); name in [1], email in [2].
    if (
      cells.length >= 3 &&
      cells[2].includes('@') &&
      /[A-Za-z]/.test(cells[1])
    ) {
      // Strip parentheticals like "(PeerAgent Agent)".
      names.push(cells[1].replace(/\s*\(.*\)$/, '').trim());
    }
  }
  return names;
}

/**
 * Deterministic pre-check: does the reply present an onboarding/access GAP
 * for someone who already appears in the enforced allowlist table? Returns
 * the matched names. Skips silently when the allowlist can't be read (no
 * false flags on missing capability — same posture as checkCommitHashes).
 */
export function checkPremiseDeadClaims(
  replyText: string,
  reader: GroundTruthReader,
): { flagged: string[] } {
  const allowlist = reader.readFile('program/EMAIL_ALLOWLIST.md');
  if (!allowlist) return { flagged: [] };
  const names = parseAllowlistNames(allowlist);
  if (names.length === 0) return { flagged: [] };

  const flagged = new Set<string>();
  for (const line of replyText.split(/\r?\n/)) {
    if (!ONBOARDING_CLAIM_RE.test(line) || !GAP_FRAMING_RE.test(line)) continue;
    const lower = line.toLowerCase();
    for (const name of names) {
      const full = name.toLowerCase();
      // Full-name match, or "First Last" reduced to distinctive last name
      // only when the full name has a middle token (e.g. "Samuel Caleb
      // Rivera" → also try "Sam…"? No — stay conservative: full name only,
      // plus first+last with middle tokens dropped).
      const parts = full.split(/\s+/);
      const firstLast =
        parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : full;
      if (lower.includes(full) || lower.includes(firstLast)) {
        flagged.add(name);
      }
    }
  }
  return { flagged: [...flagged] };
}

/**
 * Merge the premise-dead verdict into the model's — same semantics as the
 * commit-hash merge: FLAG, never FAIL; FAILs and error annotations keep
 * their (more severe) annotation unchanged.
 */
export function applyPremiseDeadVerdict(
  parsed: { annotation: string; isFail: boolean; desc: string },
  flagged: string[],
): { annotation: string; isFail: boolean; desc: string } {
  const tag =
    flagged.length > 0
      ? `${PREMISE_DEAD_FLAG_TYPE} — reply surfaces an onboarding/access gap for ${flagged.join(', ')}, already on EMAIL_ALLOWLIST.md`
      : null;
  return mergeFlagIntoVerdict(parsed, tag);
}

// --- People-facts ground truth: person-name mismatch pre-check --------------

/**
 * Marker for the deterministic person-name-mismatch pre-check's FLAG
 * annotations. Failure prevented: a reply expands an instructor's first
 * name to a surname the allowlist (the canonical people record, G39) does
 * not back. When KB ground-truth files carry only first names, no sensor
 * input can refute an invented surname. This check is deterministic (no
 * metered LLM call) and uses EMAIL_ALLOWLIST.md as the people ground truth:
 * one fact, one place, no separate people doc.
 */
export const PERSON_NAME_FLAG_TYPE = 'person-name-mismatch';

/**
 * Overlapping candidate "Proper Name" pairs in the reply. Zero-width
 * lookahead (the extractEntities technique in
 * container/skills/kb-entry-gate/check-kb-entry.mjs): a consuming match on
 * "Professor First Last" would eat "Professor First" and never see
 * "First Last", hiding the very pair we need to check.
 */
const NAME_PAIR_RE = /(?=\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b)/g;

/**
 * Deterministic pre-check: does the reply expand an allowlisted person's
 * first name to a surname the allowlist doesn't back? For each candidate
 * "First Last" pair whose first token is a UNIQUE allowlist first name
 * (uniqueness guards common first names shared by several people), the
 * second token must be one of that person's name parts. Middle-name drops
 * are fine ("Robin Keller" for "Robin Jo Keller" — "Keller" is a
 * name part); a foreign surname flags.
 * Identical full names (e.g. two rows for the same person,
 * agent marker stripped) count as one person. Skips silently when the
 * allowlist can't be read — same posture as checkPremiseDeadClaims.
 */
export function checkPersonNameMismatch(
  replyText: string,
  reader: GroundTruthReader,
): { flagged: Array<{ written: string; expected: string }> } {
  const allowlist = reader.readFile('program/EMAIL_ALLOWLIST.md');
  if (!allowlist) return { flagged: [] };
  // Identical full names are one person.
  const names = [...new Set(parseAllowlistNames(allowlist))];
  if (names.length === 0) return { flagged: [] };

  const byFirst = new Map<string, string[]>();
  for (const name of names) {
    const first = name.split(/\s+/)[0].toLowerCase();
    byFirst.set(first, [...(byFirst.get(first) ?? []), name]);
  }

  const flagged: Array<{ written: string; expected: string }> = [];
  const seen = new Set<string>();
  for (const m of replyText.matchAll(NAME_PAIR_RE)) {
    const [, token1, token2] = m;
    const persons = byFirst.get(token1.toLowerCase());
    // Only UNIQUE allowlist first names are checkable; a first name shared
    // by 2+ people (or absent — sentence-leading capitals like "Get Caleb")
    // never flags.
    if (!persons || persons.length !== 1) continue;
    const expected = persons[0];
    const parts = new Set(expected.split(/\s+/).map((p) => p.toLowerCase()));
    if (parts.has(token2.toLowerCase())) continue;
    const written = `${token1} ${token2}`;
    if (seen.has(written)) continue;
    seen.add(written);
    flagged.push({ written, expected });
  }
  return { flagged };
}

/**
 * Merge the person-name verdict into the model's — same semantics as
 * applyPremiseDeadVerdict: FLAG, never FAIL; FAILs and error annotations
 * keep their (more severe) annotation unchanged.
 */
export function applyPersonNameVerdict(
  parsed: { annotation: string; isFail: boolean; desc: string },
  flagged: Array<{ written: string; expected: string }>,
): { annotation: string; isFail: boolean; desc: string } {
  const tag =
    flagged.length > 0
      ? flagged
          .map(
            (f) =>
              `${PERSON_NAME_FLAG_TYPE} — reply says "${f.written}", EMAIL_ALLOWLIST.md says ${f.expected}`,
          )
          .join('; ')
      : null;
  return mergeFlagIntoVerdict(parsed, tag);
}

// --- Reference-existence pre-checks (site URLs, G-rule IDs, course codes) ---
// Same class as the commit-hash / premise-dead / person-name pre-checks:
// the reply PRESENTS a reference; it either resolves against the canonical
// record or it FLAGs (never FAILs). All deterministic — no metered call.

export const SITE_URL_FLAG_TYPE = 'site-url-unverified';
export const G_RULE_FLAG_TYPE = 'g-rule-unverified';
export const COURSE_CODE_FLAG_TYPE = 'course-code-unverified';

/**
 * Shared merge for deterministic FLAG pre-checks — the boilerplate common to
 * applyCommitHashVerdict / applyPremiseDeadVerdict / applyPersonNameVerdict:
 * a FAIL or error annotation is never touched; otherwise the tag joins (or
 * becomes) a flag annotation.
 */
export function mergeFlagIntoVerdict(
  parsed: { annotation: string; isFail: boolean; desc: string },
  tag: string | null,
): { annotation: string; isFail: boolean; desc: string } {
  if (!tag || parsed.isFail) return parsed;
  if (parsed.annotation.startsWith('[sensor: error')) return parsed;
  const desc = parsed.desc ? `${tag}; ${parsed.desc}` : tag;
  return { annotation: `[sensor: flag: ${desc}]`, isFail: false, desc };
}

const _SITE_ORIGIN = 'program-repo.example.org';

/** Dirs excluded from the Jekyll build (program-repo _config.yml) — a file
 *  there EXISTS in the repo but its URL 404s on the site. */
const SITE_EXCLUDED_DIRS = new Set([
  'reference',
  'discussions',
  'presentations',
  'program-in-a-box',
  'email-inbox',
]);

/**
 * Verify every program-site URL in the reply maps to a served file.
 * Jekyll default routing (verified: /governance ← root governance.md):
 * <path> resolves via <path>.md, <path>.html, <path>/index.md, or the
 * literal path. External domains are not ours to verify and are skipped.
 */
export function checkSiteUrls(
  replyText: string,
  reader: GroundTruthReader,
): { unresolved: string[]; excluded: string[] } {
  const unresolved: string[] = [];
  const excluded: string[] = [];
  const seen = new Set<string>();
  for (const m of replyText.matchAll(
    /https?:\/\/program-repo\.example\.org(\/[^\s)\]>"'`]*)?/g,
  )) {
    // Strip anchors/queries, then trailing sentence punctuation ("see
    // …/docs/faq." is a sentence end, not part of the path), then slashes.
    let p = (m[1] ?? '/')
      .replace(/[#?].*$/, '')
      .replace(/[.,;:!]+$/, '')
      .replace(/\/+$/, '');
    if (!p || p === '') p = '/'; // bare origin or root — always serves index
    if (p === '/') continue;
    const rel = p.replace(/^\//, '');
    if (seen.has(rel)) continue;
    seen.add(rel);
    const topDir = rel.split('/')[0];
    const candidates = [rel, `${rel}.md`, `${rel}.html`, `${rel}/index.md`];
    const found = candidates.some((c) => reader.exists(c));
    if (found && SITE_EXCLUDED_DIRS.has(topDir)) {
      excluded.push(p);
    } else if (!found) {
      unresolved.push(p);
    }
  }
  return { unresolved, excluded };
}

export function siteUrlTag(res: {
  unresolved: string[];
  excluded: string[];
}): string | null {
  const parts: string[] = [];
  if (res.unresolved.length) {
    parts.push(
      `${SITE_URL_FLAG_TYPE} — ${res.unresolved.join(', ')} does not map to any repo file (likely dead link)`,
    );
  }
  if (res.excluded.length) {
    parts.push(
      `${SITE_URL_FLAG_TYPE} — ${res.excluded.join(', ')} points into a dir excluded from the site build (file exists, page 404s)`,
    );
  }
  return parts.length ? parts.join('; ') : null;
}

/**
 * Verify cited governance-rule IDs ("per G39") exist as `| G<N> |` rows in
 * program/kb-governance.md. A phantom G-number is the fabricated-commit-hash
 * failure in governance clothing. Skips silently if the registry is
 * unreadable.
 */
export function checkGRuleRefs(
  replyText: string,
  reader: GroundTruthReader,
): { phantom: string[] } {
  const cited = new Set<string>();
  for (const m of replyText.matchAll(/\bG(\d{1,3})\b/g)) cited.add(m[1]);
  if (cited.size === 0) return { phantom: [] };
  const registry = reader.readFile('program/kb-governance.md');
  if (!registry) return { phantom: [] };
  const known = new Set<string>();
  for (const m of registry.matchAll(/^\|\s*G(\d{1,3})\s*\|/gm)) known.add(m[1]);
  if (known.size === 0) return { phantom: [] };
  return {
    phantom: [...cited].filter((n) => !known.has(n)).map((n) => `G${n}`),
  };
}

export function gRuleTag(res: { phantom: string[] }): string | null {
  return res.phantom.length
    ? `${G_RULE_FLAG_TYPE} — ${res.phantom.join(', ')} not found in program/kb-governance.md`
    : null;
}

/**
 * Verify course codes against the canon (union of codes in
 * program/course_names.md + program/curriculum.md — covers prep MOOCs like
 * CRS 572). extractCourseCodes matches any letters+digits pair, so only
 * codes whose PREFIX the canon itself uses are judged — "CRS 999" flags,
 * prose like "top 100" never does. Skips silently when canon unreadable.
 * program/course_names.md is OPTIONAL (the ProgramOS template does not ship
 * it): when it is missing, the canon is curriculum.md alone.
 */
export function checkCourseCodeRefs(
  replyText: string,
  reader: GroundTruthReader,
): { unknown: string[] } {
  const inReply = extractCourseCodes(replyText);
  if (inReply.length === 0) return { unknown: [] };
  const canonText = [
    reader.readFile('program/course_names.md'),
    reader.readFile('program/curriculum.md'),
  ]
    .filter(Boolean)
    .join('\n');
  if (!canonText) return { unknown: [] };
  const canon = new Set(extractCourseCodes(canonText));
  if (canon.size === 0) return { unknown: [] };
  const canonPrefixes = new Set([...canon].map((c) => c.replace(/\d+$/, '')));
  const unknown = inReply.filter((c) => {
    const prefix = c.replace(/\d+$/, '');
    return canonPrefixes.has(prefix) && !canon.has(c);
  });
  return {
    unknown: unknown.map((c) =>
      c.replace(/^([a-z]+)(\d+)$/, (_, a, d) => `${a.toUpperCase()} ${d}`),
    ),
  };
}

export function courseCodeTag(res: { unknown: string[] }): string | null {
  return res.unknown.length
    ? `${COURSE_CODE_FLAG_TYPE} — ${res.unknown.join(', ')} not in program/course_names.md or curriculum.md`
    : null;
}

/** Where the sensor posts, and the header that carries its key. */
export interface SensorTarget {
  provider: 'anthropic' | 'foundry';
  url: string;
  keyHeader: string;
  apiKey: string;
}

/**
 * The sensor's destination. It does not fail over.
 *
 * Provider: SENSOR_PROVIDER (`anthropic` or `foundry`) when set; otherwise the
 * first provider in MODEL_PROVIDERS; otherwise `anthropic`. So the sensor
 * sends reply text where the agent's primary provider sends it.
 *
 * Anthropic: ANTHROPIC_BASE_URL when set (its host, and its path prefix
 * joined before /v1/messages as the credential proxy does), else
 * api.anthropic.com. The key is ANTHROPIC_API_KEY; a subscription token
 * cannot call the Messages API. Foundry: SENSOR_MODEL is a deployment name;
 * name the deployment by its model ID, because sensorRequestShape keys off
 * the name.
 *
 * Returns an error reason when the settings for the chosen provider are
 * missing; it never picks another destination instead.
 */
export function resolveSensorTarget(): SensorTarget | { error: string } {
  const provider = (
    process.env.SENSOR_PROVIDER ||
    readEnvFile(['SENSOR_PROVIDER']).SENSOR_PROVIDER ||
    readPrimaryProviderName() ||
    'anthropic'
  ).toLowerCase();
  if (provider === 'foundry') {
    try {
      const foundry = readFoundrySettings();
      return logTarget({
        provider,
        url: messagesUrl(foundry.baseUrl),
        keyHeader: foundry.keyHeader,
        apiKey: foundry.apiKey,
      });
    } catch {
      return { error: 'no-foundry-settings' };
    }
  }
  if (provider !== 'anthropic') return { error: 'unknown-sensor-provider' };
  const apiKey =
    process.env.ANTHROPIC_API_KEY ||
    readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'no-api-key' };
  // .env only, as the credential proxy reads it: the sensor must go where
  // the agent goes.
  const rawBase = readEnvFile(['ANTHROPIC_BASE_URL']).ANTHROPIC_BASE_URL;
  let url = 'https://api.anthropic.com/v1/messages';
  if (rawBase) {
    try {
      const base = new URL(rawBase);
      if (base.protocol !== 'https:' && base.protocol !== 'http:')
        return { error: 'invalid-base-url' };
      url = messagesUrl(base);
    } catch {
      return { error: 'invalid-base-url' };
    }
  }
  return logTarget({ provider, url, keyHeader: 'x-api-key', apiKey });
}

let loggedDestination = '';

/** Log where the sensor sends data, once per provider and host. Never the key or the path. */
function logTarget(target: SensorTarget): SensorTarget {
  const host = new URL(target.url).host;
  const id = `${target.provider} ${host}`;
  if (id !== loggedDestination) {
    loggedDestination = id;
    logger.info(
      { provider: target.provider, host },
      'Behaviour sensor sends reply text to this provider',
    );
  }
  return target;
}

async function callSensorModel(
  prompt: string,
  target: SensorTarget,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SENSOR_TIMEOUT_MS);
  try {
    const resp = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [target.keyHeader]: target.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SENSOR_MODEL,
        ...sensorRequestShape(SENSOR_MODEL),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(
        `API ${resp.status} (${target.provider}): ${errText.slice(0, 200)}`,
      );
    }
    const data = (await resp.json()) as AnthropicResponse;
    const text = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
      .trim();
    // A cut-off or refused call is not a verdict; say which, instead of
    // letting empty text surface as "malformed-verdict".
    if (data.stop_reason === 'refusal') throw new SensorStopError('refusal');
    if (data.stop_reason === 'max_tokens' && !/^(PASS|FLAG:|FAIL:)/i.test(text))
      throw new SensorStopError('max_tokens');
    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Cap runaway descriptions without destroying meaning: the old hard
// .slice(0, 200) cut real verdicts mid-sentence and chopped off the trailing
// "| type:" tail that failTypeFromDesc anchors on, so a long FAIL was logged as type
// "unspecified" with a truncated reviewer note. 600 chars covers every verdict observed to date; the ellipsis makes
// any remaining truncation visible instead of silent.
const VERDICT_DESC_CAP = 600;

function capDesc(line: string): string {
  if (line.length <= VERDICT_DESC_CAP) return line;
  return line.slice(0, VERDICT_DESC_CAP) + ' …';
}

export function parseVerdict(verdict: string): {
  annotation: string;
  isFail: boolean;
  desc: string;
} {
  if (/^PASS\b/.test(verdict)) {
    return { annotation: '[sensor: pass]', isFail: false, desc: '' };
  }
  if (/^FLAG:/i.test(verdict)) {
    const desc = capDesc(verdict.replace(/^FLAG:\s*/i, '').split('\n')[0]);
    return { annotation: `[sensor: flag: ${desc}]`, isFail: false, desc };
  }
  if (/^FAIL:/i.test(verdict)) {
    const desc = capDesc(verdict.replace(/^FAIL:\s*/i, '').split('\n')[0]);
    return { annotation: `[sensor: fail — ${desc}]`, isFail: true, desc };
  }
  return {
    annotation: '[sensor: error: malformed-verdict]',
    isFail: false,
    desc: capDesc(verdict),
  };
}

/**
 * The `| type: factual|citation` TAIL of a FAIL description ("unspecified" if
 * absent). Anchored to the trailing `| type:` form — the description itself
 * can legitimately contain "type:" (e.g. a roster error quoting "item type:
 * Lecture video"), so a first-occurrence match would misclassify.
 */
export function failTypeFromDesc(desc: string): string {
  const tail = desc.match(/\|\s*type:\s*([a-z-]+)\s*$/i);
  if (tail) return tail[1].toLowerCase();
  const all = [...desc.matchAll(/\btype:\s*(factual|citation)\b/gi)];
  return all.length > 0 ? all[all.length - 1][1].toLowerCase() : 'unspecified';
}

/**
 * Choose the triage day-file to append to, avoiding a name collision with a
 * same-day file already closed to done/ (a mid-day closure
 * plus a later entry recreates the pending file, and the second closure's
 * move into done/ fails). Appends to an existing pending file when one is open;
 * otherwise picks the first `-N` suffix not already used in done/.
 */
export function pickTriageFile(triageDir: string, today: string): string {
  for (let i = 1; i < 100; i++) {
    const name =
      i === 1
        ? `${today}-response-error.md`
        : `${today}-response-error-${i}.md`;
    const pending = path.join(triageDir, name);
    if (fs.existsSync(pending)) return pending; // open day file: append
    if (!fs.existsSync(path.join(triageDir, 'done', name))) return pending;
  }
  // 99 same-day closures is not a real scenario; fail safe with a fixed name.
  return path.join(triageDir, `${today}-response-error-overflow.md`);
}

function writeTriageFile(
  repoPath: string,
  replyText: string,
  desc: string,
  citationBlock: string,
): void {
  try {
    const triageDir = path.join(repoPath, 'discussions', 'kb-triage');
    // Daily-file naming follows the audit-log convention: local calendar
    // date (Central), not UTC — consumers (exceptions-report) age these
    // files in the same zone. Entry timestamps inside stay UTC-labeled.
    const today = localDateYmd(TIMEZONE);
    const triageFile = pickTriageFile(triageDir, today);
    const time = new Date().toISOString().replace('T', ' ').slice(0, 19);
    // Entry heading is a stable anchor (G41): `## HH:MM:SS — <type>`, so the
    // daily digest can link to the specific entry, not just the day file.
    const hms = time.slice(11);
    const block = [
      `## ${hms} — ${failTypeFromDesc(desc)}`,
      ``,
      `**Detected:** ${time} UTC`,
      `**Reviewer note:** ${desc}`,
      ``,
      `### Outbound response under review`,
      ``,
      replyText,
      ``,
      `### Citation check`,
      ``,
      '```',
      citationBlock,
      '```',
      ``,
      `---`,
      ``,
    ].join('\n');
    appendToCheckout(repoPath, triageFile, block);
  } catch (err) {
    logger.warn({ err }, 'Behaviour sensor: failed to write triage file');
  }
}

/**
 * Run the sensor on a just-written outbound entry. Replaces the
 * `[sensor: pending:<id>]` placeholder in `auditFilePath` with the verdict.
 * Always non-throwing — errors land in the placeholder slot as
 * `[sensor: error: <reason>]`.
 */
/**
 * Per-run read cache over a GroundTruthReader. Every read is a synchronous
 * `git show`/`cat-file` subprocess spawn against the pinned SHA; several
 * checks read the same ground-truth files (EMAIL_ALLOWLIST.md three times
 * per reply), so one sensor run should pay for each path once. Do not reuse
 * across runs — a refresh() moves the pin.
 */
function memoizeReader(base: GroundTruthReader): GroundTruthReader {
  const files = new Map<string, string | null>();
  const existence = new Map<string, boolean>();
  return {
    refresh: (opts) => base.refresh(opts),
    readFile: (p) => {
      if (!files.has(p)) files.set(p, base.readFile(p));
      return files.get(p) ?? null;
    },
    exists: (p) => {
      if (!existence.has(p)) existence.set(p, base.exists(p));
      return existence.get(p) ?? false;
    },
    listDir: base.listDir ? (p) => base.listDir!(p) : undefined,
    commitExists: base.commitExists ? (h) => base.commitExists!(h) : undefined,
  };
}

export type SensorVerdict =
  | 'pass'
  | 'flag'
  | 'fail'
  | 'error'
  | 'skipped'
  | 'disabled';

export interface SensorEvaluation {
  verdict: SensorVerdict;
  annotation: string;
  isFail: boolean;
  desc: string;
  citationsBlock: string;
}

export interface SensorEvaluationOptions {
  requestContext?: string;
  /** Historical replay only: exclude decisions added after the reply date. */
  asOfDate?: string;
  /** Replay pins once before the suite and disables the per-reply refresh. */
  refresh?: boolean;
}

function evaluation(
  parsed: { annotation: string; isFail: boolean; desc: string },
  citationsBlock: string,
): SensorEvaluation {
  const verdict: SensorVerdict = parsed.annotation.startsWith('[sensor: fail')
    ? 'fail'
    : parsed.annotation.startsWith('[sensor: flag')
      ? 'flag'
      : parsed.annotation.startsWith('[sensor: pass')
        ? 'pass'
        : parsed.annotation.startsWith('[sensor: skipped')
          ? 'skipped'
          : parsed.annotation.startsWith('[sensor: disabled')
            ? 'disabled'
            : 'error';
  return { ...parsed, verdict, citationsBlock };
}

function cappedRequestContext(text?: string): string {
  if (!text?.trim()) return '(not available)';
  if (text.length <= SENSOR_REQUEST_CONTEXT_CAP) return text;
  return `${text.slice(0, SENSOR_REQUEST_CONTEXT_CAP)}\n[request context truncated]`;
}

/**
 * Evaluate one reply without writing an audit annotation or a triage file.
 * Production wraps this result with those side effects; the replay suite uses
 * it directly so historical FAILs can never create fresh production records.
 */
export async function evaluateBehaviourReply(
  replyText: string,
  reader?: GroundTruthReader,
  options: SensorEvaluationOptions = {},
): Promise<SensorEvaluation> {
  if (process.env.BEHAVIOUR_SENSOR_DISABLED === '1') {
    return evaluation(
      { annotation: '[sensor: disabled]', isFail: false, desc: '' },
      '(not evaluated — sensor disabled)',
    );
  }
  if (shouldSkipSensor(replyText)) {
    return evaluation(
      { annotation: '[sensor: skipped]', isFail: false, desc: '' },
      '(not evaluated — sensor skipped)',
    );
  }

  const target = resolveSensorTarget();
  if ('error' in target) {
    return evaluation(
      {
        annotation: `[sensor: error: ${target.error}]`,
        isFail: false,
        desc: target.error,
      },
      target.error === 'no-api-key'
        ? '(not evaluated — no API key)'
        : `(not evaluated — ${target.error})`,
    );
  }

  const groundTruth = memoizeReader(reader ?? getRepoReader());
  if (options.refresh !== false) groundTruth.refresh({ force: true });

  const outOfScope = classifyOutOfScope(replyText);
  let baseVerdict: { annotation: string; isFail: boolean; desc: string };
  let citationsBlock = '(not evaluated — out-of-scope reply)';
  if (outOfScope) {
    baseVerdict = {
      annotation: `[sensor: pass — out-of-scope: ${outOfScope}]`,
      isFail: false,
      desc: '',
    };
  } else {
    const curriculum = loadCurriculum(groundTruth);
    if (!curriculum) {
      return evaluation(
        {
          annotation: '[sensor: error: no-ground-truth]',
          isFail: false,
          desc: 'no-ground-truth',
        },
        '(not evaluated — no ground truth)',
      );
    }
    const decisions = loadConfirmedDecisions(
      groundTruth,
      replyText,
      options.asOfDate,
    );
    const rosters = loadSyncRosters(groundTruth, replyText);
    const citations = checkCitations(replyText, groundTruth);
    citationsBlock = citations.block;
    const prompt = buildSensorPrompt(
      replyText,
      curriculum,
      decisions,
      rosters,
      citations.block,
      cappedRequestContext(options.requestContext),
    );
    try {
      baseVerdict = parseVerdict(await callSensorModel(prompt, target));
    } catch (err) {
      if (!(err instanceof SensorStopError)) throw err;
      logger.warn(
        {
          stopReason: err.stopReason,
          model: SENSOR_MODEL,
          provider: target.provider,
        },
        'Behaviour sensor: model returned no verdict',
      );
      baseVerdict = {
        annotation: `[sensor: error: ${err.stopReason}]`,
        isFail: false,
        desc: '',
      };
    }
  }

  const hashCheck = checkCommitHashes(replyText, groundTruth);
  const premiseCheck = checkPremiseDeadClaims(replyText, groundTruth);
  const nameCheck = checkPersonNameMismatch(replyText, groundTruth);
  let parsed = applyPersonNameVerdict(
    applyPremiseDeadVerdict(
      applyCommitHashVerdict(baseVerdict, hashCheck.unverified),
      premiseCheck.flagged,
    ),
    nameCheck.flagged,
  );
  parsed = mergeFlagIntoVerdict(
    mergeFlagIntoVerdict(
      mergeFlagIntoVerdict(
        parsed,
        siteUrlTag(checkSiteUrls(replyText, groundTruth)),
      ),
      gRuleTag(checkGRuleRefs(replyText, groundTruth)),
    ),
    courseCodeTag(checkCourseCodeRefs(replyText, groundTruth)),
  );
  return evaluation(parsed, citationsBlock);
}

export async function runBehaviourSensor(
  replyText: string,
  auditFilePath: string,
  sensorId: string,
  reader?: GroundTruthReader,
  requestContext?: string,
): Promise<void> {
  const placeholder = placeholderFor(sensorId);

  try {
    const result = await evaluateBehaviourReply(replyText, reader, {
      requestContext,
    });
    if (result.isFail) {
      // Triage files are WRITES — they go to the live checkout, not the mirror.
      writeTriageFile(
        getRepoPath(),
        replyText,
        result.desc,
        result.citationsBlock,
      );
    }

    replacePlaceholder(auditFilePath, placeholder, result.annotation);
    logger.info(
      { sensorId, annotation: result.annotation.slice(0, 100) },
      'Behaviour sensor verdict written',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg, sensorId }, 'Behaviour sensor failed');
    try {
      replacePlaceholder(
        auditFilePath,
        placeholder,
        '[sensor: error: exception]',
      );
    } catch {
      // best-effort
    }
  }
}
