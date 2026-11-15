/**
 * Eval metrics aggregation.
 *
 * The load-bearing property under test is that an absent layer reports
 * *absent* — not a clean zero. A dashboard that renders "0 failures" when the
 * mirror is unreachable is worse than no dashboard, and that is exactly the
 * failure mode a metrics layer invites.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARTIFACT_STALE_DAYS,
  buildEvalSnapshot,
  collectOnlineMetrics,
  loadRunArtifact,
  parseDeliveryMarkers,
  parseGateResults,
  type AuditReader,
} from './eval-metrics.js';
import type { EvalSummary } from './eval-tracker.js';

const TZ = 'America/Chicago';
// 2026-08-06 12:00 Central.
const NOW = new Date('2026-08-06T17:00:00Z');

const DAY_WITH_TRAFFIC = `### 09:00:00 — email — outbound
**From:** Coordinator
body
[sensor: pass]

---

### 09:30:00 — email — outbound
[sensor: pass]

---

### 10:00:00 — telegram — outbound
[sensor: flag: propagation-lag — curriculum.md still shows 33 credits]

---

### 11:00:00 — email — outbound
[sensor: fail — Applied Topics is Draft, not Confirmed | type: factual]

---

### 11:30:00 — email — outbound
[sensor: pending:abc123]

---

### 12:00:00 — gate — kb-entry-gate
**[GATE RESULT]** Group: program-email | Script: check-kb-entry.mjs | Status: clean (exit 0)

---

### 12:05:00 — gate — kb-conflict-check
**[GATE RESULT]** Group: program-email | Status: blocked (exit 2)

---

### 13:00:00 — email — outbound
**[OUTBOUND EMAIL]** To: paige@example.edu | Subject: CRS 554

---

### 13:30:00 — email — delivery problem
**[DELIVERY PROBLEM]** bounce | To: bad@nowhere.test | Subject: x

---

### 14:00:00 — email — [CC-CONTEXT] ack suppressed
**From:** user102@example.edu

---
`;

/** Reader that serves one day file and nothing else. */
function readerFor(files: Record<string, string>): AuditReader {
  return { readFile: (rel) => files[rel] ?? null };
}

describe('parseGateResults', () => {
  it('emits gate name and status paired per entry', () => {
    expect(parseGateResults(DAY_WITH_TRAFFIC)).toEqual([
      { gate: 'kb-entry-gate', status: 'clean' },
      { gate: 'kb-conflict-check', status: 'blocked' },
    ]);
  });

  it('treats an unrecognised status as an error, not as clean', () => {
    const day =
      '### 09:00:00 — gate — kb-entry-gate\n' +
      '**[GATE RESULT]** Group: g | Status: timed out waiting for subagent';
    expect(parseGateResults(day)).toEqual([
      { gate: 'kb-entry-gate', status: 'error' },
    ]);
  });

  it('ignores a status line with no gate header directly above it', () => {
    // The writer (logGateResult) always emits header + status adjacently;
    // a stray status line must not be attributed to some earlier gate.
    const day = '**[GATE RESULT]** Group: g | Status: clean (exit 0)';
    expect(parseGateResults(day)).toEqual([]);
  });

  it('classifies the full production status vocabulary, not just kb-entry-gate', () => {
    // The other two log_gate_result senders (kb-conflict-check's crosscheck
    // script and skeptical reviewer) use their own status strings. Bucketing
    // them as `error` would inflate the "possible ungated write" alarm on
    // every routine conflict-check run.
    const entry = (gate: string, status: string) =>
      `### 09:00:00 — gate — ${gate}\n**[GATE RESULT]** Group: g | Status: ${status}`;
    const day = [
      entry('kb-conflict-check/ingestion-crosscheck', 'no-incumbents'),
      entry(
        'kb-conflict-check/ingestion-crosscheck',
        'incumbents-found (exit 3)',
      ),
      entry('kb-conflict-check/skeptical-reviewer', 'no-conflict'),
      entry('kb-conflict-check/skeptical-reviewer', 'conflict-detected'),
    ].join('\n\n');
    expect(parseGateResults(day).map((e) => e.status)).toEqual([
      'clean',
      'hold',
      'clean',
      'hold',
    ]);
  });

  it('classifies near-miss malformed statuses as error, never as valid results', () => {
    // Status strings arrive via IPC payloads; prefix matching would let a
    // corrupted value pass as a verdict and make the dashboard look clean.
    const entry = (status: string) =>
      `### 09:00:00 — gate — g\n**[GATE RESULT]** Group: g | Status: ${status}`;
    const day = [
      entry('cleaned'),
      entry('blocked-by-error'),
      entry('conflictual'),
      entry('holdover'),
      // Pipe-bearing statuses must classify on the FULL string: a capture
      // stopping at `|` would truncate this to `clean` and count it valid.
      entry('clean|unexpected'),
    ].join('\n\n');
    expect(parseGateResults(day).map((e) => e.status)).toEqual([
      'error',
      'error',
      'error',
      'error',
      'error',
    ]);
  });
});

