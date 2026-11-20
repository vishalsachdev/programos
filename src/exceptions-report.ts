/**
 * Weekly exceptions report — the single human surface for everything that
 * needs Avery's judgment.
 *
 * Built HOST-side (it needs the SQLite task_run_logs and the read mirror)
 * and written to the group IPC dir as `exceptions_report.json` before the
 * "exceptions digest" scheduled task runs — same pattern as eval_report.md
 * for quality-review tasks. The task's container script just `cat`s the
 * file: its `wakeAgent` field already encodes "is there anything to say".
 * A clean week costs zero inference and sends zero pings
 * (EXCEPTIONS_DIGEST_ALWAYS=1 overrides to always wake).
 *
 * Design rule from the review: new monitors report INTO this digest — no
 * new standalone notification paths except hard failures.
 */
import { parseHandoff, type Handoff } from './handoff.js';
import {
  parseOpenQuestions,
  scanForAutoCloseCandidates,
  type AutoCloseCandidate,
} from './open-questions-scan.js';
import { localDateYmd } from './timezone.js';
import { TaskRunLog } from './types.js';
import { WorkingContextEntry } from './working-context.js';
import {
  summarizeRoutedApprovals,
  type RoutedApprovalSummary,
} from './routed-approvals.js';

/** Subset of RepoReader the report needs (tests inject a stub). */
/**
 * How far back the digest reads task runs. Retention (src/retention.ts)
 * keeps task runs at least this long, whatever its setting says.
 */
export const EXCEPTIONS_REPORT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReportReader {
  refresh(opts?: { force?: boolean }): unknown;
  readFile(relPath: string): string | null;
  listDir(relPath: string): string[] | null;
}

export interface PausedTaskInfo {
  id: string;
  promptPreview: string;
}

export interface ExceptionsData {
  generatedAt: string;
  windowDays: number;
  sensor: {
    fail: number;
    flag: number;
    error: number;
    stalePending: number;
    samples: string[];
  };
  triage: { openHolds: Array<{ file: string; ageDays: number }> };
  tasks: {
    failures: Array<{ taskId: string; runAt: string; error: string }>;
    paused: PausedTaskInfo[];
  };
  sync: {
    checked: number;
    stale: Array<{ course: string; lastSynced: string; ageDays: number }>;
  };
  /**
   * OPEN_QUESTIONS auto-close candidates (advisory): open questions that a
   * DECISIONS entry dated within the window appears to answer. Scanning
   * only window-dated decisions gives flag-once semantics — an ignored
   * candidate is not re-nagged next Monday (open-questions-scan.ts).
   */
  openQuestions: {
    scannedDecisions: number;
    candidates: AutoCloseCandidate[];
    /**
     * Aged-question monitor (G55). `newlyAged` crossed the threshold inside
     * this window (flag-once); `totalAged` is the standing backlog count and
     * deliberately does NOT wake the agent; `missingAdded` are open questions
     * with no `(Added: …)` stamp — a write-path integrity failure.
     */
    thresholdDays: number;
    newlyAged: AgedQuestion[];
    totalAged: number;
    missingAdded: string[];
  };
  /**
   * Handoff register: pending handoffs from working-context that are past
   * their ping_after date or carry a gotcha field. Surfaces proactively so
   * expected stakeholder responses don't fall through the floor.
   */
  handoffs: {
    pending: HandoffEntry[];
    pastPingAfter: HandoffEntry[];
  };
  /**
   * Routed approvals (G42/G30, v9.10): the host relays and pings Avery
   * directly, and this digest still counts them. `openedInWindow` is the news
   * and wakes the agent; `open` is the standing list, context only.
   */
  routedApprovals: RoutedApprovalSummary;
  notes: string[];
}

export interface ExceptionsReport {
  wakeAgent: boolean;
  data: ExceptionsData;
}

const SAMPLE_LIMIT = 10;

/** YYYY-MM-DD for `date` rendered in `timeZone` (audit-log files are daily, Central). */
export function dateInZone(date: Date, timeZone: string): string {
  return localDateYmd(timeZone, date);
}

