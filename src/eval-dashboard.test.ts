/**
 * Dashboard rendering.
 *
 * The rendering rule worth pinning: a layer with no data must say so on the
 * page. A dashboard that quietly omits an unmeasured layer reads as "all
 * clear" — the same trap the aggregator guards against, one level up.
 */
import { describe, expect, it } from 'vitest';

import { levelFor, renderDashboard, THRESHOLDS } from './eval-dashboard.js';
import type { EvalSnapshot } from './eval-metrics.js';

const BASE: EvalSnapshot = {
  generatedAt: '2026-08-06T17:00:00.000Z',
  window: {
    days: 7,
    from: '2026-07-31',
    to: '2026-08-06',
    timeZone: 'America/Chicago',
  },
  gates: { available: false, reason: 'never run' },
  suite: { available: false, reason: 'never run' },
  sensor: { available: false, reason: 'no audit-log files found' },
  selfReport: {
    available: false,
    reason: 'no <eval> blocks recorded in window',
  },
  gateMetrics: { runs: 0, clean: 0, blocked: 0, hold: 0, error: 0, byGate: [] },
  delivery: { outboundEmails: 0, deliveryProblems: 0, ccSuppressions: 0 },
  calibration: {
    selfHighConfidenceRate: null,
    judgeCleanRate: null,
    gap: null,
    note: 'Not comparable.',
  },
};

describe('levelFor', () => {
  it('returns unknown for a null measurement rather than good', () => {
    expect(levelFor(null, THRESHOLDS.sensorFailRate)).toBe('unknown');
  });

  it('escalates across the amber and red bounds', () => {
    expect(levelFor(0, THRESHOLDS.sensorFailRate)).toBe('good');
    expect(levelFor(0.01, THRESHOLDS.sensorFailRate)).toBe('amber');
    expect(levelFor(0.05, THRESHOLDS.sensorFailRate)).toBe('red');
  });
});