describe('parseDeliveryMarkers', () => {
  it('counts outbound, problem, and cc-suppression markers separately', () => {
    expect(parseDeliveryMarkers(DAY_WITH_TRAFFIC)).toEqual({
      outboundEmails: 1,
      deliveryProblems: 1,
      ccSuppressions: 1,
    });
  });

  it('does not double-count markers quoted inside an email body', () => {
    // logOutboundEmail records the untruncated body, so an email that
    // *quotes* audit entries (a digest citing a [CC-CONTEXT] line, Coordinator
    // reporting on its own pipeline) contains the markers as prose.
    const day = `### 13:00:00 — email — outbound
**[OUTBOUND EMAIL]** To: avery@example.edu | Subject: pipeline report
**Source:** program-email | **Resend ID:** re_1

Yesterday the log recorded **[OUTBOUND EMAIL]** twice, one
**[DELIVERY PROBLEM]** bounce, and a [CC-CONTEXT] suppression.

A digest excerpt even quoted the full header at start-of-line:
### 14:00:00 — email — [CC-CONTEXT] ack suppressed
but with no **From:** line beneath it, it is prose, not an entry.

---
`;
    expect(parseDeliveryMarkers(day)).toEqual({
      outboundEmails: 1,
      deliveryProblems: 0,
      ccSuppressions: 0,
    });
  });
});