/** The last `n` calendar dates (YYYY-MM-DD, newest first) in `timeZone`. */
export function lastNDates(n: number, timeZone: string, now: Date): string[] {
  // Resolve "today" in the zone once, then decrement the CALENDAR date.
  // Subtracting fixed 24h blocks yields the same local date twice across a
  // fall DST transition (the 25-hour day) and silently skips the day before.
  const today = dateInZone(now, timeZone);
  const cursor = new Date(`${today}T00:00:00Z`);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

/**
 * Sensor annotations in one audit-log day file. Grammar comes from
 * behaviour-sensor.ts: `[sensor: pass]`, `[sensor: flag: <desc>]`,
 * `[sensor: fail — <desc>]`, `[sensor: error: <reason>]`,
 * `[sensor: pending:<id>]` (a pending left behind = the sensor never
 * finished — itself an exception), `[sensor: disabled]` (kill switch set),
 * `[sensor: skipped]` (deliberately not judged: empty/internal/lore reply).
 */
export function parseSensorAnnotations(content: string): {
  fail: string[];
  flag: string[];
  error: string[];
  pending: number;
  /**
   * Clean verdicts. The digest ignores these (it only reports exceptions),
   * but they are the denominator for the eval dashboard's rates — a fail
   * count without the passes it sits among is not a quality signal.
   */
  pass: number;
  /**
   * Replies that shipped with BEHAVIOUR_SENSOR_DISABLED set. Counted so a
   * disabled sensor reads as coverage loss on the dashboard, not as a quiet
   * week — judged=0 with disabled>0 and disabled=0 must render differently.
   */
  disabled: number;
  /** Replies the sensor skipped by design (shouldSkipSensor). Not coverage loss. */
  skipped: number;
} {
  const fail: string[] = [];
  const flag: string[] = [];
  const error: string[] = [];
  let pending = 0;
  let pass = 0;
  let disabled = 0;
  let skipped = 0;
  // Line-anchored to match the writer: logOutbound always emits the
  // placeholder (and thus the annotation that replaces it) on its own line.
  // A `[sensor: …]` marker quoted mid-prose inside an outbound-email body
  // (recorded untruncated) must not count as a verdict.
  //
  // Within a line, the marker grammar is matched EXACTLY (delimiters and
  // all): prefix matching would count a malformed `[sensor: passed]` or
  // `[sensor: pass-through]` as a clean verdict. Anything full-line that
  // fits `[sensor: …]` but not the grammar lands in the error bucket —
  // writer drift must surface, not inflate the pass rate or vanish.
  for (const m of content.matchAll(/^\[sensor: (.*)\]$/gm)) {
    const body = m[1];
    if (body === 'fail' || body.startsWith('fail — '))
      fail.push(body.slice(0, 160));
    else if (body.startsWith('flag: ')) flag.push(body.slice(0, 160));
    else if (body === 'error' || body.startsWith('error: '))
      error.push(body.slice(0, 160));
    else if (body.startsWith('pending:')) pending++;
    else if (body === 'pass' || body.startsWith('pass — ')) pass++;
    else if (body === 'disabled') disabled++;
    else if (body === 'skipped') skipped++;
    else error.push(`unrecognized marker: ${body}`.slice(0, 160));
  }
  return { fail, flag, error, pending, pass, disabled, skipped };
}

/** Age in whole days of a `YYYY-MM-DD-*` dated filename; null if undated. */
export function fileAgeDays(
  filename: string,
  timeZone: string,
  now: Date,
): number | null {
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const today = dateInZone(now, timeZone);
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${m[1]}T00:00:00Z`);
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** `**Last synced:** YYYY-MM-DD ...` date from a `_last-synced.md`, or null. */
export function parseLastSynced(content: string): string | null {
  const m = content.match(/\*\*Last synced:\*\*\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Open kb-triage holds: every .md directly in discussions/kb-triage/ except
 * `done/` (a subdir, filtered by extension) and `*-report.md` (disposition
 * reports are documentation, not holds).
 */
export function collectOpenHolds(
  reader: ReportReader,
  timeZone: string,
  now: Date,
): Array<{ file: string; ageDays: number }> {
  const entries = reader.listDir('discussions/kb-triage') || [];
  return entries
    .filter((e) => e.endsWith('.md') && !e.endsWith('-report.md'))
    .map((file) => ({
      file,
      ageDays: fileAgeDays(file, timeZone, now) ?? 0,
    }))
    .sort((a, b) => b.ageDays - a.ageDays);
}

/** Box-sync staleness: courses whose `_last-synced.md` is older than 36h. */
export function collectSyncStaleness(
  reader: ReportReader,
  timeZone: string,
  now: Date,
): { checked: number; stale: ExceptionsData['sync']['stale'] } {
  const STALE_AFTER_DAYS = 1.5; // autosync runs ~4x/day; >36h means it stopped
  const courses = reader.listDir('courses') || [];
  let checked = 0;
  const stale: ExceptionsData['sync']['stale'] = [];
  for (const course of courses) {
    const content = reader.readFile(`courses/${course}/sync/_last-synced.md`);
    if (content === null) continue; // not a synced course
    checked++;
    const lastSynced = parseLastSynced(content);
    if (!lastSynced) {
      stale.push({ course, lastSynced: 'unparseable', ageDays: -1 });
      continue;
    }
    const today = dateInZone(now, timeZone);
    const ageDays =
      (Date.parse(`${today}T00:00:00Z`) -
        Date.parse(`${lastSynced}T00:00:00Z`)) /
      86_400_000;
    if (ageDays > STALE_AFTER_DAYS) {
      stale.push({ course, lastSynced, ageDays: Math.round(ageDays) });
    }
  }
  return { checked, stale };
}

/**
 * Governance contract check (registry change protocol, kb-governance.md): the
 * kb-conflict-check skill and the Coordinator playbook reference program-repo
 * CLAUDE.md's "KB Write Protocol" section by exact heading name. If the
 * heading (or the file) disappears from the mirror, surface it in the digest —
 * the coupling is convention-guarded in the file, monitored here.
 */
export function checkGovernanceContracts(reader: ReportReader): string[] {
  const claudeMd = reader.readFile('CLAUDE.md');
  if (claudeMd === null) {
    return [
      'contract check: program-repo CLAUDE.md unreadable from the mirror',
    ];
  }
  if (!/^## KB Write Protocol\s*$/m.test(claudeMd)) {
    return [
      'contract check: "## KB Write Protocol" heading missing from program-repo CLAUDE.md — kb-conflict-check and the Coordinator playbook reference it by exact name (G1–G10 anchor)',
    ];
  }
  return [];
}

/** Default age at which an unresolved open question surfaces (RC-012/G55). */
export const AGED_QUESTION_DAYS = 14;

/** Cap on enumerated items per aged-question list (digest stays scannable). */
const AGED_SAMPLE_LIMIT = 10;

export interface AgedQuestion {
  title: string;
  added: string;
  ageDays: number;
}

/** `(Added: YYYY-MM-DD)` stamped by the kb-entry-gate skill (G55); null if absent. */
export function parseAddedDate(text: string): string | null {
  const m = text.match(/\(Added:\s*(\d{4}-\d{2}-\d{2})\)/);
  return m ? m[1] : null;
}

/**
 * Aged OPEN_QUESTIONS monitor (RC-012 → G55).
 *
 * Reports questions that crossed `thresholdDays` *within this window* rather
 * than every question currently older than the threshold. That gives the same
 * flag-once semantics as the auto-close scanner: no suppression state to
 * maintain, and an item Avery consciously left open is not re-nagged every
 * Monday for the rest of its life. The backlog that was already aged when the
 * monitor shipped stays visible as `totalAged` — a single number, not 100
 * one-liners, because a digest nobody can scan is a digest nobody reads.
 *
 * `missingAdded` is the integrity backstop for the write path: the kb-entry-gate
 * skill stamps `(Added: …)`, but a skipped gate would otherwise make an undated
 * question look permanently new and silently never age. Reporting it converts
 * that silent failure into a visible one.
 */
export function collectAgedOpenQuestions(
  reader: ReportReader,
  windowDays: number,
  timeZone: string,
  now: Date,
  thresholdDays: number = AGED_QUESTION_DAYS,
): {
  newlyAged: AgedQuestion[];
  totalAged: number;
  missingAdded: string[];
} {
  const content = reader.readFile('discussions/OPEN_QUESTIONS.md');
  if (content === null) {
    return { newlyAged: [], totalAged: 0, missingAdded: [] };
  }

  const today = Date.parse(`${dateInZone(now, timeZone)}T00:00:00Z`);
  const newlyAged: AgedQuestion[] = [];
  const missingAdded: string[] = [];
  let totalAged = 0;

  for (const item of parseOpenQuestions(content)) {
    const added = parseAddedDate(item.text);
    if (!added) {
      if (missingAdded.length < AGED_SAMPLE_LIMIT)
        missingAdded.push(item.title.slice(0, 120));
      continue;
    }
    const ageDays = Math.round(
      (today - Date.parse(`${added}T00:00:00Z`)) / 86_400_000,
    );
    if (ageDays < thresholdDays) continue;
    totalAged++;
    // Crossed the threshold inside this window → report once, now.
    if (ageDays - thresholdDays < windowDays) {
      newlyAged.push({ title: item.title.slice(0, 120), added, ageDays });
    }
  }

  newlyAged.sort((a, b) => b.ageDays - a.ageDays);
  return {
    newlyAged: newlyAged.slice(0, AGED_SAMPLE_LIMIT),
    totalAged,
    missingAdded,
  };
}

/**
 * A pending handoff as surfaced by the digest. Alias of the canonical
 * `Handoff` — validation and normalization live in `src/handoff.ts`
 * (`parseHandoff`), the single owner of the handoff shape.
 */
export type HandoffEntry = Handoff;

/**
 * Collect unresolved handoffs worth surfacing:
 *   pending       — past ping_after OR carrying a gotcha
 *   pastPingAfter — subset of pending that are past ping_after today
 *
 * Validity is delegated entirely to `parseHandoff` — no field checks here, so
 * this can never disagree with the loader about what a handoff is. The `today >=
 * ping_after` comparison is lexical and correct only because parseHandoff
 * guarantees exact `YYYY-MM-DD`.
 *
 * The audit-log grep (checking whether a response arrived) is deferred to
 * v2 — the ping_after date check covers most cases.
 */
export function collectPendingHandoffs(
  entries: WorkingContextEntry[],
  timeZone: string,
  now: Date,
): { pending: HandoffEntry[]; pastPingAfter: HandoffEntry[] } {
  const today = dateInZone(now, timeZone);

  const pending: HandoffEntry[] = [];
  const pastPingAfter: HandoffEntry[] = [];

  for (const e of entries) {
    const handoff = parseHandoff(e);
    if (handoff === null || handoff.resolved) continue;

    const isPast = today >= handoff.ping_after;
    if (isPast || handoff.gotcha !== undefined) {
      pending.push(handoff);
      if (isPast) pastPingAfter.push(handoff);
    }
  }

  // Oldest first so the digest renders chronologically.
  pending.sort((a, b) => a.ping_after.localeCompare(b.ping_after));
  pastPingAfter.sort((a, b) => a.ping_after.localeCompare(b.ping_after));

  return { pending, pastPingAfter };
}

export interface BuildDeps {
  reader: ReportReader;
  taskRuns: TaskRunLog[]; // last-window runs, host queries the DB
  pausedTasks: PausedTaskInfo[];
  timeZone: string;
  now?: Date;
  windowDays?: number;
  alwaysWake?: boolean;
  /** Raw working-context entries for the admin user (avery). Loaded by the
   *  host before calling buildExceptionsReport so the function stays pure/
   *  testable without touching the filesystem. Pass [] when unavailable. */
  workingContextEntries: WorkingContextEntry[];
}

export function buildExceptionsReport(deps: BuildDeps): ExceptionsReport {
  const now = deps.now ?? new Date();
  const windowDays = deps.windowDays ?? 7;
  const notes: string[] = [];

  try {
    deps.reader.refresh({ force: true });
  } catch {
    notes.push('read-mirror refresh failed — sensor/triage data may be stale');
  }

  notes.push(...checkGovernanceContracts(deps.reader));

  // Sensor verdicts over the window's audit-log day files.
  const sensor = {
    fail: 0,
    flag: 0,
    error: 0,
    stalePending: 0,
    samples: [] as string[],
  };
  const today = dateInZone(now, deps.timeZone);
  for (const date of lastNDates(windowDays, deps.timeZone, now)) {
    const content = deps.reader.readFile(`discussions/audit-log/${date}.md`);
    if (content === null) continue;
    const parsed = parseSensorAnnotations(content);
    sensor.fail += parsed.fail.length;
    sensor.flag += parsed.flag.length;
    sensor.error += parsed.error.length;
    // A pending on a PAST day means the sensor never wrote its verdict.
    if (date !== today) sensor.stalePending += parsed.pending;
    for (const s of [...parsed.fail, ...parsed.flag]) {
      if (sensor.samples.length < SAMPLE_LIMIT)
        sensor.samples.push(`${date}: ${s}`);
    }
  }

  const openHolds = collectOpenHolds(deps.reader, deps.timeZone, now);
  const sync = collectSyncStaleness(deps.reader, deps.timeZone, now);
  const handoffs = collectPendingHandoffs(
    deps.workingContextEntries ?? [],
    deps.timeZone,
    now,
  );

  // OPEN_QUESTIONS auto-close scan: decisions dated within the window vs
  // all open questions. Missing files degrade to an empty scan (mirror may
  // be stale; the refresh failure is already noted above).
  const sinceDate = dateInZone(
    new Date(now.getTime() - windowDays * 86_400_000),
    deps.timeZone,
  );
  const openQuestionsMd =
    deps.reader.readFile('discussions/OPEN_QUESTIONS.md') ?? '';
  const decisionsMd = deps.reader.readFile('discussions/DECISIONS.md') ?? '';
  const oqScan = scanForAutoCloseCandidates(
    openQuestionsMd,
    decisionsMd,
    sinceDate,
  );

  const routedApprovals = summarizeRoutedApprovals(openQuestionsMd, sinceDate);

  const aged = collectAgedOpenQuestions(
    deps.reader,
    windowDays,
    deps.timeZone,
    now,
  );

  const failures = deps.taskRuns
    .filter((r) => r.status === 'error')
    .map((r) => ({
      taskId: r.task_id,
      runAt: r.run_at,
      error: (r.error || 'unknown').slice(0, 160),
    }));

  const data: ExceptionsData = {
    generatedAt: now.toISOString(),
    windowDays,
    sensor,
    triage: { openHolds },
    tasks: { failures, paused: deps.pausedTasks },
    sync,
    openQuestions: {
      scannedDecisions: oqScan.scannedDecisions,
      candidates: oqScan.candidates,
      thresholdDays: AGED_QUESTION_DAYS,
      newlyAged: aged.newlyAged,
      totalAged: aged.totalAged,
      missingAdded: aged.missingAdded,
    },
    handoffs,
    routedApprovals,
    notes,
  };

  const hasExceptions =
    sensor.fail > 0 ||
    sensor.flag > 0 ||
    sensor.error > 0 ||
    sensor.stalePending > 0 ||
    openHolds.length > 0 ||
    failures.length > 0 ||
    deps.pausedTasks.length > 0 ||
    sync.stale.length > 0 ||
    oqScan.candidates.length > 0 ||
    // totalAged is deliberately NOT a wake condition: the standing backlog is
    // context, not news, and waking on it would ping every week forever.
    aged.newlyAged.length > 0 ||
    aged.missingAdded.length > 0 ||
    handoffs.pending.length > 0 ||
    routedApprovals.openedInWindow > 0 ||
    notes.length > 0;

  return { wakeAgent: hasExceptions || deps.alwaysWake === true, data };
}
