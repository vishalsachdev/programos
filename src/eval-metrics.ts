/**
 * Eval Metrics — one typed snapshot across every evaluation layer Coordinator has.
 *
 * The measurements already existed; they were just scattered across three
 * stores with no common shape:
 *
 *   L1 offline gates    — container/skills/<gate>/evals/golden.jsonl, run by
 *                         `npm run eval:gates`, artifact in store/eval-runs/
 *   L2 offline flows    — src/capability-scenarios.test.ts + the unit suite,
 *                         run by `npm run eval:suite`, artifact in the same dir
 *   L3 online judge     — behaviour-sensor verdicts + KB gate results, parsed
 *                         out of the daily audit-log files in program-repo
 *   L4 online self-report — the agent's own <eval> blocks, in store/evals.db
 *
 * This module joins them into one `EvalSnapshot` and nothing else: no I/O
 * policy, no rendering, no thresholds baked into the numbers. Everything is
 * injected (reader, clock, artifact loader, self-report provider) so the
 * whole thing is testable hermetically, the same way exceptions-report.ts is.
 *
 * Layer trust is NOT uniform and the snapshot says so explicitly — see
 * `LAYER_TRUST` and docs/evaluation-protocol.md. L4 is the agent grading its
 * own homework; it is a coverage signal, never evidence of correctness.
 */
import path from 'path';

import { lastNDates, parseSensorAnnotations } from './exceptions-report.js';
import { getEvalSummary, type EvalSummary } from './eval-tracker.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';
import { readFileInTree } from './host-fs-safety.js';
import { localDateYmd, zonedDayStartUtc } from './timezone.js';

/** Where `npm run eval:gates` / `eval:suite` drop their result artifacts. */
export const EVAL_RUNS_DIR = path.join(STORE_DIR, 'eval-runs');

/** Default reporting window. One week matches the exceptions-digest cadence. */
export const DEFAULT_WINDOW_DAYS = 7;

/**
 * How far an offline artifact may age before the dashboard calls it stale.
 * Gates are cheap and deterministic (run on every KB-gate change); the suite
 * runs on every push. A week without either means the offline layers are
 * decorative, which is worth seeing on the page.
 */
export const ARTIFACT_STALE_DAYS = 7;

/**
 * What each layer's numbers are actually worth. Rendered next to the numbers
 * so nobody reads a 100% self-reported citation rate as a quality result.
 */
export const LAYER_TRUST = {
  gates: { label: 'Golden set vs. real KB', tier: 'ground-truth' },
  suite: { label: 'Deterministic assertions', tier: 'ground-truth' },
  sensor: { label: 'LLM judge vs. pinned repo', tier: 'judge' },
  // Gate-result entries mix provenance: deterministic script statuses plus
  // the Opus reviewer's verdicts. The least-trusted component sets the tier.
  gateResults: { label: 'Gate scripts + reviewer subagent', tier: 'judge' },
  selfReport: { label: "Agent's own claim", tier: 'self-reported' },
} as const satisfies Record<
  string,
  { label: string; tier: 'ground-truth' | 'judge' | 'self-reported' }
>;

export type LayerId = keyof typeof LAYER_TRUST;

/** Subset of RepoReader this module needs; tests inject a stub. */
export interface AuditReader {
  refresh?(opts?: { force?: boolean }): unknown;
  readFile(relPath: string): string | null;
}

export interface SensorDay {
  date: string;
  pass: number;
  flag: number;
  fail: number;
  error: number;
  pending: number;
  disabled: number;
  skipped: number;
}

export interface SensorMetrics {
  /** Days that had an audit-log file at all (a missing day is not a zero). */
  daysWithData: number;
  pass: number;
  flag: number;
  fail: number;
  error: number;
  pending: number;
  /** Replies that shipped while BEHAVIOUR_SENSOR_DISABLED was set. */
  disabled: number;
  /** Replies the sensor skipped by design (empty/internal/lore). */
  skipped: number;
  /** pass + flag + fail — verdicts the judge actually returned. */
  judged: number;
  /** null when nothing was judged; a rate over zero samples is not zero. */
  passRate: number | null;
  failRate: number | null;
  flagRate: number | null;
  /**
   * (error + stale pending + disabled) / (judged + those). Sensor coverage
   * loss: replies that went out with no verdict and never will get one.
   * A rising value means the other rates are computed over a shrinking,
   * self-selected sample. Today's still-in-flight pendings are excluded
   * (same rule as the exceptions digest) — a verdict the sensor simply
   * hasn't written *yet* is not coverage loss; deliberate skips are
   * excluded too, but a disabled sensor counts in full.
   */
  unresolvedRate: number | null;
  byDay: SensorDay[];
  topFailures: string[];
  topFlags: string[];
}