describe('collectOnlineMetrics', () => {
  it('folds sensor, gate, and delivery counters out of the window', () => {
    // Served on a PAST day: its stuck pending is real coverage loss.
    const reader = readerFor({
      'discussions/audit-log/2026-08-05.md': DAY_WITH_TRAFFIC,
    });
    const m = collectOnlineMetrics(reader, TZ, NOW, 7);

    expect(m.sensor.daysWithData).toBe(1);
    expect(m.sensor.pass).toBe(2);
    expect(m.sensor.flag).toBe(1);
    expect(m.sensor.fail).toBe(1);
    expect(m.sensor.pending).toBe(1);
    expect(m.sensor.judged).toBe(4);
    expect(m.sensor.passRate).toBeCloseTo(0.5);
    expect(m.sensor.failRate).toBeCloseTo(0.25);
    // A past-day stuck pending is coverage loss: 1 unresolved of 5 attempted.
    expect(m.sensor.unresolvedRate).toBeCloseTo(0.2);

    expect(m.gates.runs).toBe(2);
    expect(m.gates.clean).toBe(1);
    expect(m.gates.blocked).toBe(1);
    expect(m.gates.byGate).toEqual([
      { gate: 'kb-entry-gate', runs: 1, clean: 1 },
      { gate: 'kb-conflict-check', runs: 1, clean: 0 },
    ]);

    expect(m.delivery.outboundEmails).toBe(1);
  });

  it("excludes today's still-in-flight pendings from the unresolved rate", () => {
    // Same rule as the exceptions digest: a verdict the sensor simply has
    // not written *yet* must not amber the coverage tile mid-afternoon.
    const reader = readerFor({
      'discussions/audit-log/2026-08-06.md':
        '[sensor: pass]\n[sensor: pending:abc]',
    });
    const m = collectOnlineMetrics(reader, TZ, NOW, 7);
    expect(m.sensor.pending).toBe(1); // still visible as a count
    expect(m.sensor.unresolvedRate).toBe(0); // but not coverage loss (yet)
  });

  it('counts sensor-disabled replies as coverage loss, deliberate skips not', () => {
    // judged=0 with the sensor switched off must never resemble a quiet
    // week; shouldSkipSensor skips (empty/internal/lore) are by design.
    const reader = readerFor({
      'discussions/audit-log/2026-08-05.md':
        '[sensor: pass]\n[sensor: disabled]\n[sensor: skipped]',
    });
    const m = collectOnlineMetrics(reader, TZ, NOW, 7);
    expect(m.sensor.disabled).toBe(1);
    expect(m.sensor.skipped).toBe(1);
    expect(m.sensor.unresolvedRate).toBeCloseTo(0.5); // disabled / (pass+disabled)
  });

  it('does not count a missing day as a day with zero failures', () => {
    const m = collectOnlineMetrics(readerFor({}), TZ, NOW, 7);
    expect(m.sensor.daysWithData).toBe(0);
    expect(m.sensor.byDay).toEqual([]);
    // Rates over an empty sample are null, never 0 — 0% failures and
    // "we measured nothing" must not render identically.
    expect(m.sensor.passRate).toBeNull();
    expect(m.sensor.failRate).toBeNull();
    expect(m.sensor.unresolvedRate).toBeNull();
  });

  it('orders the daily trend oldest-first', () => {
    const reader = readerFor({
      'discussions/audit-log/2026-08-06.md': '[sensor: pass]',
      'discussions/audit-log/2026-08-04.md': '[sensor: pass]',
    });
    const m = collectOnlineMetrics(reader, TZ, NOW, 7);
    expect(m.sensor.byDay.map((d) => d.date)).toEqual([
      '2026-08-04',
      '2026-08-06',
    ]);
  });
});

describe('loadRunArtifact', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-artifact-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, body: unknown): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
    return p;
  }

  it('reports a never-run artifact as unavailable with a reason', () => {
    const r = loadRunArtifact(path.join(dir, 'nope.json'), NOW);
    expect(r.available).toBe(false);
    expect(r.reason).toBe('never run');
  });

  it('refuses to treat corrupt JSON as an empty result', () => {
    const p = write('bad.json', '{not json');
    const r = loadRunArtifact(p, NOW);
    expect(r.available).toBe(false);
    expect(r.reason).toContain('corrupt');
  });

  it('refuses valid JSON that lacks the numeric count fields', () => {
    // The runners are untyped scripts; a partially written artifact must
    // not render as an available layer with undefined counts.
    const p = write(
      'partial.json',
      JSON.stringify({ generatedAt: NOW.toISOString(), passed: 3 }),
    );
    const r = loadRunArtifact(p, NOW);
    expect(r.available).toBe(false);
    expect(r.reason).toContain('malformed');
  });

  it('computes age and marks an artifact past the freshness bar as stale', () => {
    const old = new Date(
      NOW.getTime() - (ARTIFACT_STALE_DAYS + 3) * 86_400_000,
    ).toISOString();
    const p = write('gates.json', {
      generatedAt: old,
      total: 14,
      passed: 14,
      failed: 0,
      skipped: 4,
    });
    const r = loadRunArtifact(p, NOW);
    if (!r.available) throw new Error('expected an available artifact');
    expect(r.stale).toBe(true);
    expect(r.ageDays).toBeCloseTo(ARTIFACT_STALE_DAYS + 3, 1);
  });

  it('keeps a fresh artifact unstale', () => {
    const p = write('gates.json', {
      generatedAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      total: 14,
      passed: 14,
      failed: 0,
      skipped: 4,
    });
    const r = loadRunArtifact(p, NOW);
    if (!r.available) throw new Error('expected an available artifact');
    expect(r.stale).toBe(false);
  });
});