describe('renderDashboard', () => {
  it('states the reason for every unmeasured layer instead of showing zeros', () => {
    const html = renderDashboard(BASE);
    expect(html).toContain('no audit-log files found');
    expect(html).toContain('never run');
    expect(html).toContain('no &lt;eval&gt; blocks recorded in window');
    // The nudge to actually run the thing.
    expect(html).toContain('npm run eval:gates');
    expect(html).toContain('npm run eval:suite');
  });

  it('is a self-contained page — no external script, style, or font', () => {
    const html = renderDashboard(BASE);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/i);
  });

  it('emits a full document shell with charset and viewport metas', () => {
    // Served without a charset header (python http.server, bare nginx), a
    // headless fragment makes Chrome guess windows-1252 — every em-dash in
    // the page renders as mojibake; no viewport meta = desktop-scaled on
    // phones.
    const html = renderDashboard(BASE);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html).toMatch(/<\/html>\s*$/);
  });

  it('escapes verdict text so a reply cannot inject markup into the page', () => {
    const html = renderDashboard({
      ...BASE,
      sensor: {
        available: true,
        data: {
          daysWithData: 1,
          pass: 1,
          flag: 0,
          fail: 1,
          error: 0,
          pending: 0,
          disabled: 0,
          skipped: 0,
          judged: 2,
          passRate: 0.5,
          failRate: 0.5,
          flagRate: 0,
          unresolvedRate: 0,
          byDay: [
            {
              date: '2026-08-06',
              pass: 1,
              flag: 0,
              fail: 1,
              error: 0,
              pending: 0,
              disabled: 0,
              skipped: 0,
            },
          ],
          topFailures: ['<img src=x onerror="alert(1)"> bad claim'],
          topFlags: [],
        },
      },
    });
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).not.toContain('<img src=x');
  });

  it('shows the deliberate-skip count in the sensor section', () => {
    // A day of only-skipped outbounds (empty replies, lore:intentional)
    // must not read as "no traffic": the count is aggregated in
    // SensorMetrics and has to reach the page.
    const html = renderDashboard({
      ...BASE,
      sensor: {
        available: true,
        data: {
          daysWithData: 1,
          pass: 0,
          flag: 0,
          fail: 0,
          error: 0,
          pending: 0,
          disabled: 0,
          skipped: 3,
          judged: 0,
          passRate: null,
          failRate: null,
          flagRate: null,
          unresolvedRate: null,
          byDay: [
            {
              date: '2026-08-06',
              pass: 0,
              flag: 0,
              fail: 0,
              error: 0,
              pending: 0,
              disabled: 0,
              skipped: 3,
            },
          ],
          topFailures: [],
          topFlags: [],
        },
      },
    });
    expect(html).toContain('3 skipped by design');
  });

  it('renders a skipped offline run as skipped, not as a pass', () => {
    const html = renderDashboard({
      ...BASE,
      gates: {
        available: true,
        ageDays: 0.2,
        stale: false,
        data: {
          generatedAt: '2026-08-06T16:00:00.000Z',
          total: 18,
          passed: 0,
          failed: 0,
          skipped: 18,
          skipReason: 'program-repo checkout not found',
        },
      },
    });
    expect(html).toContain('Run did not execute');
    expect(html).toContain('program-repo checkout not found');
    expect(html).not.toContain('0/18');
  });

  it('does not list runner-excluded or informational cases as failures', () => {
    // eval-gates marks every `allow` case informational + scored:false and
    // excludes it from its own pass count; listing them here would invert
    // the runner's intent. A future runner's own benign vocabulary is
    // covered by the scored flag alone, with no renderer change.
    const html = renderDashboard({
      ...BASE,
      gates: {
        available: true,
        ageDays: 0.1,
        stale: false,
        data: {
          generatedAt: '2026-08-06T16:00:00.000Z',
          total: 11,
          passed: 11,
          failed: 0,
          skipped: 0,
          informational: 7,
          cases: [
            { id: 'verbatim-dup-block', status: 'pass' },
            { id: 'novel-legit-allow', status: 'informational', scored: false },
            {
              id: 'future-runner-benign',
              status: 'needs-subagent',
              scored: false,
            },
          ],
        },
      },
    });
    expect(html).not.toContain('Failing cases');
    expect(html).not.toContain('novel-legit-allow');
    expect(html).not.toContain('future-runner-benign');
    // Informational cases get their own tile, not the amber Skipped tile.
    expect(html).toContain('Informational');
    expect(html).toContain('not scored by design');
  });

  it('surfaces an unrecognised case status rather than hiding it', () => {
    const html = renderDashboard({
      ...BASE,
      gates: {
        available: true,
        ageDays: 0.1,
        stale: false,
        data: {
          generatedAt: '2026-08-06T16:00:00.000Z',
          total: 2,
          passed: 1,
          failed: 1,
          skipped: 0,
          cases: [{ id: 'weird-case', status: 'timeout', detail: 'no output' }],
        },
      },
    });
    expect(html).toContain('weird-case');
    expect(html).toContain('timeout');
  });

  it('renders a placeholder, not "Invalid Date", for a bad artifact timestamp', () => {
    // loadRunArtifact admits an artifact with valid counts but a broken
    // generatedAt (reason-flagged); the page must not print the literal
    // "Invalid Date" toLocaleString produces for it.
    const html = renderDashboard({
      ...BASE,
      suite: {
        available: true,
        data: {
          generatedAt: 'not-a-timestamp',
          total: 10,
          passed: 10,
          failed: 0,
          skipped: 0,
        },
        reason: 'artifact has no valid timestamp',
      },
    });
    expect(html).not.toContain('Invalid Date');
    expect(html).toContain('unknown time');
  });

  it('warns when an offline artifact is past the freshness bar', () => {
    const html = renderDashboard({
      ...BASE,
      suite: {
        available: true,
        ageDays: 12,
        stale: true,
        data: {
          generatedAt: '2026-07-25T17:00:00.000Z',
          total: 800,
          passed: 800,
          failed: 0,
          skipped: 0,
        },
      },
    });
    expect(html).toContain('Artifact is 12 days old');
    expect(html).toContain('Re-run before trusting it');
  });

  it('labels each layer with its trust tier', () => {
    const html = renderDashboard(BASE);
    expect(html).toContain('>self-reported<');
    expect(html).toContain('>ground-truth<');
    expect(html).toContain('>judge<');
  });

  it('omits the calibration section when the layers are not comparable', () => {
    expect(renderDashboard(BASE)).not.toContain('Overclaim gap');
  });

  it('renders a large negative calibration gap as healthy, not overclaiming', () => {
    // Underconfidence (judge clears more than the agent claims) must never
    // amber/red the gap tile — only positive gaps are overclaiming.
    const html = renderDashboard({
      ...BASE,
      calibration: {
        selfHighConfidenceRate: 0.4,
        judgeCleanRate: 0.95,
        gap: -0.55,
        note: 'population comparison',
      },
    });
    expect(html).toContain('Overclaim gap');
    expect(html).toContain('agent no more sure than judge');
    expect(html).toMatch(
      /<div class="tile good">\s*<div class="tile-label">Overclaim gap<\/div>/,
    );
  });
});