export interface GateMetrics {
  runs: number;
  clean: number;
  blocked: number;
  hold: number;
  error: number;
  byGate: Array<{ gate: string; runs: number; clean: number }>;
}

export interface DeliveryMetrics {
  outboundEmails: number;
  deliveryProblems: number;
  ccSuppressions: number;
}

/**
 * One offline run artifact (gates or suite), as written by the runners.
 * Deliberately no index signature: the runners are untyped .mjs, so typo
 * checking on the fields the renderer reads is the only compile-time
 * protection this contract gets.
 */
export interface RunArtifact {
  generatedAt: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /**
   * Cases not scored by design (eval-gates' `allow` cases, whose verdict
   * needs the semantic leg). Separate from `skipped` so a clean run does
   * not render an amber "Skipped" tile for cases that were never meant to
   * be scored.
   */
  informational?: number;
  /**
   * Per-case detail. `scored: false` marks a case the runner deliberately
   * excluded from its pass count — the renderer must not list it as a
   * failure, whatever its status string says. This keeps status vocabulary
   * owned by the runner that minted it: a future runner's benign statuses
   * need no renderer change, while an unmarked unknown status still
   * surfaces loudly.
   */
  cases?: Array<{
    id: string;
    status: string;
    detail?: string;
    scored?: boolean;
  }>;
  /** Set when the whole run could not execute (e.g. KB checkout absent). */
  skipReason?: string;
}

/**
 * A layer's data or the reason it is absent — never both ambiguous. The
 * union makes `reason` required exactly when there is nothing to show, so
 * a missing layer cannot silently render as a clean zero.
 */
export type LayerStatus<T> =
  | {
      available: true;
      data: T;
      ageDays?: number;
      stale?: boolean;
      /** A caveat on otherwise-usable data (e.g. missing timestamp). */
      reason?: string;
    }
  | { available: false; reason: string };

export interface EvalSnapshot {
  generatedAt: string;
  window: { days: number; from: string; to: string; timeZone: string };
  gates: LayerStatus<RunArtifact>;
  suite: LayerStatus<RunArtifact>;
  sensor: LayerStatus<SensorMetrics>;
  selfReport: LayerStatus<EvalSummary>;
  /**
   * KB write-gate outcomes. Parsed from the same audit-log pass as the sensor
   * verdicts, but a separate signal: the sensor judges what went OUT, the
   * gates judge what went INTO the knowledge base.
   */
  gateMetrics: GateMetrics;
  delivery: DeliveryMetrics;
  /**
   * Population-level calibration comparison, NOT a per-response join. The two
   * layers have no shared key, so this contrasts the share of replies the
   * agent called high-confidence against the share the judge cleared.
   * A large gap is a prompt to go read cases, not a defect count.
   * `gap` is null whenever either side lacks data.
   */
  calibration: {
    selfHighConfidenceRate: number | null;
    judgeCleanRate: number | null;
    /** selfHighConfidenceRate - judgeCleanRate; positive = overclaiming. */
    gap: number | null;
    note: string;
  };
}

// --- audit-log parsing -------------------------------------------------

export type GateStatus = 'clean' | 'blocked' | 'hold' | 'error';

/**
 * One gate entry as logGateResult (audit-log.ts) writes it: the
 * `### hh:mm:ss — gate — <name>` header with the `**[GATE RESULT]** … |
 * Status: …` line directly beneath. Matching both lines in one pattern keeps
 * gate name and status paired by construction — parsing them separately and
 * zipping by index would misattribute every subsequent verdict the first
 * time an entry carried one line but not the other. The round-trip test in
 * gate-result-log.test.ts pins this regex to the writer's actual output.
 */
// Status is the writer's LAST field on the line; capture through to EOL and
// strip the optional `(exit N)` suffix afterwards. Stopping the capture at
// `|` or `(` would truncate a malformed status like `clean|unexpected` to
// its first segment and count it as a valid clean result.
const GATE_ENTRY =
  /^### \d{2}:\d{2}:\d{2} — gate — (.+)\n\*\*\[GATE RESULT\]\*\*[^\n]*?\|\s*Status:\s*([^\n]+)$/gm;

const EXIT_SUFFIX_RE = /\s*\(exit -?\d+\)\s*$/;