const EMPTY_SUMMARY: EvalSummary = {
  total: 0,
  by_confidence: {},
  by_category: {},
  by_channel: {},
  citation_rate: 0,
  avg_response_length: 0,
  low_confidence_entries: [],
  top_topics: [],
};

describe('buildEvalSnapshot', () => {
  let runsDir: string;

  beforeEach(() => {
    runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runs-'));
  });
  afterEach(() => {
    fs.rmSync(runsDir, { recursive: true, force: true });
  });

  it('marks every layer unavailable — with a reason — when nothing has run', () => {
    const s = buildEvalSnapshot({
      reader: readerFor({}),
      now: NOW,
      timeZone: TZ,
      runsDir,
      selfReport: () => EMPTY_SUMMARY,
    });

    expect(s.sensor.available).toBe(false);
    expect(s.sensor.reason).toContain('no audit-log files');
    expect(s.selfReport.available).toBe(false);
    expect(s.gates.available).toBe(false);
    expect(s.suite.available).toBe(false);
    expect(s.calibration.gap).toBeNull();
    expect(s.window).toEqual({
      days: 7,
      from: '2026-07-31',
      to: '2026-08-06',
      timeZone: TZ,
    });
  });

  it('queries the self-report store over the same span the sensor covers', () => {
    let since = '';
    buildEvalSnapshot({
      reader: readerFor({}),
      now: NOW,
      timeZone: TZ,
      runsDir,
      selfReport: (s) => {
        since = s;
        return EMPTY_SUMMARY;
      },
    });
    // Window `from` is the Central date 2026-07-31; the query must start at
    // that day's Central midnight, not UTC midnight five hours earlier —
    // otherwise the calibration comparison contrasts two different spans.
    expect(since).toBe('2026-07-31T05:00:00.000Z');
  });

  it('survives a self-report store that throws', () => {
    const s = buildEvalSnapshot({
      reader: readerFor({}),
      now: NOW,
      timeZone: TZ,
      runsDir,
      selfReport: () => {
        throw new Error('SQLITE_CANTOPEN');
      },
    });
    expect(s.selfReport.available).toBe(false);
    expect(s.selfReport.reason).toBe('evals.db unreadable');
  });

  it('computes the calibration gap only when both layers have data', () => {
    const s = buildEvalSnapshot({
      reader: readerFor({
        'discussions/audit-log/2026-08-06.md': DAY_WITH_TRAFFIC,
      }),
      now: NOW,
      timeZone: TZ,
      runsDir,
      selfReport: () => ({
        ...EMPTY_SUMMARY,
        total: 4,
        by_confidence: { high: 4 },
      }),
    });

    expect(s.calibration.selfHighConfidenceRate).toBeCloseTo(1);
    // Judge cleared 2 of 4 → judgeCleanRate 0.5. Agent claimed high on all 4.
    expect(s.calibration.judgeCleanRate).toBeCloseTo(0.5);
    expect(s.calibration.gap).toBeCloseTo(0.5);
  });

  it('surfaces gate metrics alongside the sensor layer', () => {
    const s = buildEvalSnapshot({
      reader: readerFor({
        'discussions/audit-log/2026-08-06.md': DAY_WITH_TRAFFIC,
      }),
      now: NOW,
      timeZone: TZ,
      runsDir,
      selfReport: () => EMPTY_SUMMARY,
    });
    expect(s.gateMetrics.runs).toBe(2);
    expect(s.gateMetrics.clean).toBe(1);
    expect(s.delivery.ccSuppressions).toBe(1);
  });
});