/**
 * Map a logged gate status onto the dashboard's four buckets. The full
 * production vocabulary (from the skills that send log_gate_result):
 *
 *   kb-entry-gate/check-kb-entry.mjs          clean | blocked
 *   kb-conflict-check crosscheck script       no-incumbents | incumbents-found
 *   kb-conflict-check skeptical reviewer      no-conflict | conflict-detected
 *
 * `incumbents-found` is a stage outcome, not an alarm: the pre-filter
 * surfaced candidate statements and escalated to the reviewer, whose own
 * verdict lands as a separate [GATE RESULT] entry under its own gate name —
 * so bucketing it as `hold` does not double-count within a gate in the
 * byGate table. Unknown statuses still classify as `error` (fail-closed):
 * an unrecognised status must surface, because the error bucket is the
 * "possible ungated write" alarm.
 */
const GATE_STATUS_MAP: Record<string, GateStatus> = {
  clean: 'clean',
  'no-conflict': 'clean',
  'no-incumbents': 'clean',
  blocked: 'blocked',
  hold: 'hold',
  'conflict-detected': 'hold',
  'incumbents-found': 'hold',
};

function classifyGateStatus(raw: string): GateStatus {
  // Exact matches only (the regex already strips the `(exit N)` suffix):
  // prefix matching would let a malformed status like `cleaned` or
  // `blocked-by-error` count as a valid result, defeating the fail-closed
  // rule that anything unrecognised lands in the error bucket.
  return GATE_STATUS_MAP[raw.trim().toLowerCase()] ?? 'error';
}

/** Gate entries (name + classified status) in one audit-log day file. */
export function parseGateResults(
  content: string,
): Array<{ gate: string; status: GateStatus }> {
  const entries: Array<{ gate: string; status: GateStatus }> = [];
  for (const m of content.matchAll(GATE_ENTRY)) {
    entries.push({
      gate: m[1].trim().slice(0, 100),
      status: classifyGateStatus(m[2].replace(EXIT_SUFFIX_RE, '')),
    });
  }
  return entries;
}

/**
 * Delivery-entry patterns, anchored to their `### hh:mm:ss — email — …`
 * headers exactly like GATE_ENTRY, never bare substrings: logOutboundEmail
 * records the untruncated body, so an email that *quotes* an audit entry
 * (a digest citing a `[CC-CONTEXT]` line, Coordinator reporting on its own
 * pipeline) would double-count under a plain marker match.
 */
const OUTBOUND_EMAIL_ENTRY =
  /^### \d{2}:\d{2}:\d{2} — email — outbound\n\*\*\[OUTBOUND EMAIL\]\*\*/gm;
const DELIVERY_PROBLEM_ENTRY =
  /^### \d{2}:\d{2}:\d{2} — email — delivery problem\n\*\*\[DELIVERY PROBLEM\]\*\*/gm;
// Like the two above, anchored to the writer's full two-line shape
// (logCcContextSuppression always emits **From:** beneath the header), so a
// quoted header line inside an untruncated email body cannot double-count.
const CC_SUPPRESSION_ENTRY =
  /^### \d{2}:\d{2}:\d{2} — email — \[CC-CONTEXT\] ack suppressed\n\*\*From:\*\*/gm;

/** Delivery-side counters in one audit-log day file. */
export function parseDeliveryMarkers(content: string): DeliveryMetrics {
  return {
    outboundEmails: (content.match(OUTBOUND_EMAIL_ENTRY) || []).length,
    deliveryProblems: (content.match(DELIVERY_PROBLEM_ENTRY) || []).length,
    ccSuppressions: (content.match(CC_SUPPRESSION_ENTRY) || []).length,
  };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/**
 * Walk the window's daily audit-log files and fold out sensor, gate, and
 * delivery counters in one pass.
 *
 * A day with no file contributes nothing and does NOT count toward
 * `daysWithData` — the difference between "Coordinator sent nothing on Sunday" and
 * "the mirror is missing Sunday" matters, and averaging over calendar days
 * would silently paper over the second.
 */
export function collectOnlineMetrics(
  reader: AuditReader,
  timeZone: string,
  now: Date,
  windowDays: number,
): {
  sensor: SensorMetrics;
  gates: GateMetrics;
  delivery: DeliveryMetrics;
} {
  const dates = lastNDates(windowDays, timeZone, now);
  const byDay: SensorDay[] = [];
  const failures: string[] = [];
  const flags: string[] = [];
  const gateCounts = { clean: 0, blocked: 0, hold: 0, error: 0 };
  const gateNames = new Map<string, { runs: number; clean: number }>();
  const delivery: DeliveryMetrics = {
    outboundEmails: 0,
    deliveryProblems: 0,
    ccSuppressions: 0,
  };

  const today = localDateYmd(timeZone, now);
  let stalePending = 0;

  for (const date of dates) {
    const content = reader.readFile(`discussions/audit-log/${date}.md`);
    if (content === null) continue;

    const s = parseSensorAnnotations(content);
    // A pending on a PAST day means the sensor never wrote its verdict;
    // today's pendings may still resolve (same rule as the exceptions
    // digest) and must not amber the unresolved rate mid-afternoon.
    if (date !== today) stalePending += s.pending;
    byDay.push({
      date,
      pass: s.pass,
      flag: s.flag.length,
      fail: s.fail.length,
      error: s.error.length,
      pending: s.pending,
      disabled: s.disabled,
      skipped: s.skipped,
    });
    failures.push(...s.fail);
    flags.push(...s.flag);

    for (const entry of parseGateResults(content)) {
      gateCounts[entry.status]++;
      const rec = gateNames.get(entry.gate) || { runs: 0, clean: 0 };
      rec.runs++;
      if (entry.status === 'clean') rec.clean++;
      gateNames.set(entry.gate, rec);
    }

    const d = parseDeliveryMarkers(content);
    delivery.outboundEmails += d.outboundEmails;
    delivery.deliveryProblems += d.deliveryProblems;
    delivery.ccSuppressions += d.ccSuppressions;
  }

  const totals = byDay.reduce(
    (acc, d) => ({
      pass: acc.pass + d.pass,
      flag: acc.flag + d.flag,
      fail: acc.fail + d.fail,
      error: acc.error + d.error,
      pending: acc.pending + d.pending,
      disabled: acc.disabled + d.disabled,
      skipped: acc.skipped + d.skipped,
    }),
    {
      pass: 0,
      flag: 0,
      fail: 0,
      error: 0,
      pending: 0,
      disabled: 0,
      skipped: 0,
    },
  );
  const judged = totals.pass + totals.flag + totals.fail;
  // Coverage loss = replies with no verdict that will never get one:
  // errors, pendings from past days, and anything sent while the sensor
  // was disabled. Deliberate skips are by design, not loss.
  const unresolved = totals.error + stalePending + totals.disabled;
  const attempted = judged + unresolved;

  return {
    sensor: {
      daysWithData: byDay.length,
      ...totals,
      judged,
      passRate: rate(totals.pass, judged),
      failRate: rate(totals.fail, judged),
      flagRate: rate(totals.flag, judged),
      unresolvedRate: rate(unresolved, attempted),
      byDay: byDay.slice().reverse(), // oldest → newest, for the trend strip
      topFailures: failures.slice(0, 10),
      topFlags: flags.slice(0, 10),
    },
    gates: {
      runs:
        gateCounts.clean +
        gateCounts.blocked +
        gateCounts.hold +
        gateCounts.error,
      ...gateCounts,
      byGate: [...gateNames.entries()]
        .map(([gate, v]) => ({ gate, runs: v.runs, clean: v.clean }))
        .sort((a, b) => b.runs - a.runs),
    },
    delivery,
  };
}

// --- offline artifacts -------------------------------------------------

/** Read a run artifact written by one of the eval runners. */
export function loadRunArtifact(
  file: string,
  now: Date,
): LayerStatus<RunArtifact> {
  let raw: string;
  try {
    // store/ is writable for the main group: never read an artifact through
    // a planted link, hard link or FIFO.
    const text = readFileInTree(path.dirname(file), path.basename(file));
    if (text === null) return { available: false, reason: 'never run' };
    raw = text;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    logger.warn({ err, file }, 'Eval metrics: run artifact unreadable');
    return { available: false, reason: `unreadable (${code ?? 'error'})` };
  }

  let data: RunArtifact;
  try {
    data = JSON.parse(raw) as RunArtifact;
  } catch (err) {
    logger.warn({ err, file }, 'Eval metrics: run artifact is not valid JSON');
    return { available: false, reason: 'artifact corrupt (invalid JSON)' };
  }

  // The runners are untyped .mjs and the file may be partially written:
  // valid JSON with missing/non-numeric counts must not render as an
  // available layer (`undefined/undefined`, failed treated as zero).
  const counts = [data.total, data.passed, data.failed, data.skipped];
  if (!counts.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    logger.warn({ file }, 'Eval metrics: run artifact missing numeric counts');
    return { available: false, reason: 'artifact malformed (bad counts)' };
  }

  const ts = Date.parse(data.generatedAt ?? '');
  if (Number.isNaN(ts)) {
    return { available: true, data, reason: 'artifact has no valid timestamp' };
  }
  const ageDays = Math.max(0, (now.getTime() - ts) / 86_400_000);
  return {
    available: true,
    data,
    ageDays: Math.round(ageDays * 10) / 10,
    stale: ageDays > ARTIFACT_STALE_DAYS,
  };
}

// --- snapshot ----------------------------------------------------------

export interface SnapshotOptions {
  reader: AuditReader;
  now?: Date;
  windowDays?: number;
  timeZone: string;
  /** Overridable for tests; defaults to the eval-tracker SQLite store. */
  selfReport?: (since: string, until: string) => EvalSummary;
  /** Overridable for tests; defaults to store/eval-runs/. */
  runsDir?: string;
}

/**
 * Build the full snapshot. Every layer is optional: a missing one is reported
 * as unavailable with a reason, never as a clean zero. The page is allowed to
 * say "we don't know" — that is the honest state most of the time for the
 * offline layers, and hiding it was the whole problem.
 */
export function buildEvalSnapshot(opts: SnapshotOptions): EvalSnapshot {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const runsDir = opts.runsDir ?? EVAL_RUNS_DIR;

  opts.reader.refresh?.({ force: false });

  const dates = lastNDates(windowDays, opts.timeZone, now);
  const from = dates[dates.length - 1];
  const to = dates[0];

  const online = collectOnlineMetrics(
    opts.reader,
    opts.timeZone,
    now,
    windowDays,
  );

  // Sensor data is only meaningful if at least one day file was readable.
  const sensorLayer: LayerStatus<SensorMetrics> =
    online.sensor.daysWithData > 0
      ? { available: true, data: online.sensor }
      : {
          available: false,
          reason: `no audit-log files found for ${from}..${to} (mirror unreachable or no traffic)`,
        };

  let selfReportLayer: LayerStatus<EvalSummary>;
  try {
    const provider = opts.selfReport ?? getEvalSummary;
    // The audit log is keyed by local calendar date, evals.db by UTC
    // timestamp — anchor the query to the same local day boundary the
    // sensor window uses, or the calibration comparison contrasts spans
    // hours apart.
    const summary = provider(
      zonedDayStartUtc(from, opts.timeZone),
      new Date(now).toISOString(),
    );
    selfReportLayer =
      summary.total > 0
        ? { available: true, data: summary }
        : { available: false, reason: 'no <eval> blocks recorded in window' };
  } catch (err) {
    logger.warn({ err }, 'Eval metrics: self-report store unavailable');
    selfReportLayer = { available: false, reason: 'evals.db unreadable' };
  }

  const gates = loadRunArtifact(path.join(runsDir, 'gates-latest.json'), now);
  const suite = loadRunArtifact(path.join(runsDir, 'suite-latest.json'), now);

  return {
    generatedAt: now.toISOString(),
    window: { days: windowDays, from, to, timeZone: opts.timeZone },
    gates,
    suite,
    sensor: sensorLayer,
    selfReport: selfReportLayer,
    gateMetrics: online.gates,
    delivery: online.delivery,
    calibration: buildCalibration(sensorLayer, selfReportLayer),
  };
}

function buildCalibration(
  sensor: LayerStatus<SensorMetrics>,
  self: LayerStatus<EvalSummary>,
): EvalSnapshot['calibration'] {
  if (!sensor.available || !self.available) {
    return {
      selfHighConfidenceRate: null,
      judgeCleanRate: null,
      gap: null,
      note: 'Not comparable: one or both layers had no data this window.',
    };
  }

  const selfHigh = rate(self.data.by_confidence['high'] ?? 0, self.data.total);
  // The judge-side rate is the sensor's own passRate — same number, same
  // polarity as the protocol doc's `judgeCleanRate`, no inversions.
  const judgeClean = sensor.data.passRate;

  return {
    selfHighConfidenceRate: selfHigh,
    judgeCleanRate: judgeClean,
    gap:
      selfHigh !== null && judgeClean !== null ? selfHigh - judgeClean : null,
    note:
      'Population comparison over the same window, not a per-response join — ' +
      'the two layers share no key. Read it as a prompt to inspect cases, not as a defect count.',
  };
}
