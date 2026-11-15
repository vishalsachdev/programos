/**
 * Eval Dashboard — renders an `EvalSnapshot` as one self-contained HTML page.
 *
 * Static file generation, not an HTTP route. Two reasons: the existing
 * governance artifacts are already self-contained files linked from
 * the program-repo site, so this matches a pattern reviewers know; and adding
 * a metrics route to the public web server would put per-reply failure text on
 * a public origin behind nothing but obscurity. A file can be committed to
 * the private repo and shared deliberately.
 *
 * Pure: takes a snapshot, returns a string. No fs, no clock, no network — so
 * the golden-output test is a plain string comparison.
 */
import {
  ARTIFACT_STALE_DAYS,
  LAYER_TRUST,
  type EvalSnapshot,
  type GateMetrics,
  type LayerId,
  type LayerStatus,
  type RunArtifact,
  type SensorMetrics,
} from './eval-metrics.js';
import type { EvalSummary } from './eval-tracker.js';
import { formatLocalTime } from './timezone.js';

/**
 * Thresholds are presentation, not measurement — they live here, not in the
 * aggregator, so changing what counts as "amber" never silently rewrites a
 * recorded number. Rationale for each value is in docs/evaluation-protocol.md.
 */
export const THRESHOLDS = {
  /**
   * Any judged FAIL turns the tile at least amber — there is no acceptable
   * rate, so the amber floor is zero. Red starts above 2% of judged replies.
   */
  sensorFailRate: { amber: 0, red: 0.02 },
  /** Flags are advisory; a persistent flag rate means the prompt needs work. */
  sensorFlagRate: { amber: 0.15, red: 0.3 },
  /** Verdict-less replies. Above 10% the other rates stop meaning much. */
  sensorUnresolvedRate: { amber: 0.05, red: 0.1 },
  /** Self-report overclaiming relative to the judge. */
  calibrationGap: { amber: 0.1, red: 0.25 },
} as const;

/**
 * Case statuses that are not defects, independent of which runner minted
 * them. Runner-specific benign statuses do not belong here — a runner marks
 * those `scored: false` in the artifact instead (see RunArtifact.cases), so
 * new runners need no renderer change. `informational` predates the flag and
 * is kept for artifacts written before it existed. Membership rather than a
 * failure allowlist, so an unrecognised, unmarked status from a future
 * runner surfaces instead of being silently dropped.
 */
const BENIGN_CASE_STATUSES = new Set([
  'pass',
  'passed',
  'skip',
  'skipped',
  'informational',
]);

type Level = 'good' | 'amber' | 'red' | 'unknown';

/** Higher is worse for every metric here, so one comparator covers them all. */
export function levelFor(
  value: number | null,
  t: { amber: number; red: number },
): Level {
  if (value === null) return 'unknown';
  if (value > t.red) return 'red';
  if (value > t.amber) return 'amber';
  return 'good';
}

/**
 * HTML-escape. Deliberately local rather than reusing router.ts's escapeXml:
 * importing it would drag the router's delivery-gate dependency chain into a
 * pure renderer, and hoisting it out of router.ts (upstream NanoClaw code)
 * buys merge friction for a four-line function. The injection test pins this.
 */
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function tile(args: {
  label: string;
  value: string;
  level?: Level;
  sub?: string;
}): string {
  const level = args.level ?? 'unknown';
  return [
    `<div class="tile ${level}">`,
    `<div class="tile-label">${esc(args.label)}</div>`,
    `<div class="tile-value">${esc(args.value)}</div>`,
    args.sub ? `<div class="tile-sub">${esc(args.sub)}</div>` : '',
    `</div>`,
  ].join('');
}

function trustBadge(layer: LayerId): string {
  const t = LAYER_TRUST[layer];
  return `<span class="trust ${t.tier}" title="${esc(t.label)}">${esc(t.tier)}</span>`;
}

/**
 * Human timestamp for an artifact's generatedAt. loadRunArtifact admits an
 * artifact with valid counts but a bad/missing timestamp (with a reason);
 * rendering that value raw would print the literal "Invalid Date".
 */
function artifactStamp(generatedAt: string | undefined, tz: string): string {
  return generatedAt !== undefined && !Number.isNaN(Date.parse(generatedAt))
    ? formatLocalTime(generatedAt, tz)
    : 'unknown time (artifact has no valid timestamp)';
}

/** A layer with no data renders its reason, never a zero. */
function unavailable(reason: string): string {
  return `<p class="absent">No data — ${esc(reason)}.</p>`;
}

function renderSensor(layer: LayerStatus<SensorMetrics>): string {
  if (!layer.available) return unavailable(layer.reason);
  const d = layer.data;

  const tiles = [
    tile({
      label: 'Judged replies',
      value: String(d.judged),
      level: 'good',
      // Skips are the sensor working as designed (empty/internal/lore),
      // but a day of only-skipped traffic must not read as "no traffic".
      sub:
        `${d.daysWithData} day(s) with data` +
        (d.skipped > 0 ? `, ${d.skipped} skipped by design` : ''),
    }),
    tile({
      label: 'FAIL rate',
      value: pct(d.failRate),
      level: levelFor(d.failRate, THRESHOLDS.sensorFailRate),
      sub: `${d.fail} of ${d.judged}`,
    }),
    tile({
      label: 'FLAG rate',
      value: pct(d.flagRate),
      level: levelFor(d.flagRate, THRESHOLDS.sensorFlagRate),
      sub: `${d.flag} of ${d.judged}`,
    }),
    tile({
      label: 'No verdict',
      value: pct(d.unresolvedRate),
      // A disabled sensor is never a green tile, whatever the rate says:
      // judged=0 + disabled>0 must not resemble a quiet week.
      level:
        d.disabled > 0
          ? 'red'
          : levelFor(d.unresolvedRate, THRESHOLDS.sensorUnresolvedRate),
      sub:
        `${d.error} error, ${d.pending} pending` +
        (d.disabled > 0 ? `, SENSOR DISABLED for ${d.disabled}` : ''),
    }),
  ].join('');

  const maxDay = Math.max(
    1,
    ...d.byDay.map((x) => x.pass + x.flag + x.fail + x.error + x.pending),
  );
  const bars = d.byDay
    .map((x) => {
      const total = x.pass + x.flag + x.fail + x.error + x.pending;
      const h = (n: number) => `${Math.round((n / maxDay) * 100)}%`;
      return [
        `<div class="bar" title="${esc(x.date)}: ${x.pass} pass, ${x.flag} flag, ${x.fail} fail, ${x.error + x.pending} unresolved">`,
        `<div class="seg fail" style="height:${h(x.fail)}"></div>`,
        `<div class="seg flag" style="height:${h(x.flag)}"></div>`,
        `<div class="seg unres" style="height:${h(x.error + x.pending)}"></div>`,
        `<div class="seg pass" style="height:${h(x.pass)}"></div>`,
        `<div class="bar-label">${esc(x.date.slice(5))}</div>`,
        total === 0 ? '<div class="bar-zero">·</div>' : '',
        `</div>`,
      ].join('');
    })
    .join('');

  const failList = d.topFailures.length
    ? `<h4>FAIL verdicts</h4><ul class="verdicts fail">${d.topFailures.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';
  const flagList = d.topFlags.length
    ? `<h4>FLAG verdicts</h4><ul class="verdicts flag">${d.topFlags.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';

  return [
    `<div class="tiles">${tiles}</div>`,
    `<div class="chart"><div class="bars">${bars}</div>`,
    `<div class="legend"><span class="k pass"></span>pass <span class="k flag"></span>flag <span class="k fail"></span>fail <span class="k unres"></span>no verdict</div></div>`,
    failList,
    flagList,
  ].join('\n');
}

function renderRun(
  layer: LayerStatus<RunArtifact>,
  timeZone: string,
  /** Plain text — it renders through esc(), so markup shows literally. */
  emptyHint: string,
): string {
  if (!layer.available) {
    return unavailable(`${layer.reason} — ${emptyHint}`);
  }
  const d = layer.data;

  if (d.skipReason) {
    return [
      `<p class="absent">Run did not execute — ${esc(d.skipReason)}.</p>`,
      `<p class="meta">Artifact written ${esc(artifactStamp(d.generatedAt, timeZone))}.</p>`,
    ].join('\n');
  }

  const passRate = d.total > 0 ? d.passed / d.total : null;
  const failLevel: Level = d.failed > 0 ? 'red' : 'good';
  const staleNote = layer.stale
    ? `<p class="warn">Artifact is ${layer.ageDays} days old — older than the ${ARTIFACT_STALE_DAYS}-day freshness bar. Re-run before trusting it.</p>`
    : '';

  // A case is listed as failing unless its runner excluded it from scoring
  // (`scored: false`) or its status is a universally benign word.
  const failed = (d.cases ?? []).filter(
    (c) => c.scored !== false && !BENIGN_CASE_STATUSES.has(c.status),
  );
  const failList = failed.length
    ? `<h4>Failing cases</h4><ul class="verdicts fail">${failed
        .map(
          (c) =>
            `<li><code>${esc(c.id)}</code> — ${esc(c.status)}${c.detail ? `: ${esc(c.detail)}` : ''}</li>`,
        )
        .join('')}</ul>`
    : '';

  return [
    staleNote,
    `<div class="tiles">`,
    tile({
      label: 'Cases passing',
      value: `${d.passed}/${d.total}`,
      level: failLevel,
      sub: pct(passRate),
    }),
    tile({
      label: 'Failing',
      value: String(d.failed),
      level: failLevel,
    }),
    tile({
      label: 'Skipped',
      value: String(d.skipped),
      level: d.skipped > 0 ? 'amber' : 'good',
    }),
    ...(d.informational
      ? [
          tile({
            label: 'Informational',
            value: String(d.informational),
            level: 'good',
            sub: 'not scored by design',
          }),
        ]
      : []),
    tile({
      label: 'Last run',
      value: layer.ageDays === undefined ? '—' : `${layer.ageDays}d ago`,
      level: layer.stale ? 'amber' : 'good',
      sub: artifactStamp(d.generatedAt, timeZone),
    }),
    `</div>`,
    failList,
  ].join('\n');
}

function renderSelfReport(layer: LayerStatus<EvalSummary>): string {
  if (!layer.available) return unavailable(layer.reason);
  const d = layer.data;

  const dist = (obj: Record<string, number>) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([k, v]) =>
          `<li><span>${esc(k)}</span><span>${v} (${Math.round((v / d.total) * 100)}%)</span></li>`,
      )
      .join('');

  return [
    `<div class="tiles">`,
    tile({ label: 'Responses self-scored', value: String(d.total) }),
    tile({
      label: 'Self-reported citation rate',
      value: pct(d.citation_rate),
      sub: 'claim, not verification',
    }),
    tile({
      label: 'Avg response length',
      value: `${d.avg_response_length} ch`,
    }),
    tile({
      label: 'Low-confidence replies',
      value: String(d.low_confidence_entries.length),
      level: d.low_confidence_entries.length > 0 ? 'amber' : 'good',
    }),
    `</div>`,
    `<div class="cols">`,
    `<div><h4>Confidence</h4><ul class="dist">${dist(d.by_confidence)}</ul></div>`,
    `<div><h4>Category</h4><ul class="dist">${dist(d.by_category)}</ul></div>`,
    `<div><h4>Channel</h4><ul class="dist">${dist(d.by_channel)}</ul></div>`,
    `</div>`,
    d.top_topics.length
      ? `<h4>Topics</h4><p class="topics">${d.top_topics.map((t) => `<span class="chip">${esc(t.topic)} <b>${t.count}</b></span>`).join(' ')}</p>`
      : '',
  ].join('\n');
}

function renderGates(g: GateMetrics): string {
  if (!g.runs) {
    return `<p class="absent">No <code>[GATE RESULT]</code> entries in this window — either no KB writes were attempted, or gate-result logging (G51) is not reaching the audit log.</p>`;
  }
  return [
    `<div class="tiles">`,
    tile({ label: 'Gate runs', value: String(g.runs) }),
    tile({
      label: 'Clean',
      value: String(g.clean),
      level: 'good',
      sub: pct(g.clean / g.runs),
    }),
    tile({
      label: 'Blocked',
      value: String(g.blocked),
      level: g.blocked > 0 ? 'amber' : 'good',
      sub: 'gate did its job',
    }),
    tile({
      label: 'Held / errored',
      value: String(g.hold + g.error),
      level: g.error > 0 ? 'red' : g.hold > 0 ? 'amber' : 'good',
    }),
    `</div>`,
    g.byGate.length
      ? `<ul class="dist">${g.byGate.map((x) => `<li><span><code>${esc(x.gate)}</code></span><span>${x.clean}/${x.runs} clean</span></li>`).join('')}</ul>`
      : '',
  ].join('\n');
}

function renderCalibration(cal: EvalSnapshot['calibration']): string {
  // Only a POSITIVE gap (self-rated confidence above the judge's clear
  // rate) is overclaiming; a negative gap is healthy underconfidence and
  // must not render amber/red.
  const calLevel = levelFor(
    cal.gap === null ? null : Math.max(0, cal.gap),
    THRESHOLDS.calibrationGap,
  );
  return [
    `<div class="tiles">`,
    tile({
      label: 'Self-rated high confidence',
      value: pct(cal.selfHighConfidenceRate),
    }),
    tile({
      label: 'Judge cleared (PASS)',
      value: pct(cal.judgeCleanRate),
    }),
    tile({
      label: 'Overclaim gap',
      value: cal.gap === null ? '—' : `${(cal.gap * 100).toFixed(1)} pts`,
      level: calLevel,
      sub:
        cal.gap !== null && cal.gap > 0
          ? 'agent more sure than judge'
          : 'agent no more sure than judge',
    }),
    `</div>`,
  ].join('\n');
}

function renderSection(args: {
  id: string;
  title: string;
  /** Omitted for sections that aggregate counters rather than a layer. */
  layer?: LayerId;
  blurb: string;
  body: string;
}): string {
  const badge = args.layer ? ` ${trustBadge(args.layer)}` : '';
  return [
    `<section id="${esc(args.id)}">`,
    `<h2>${esc(args.title)}${badge}</h2>`,
    `<p class="blurb">${args.blurb}</p>`,
    args.body,
    `</section>`,
  ].join('\n');
}

const CSS = `
:root { color-scheme: light dark; --bg:#fff; --fg:#16130f; --muted:#6b6560; --line:#e5e0d8;
  --card:#faf9f7; --good:#2f7d4f; --amber:#b8730a; --red:#b3261e; --accent:#13343b; }
@media (prefers-color-scheme: dark) { :root { --bg:#14120f; --fg:#f2efe9; --muted:#a49e96;
  --line:#2e2a25; --card:#1c1917; --good:#66c28c; --amber:#e5a83c; --red:#f08a80; --accent:#9fd0d8; } }
:root[data-theme="dark"] { --bg:#14120f; --fg:#f2efe9; --muted:#a49e96; --line:#2e2a25;
  --card:#1c1917; --good:#66c28c; --amber:#e5a83c; --red:#f08a80; --accent:#9fd0d8; }
:root[data-theme="light"] { --bg:#fff; --fg:#16130f; --muted:#6b6560; --line:#e5e0d8;
  --card:#faf9f7; --good:#2f7d4f; --amber:#b8730a; --red:#b3261e; --accent:#13343b; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:1000px; margin:0 auto; padding:2rem 1.25rem 4rem; }
h1 { font-size:1.6rem; margin:0 0 .25rem; letter-spacing:-.01em; }
h2 { font-size:1.15rem; margin:0 0 .4rem; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
h4 { font-size:.85rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:1.25rem 0 .4rem; }
section { border-top:1px solid var(--line); padding-top:1.5rem; margin-top:1.75rem; }
.sub { color:var(--muted); margin:0 0 1.5rem; font-size:.9rem; }
.blurb { color:var(--muted); font-size:.9rem; margin:0 0 1rem; max-width:70ch; }
.tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:.75rem; }
.tile { background:var(--card); border:1px solid var(--line); border-left-width:3px; border-radius:8px; padding:.75rem .85rem; }
.tile.good { border-left-color:var(--good); } .tile.amber { border-left-color:var(--amber); }
.tile.red { border-left-color:var(--red); } .tile.unknown { border-left-color:var(--line); }
.tile-label { font-size:.72rem; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
.tile-value { font-size:1.5rem; font-weight:600; font-variant-numeric:tabular-nums; margin:.15rem 0; }
.tile-sub { font-size:.78rem; color:var(--muted); }
.trust { font-size:.65rem; text-transform:uppercase; letter-spacing:.07em; padding:.15rem .45rem;
  border-radius:99px; border:1px solid var(--line); color:var(--muted); font-weight:600; }
.trust.ground-truth { color:var(--good); border-color:var(--good); }
.trust.judge { color:var(--accent); border-color:var(--accent); }
.trust.self-reported { color:var(--amber); border-color:var(--amber); }
.chart { margin-top:1.25rem; overflow-x:auto; }
.bars { display:flex; gap:.5rem; align-items:flex-end; height:120px; min-width:min-content; }
.bar { display:flex; flex-direction:column-reverse; justify-content:flex-start; width:44px; height:100%; position:relative; }
.seg { width:100%; }
.seg.pass { background:var(--good); } .seg.flag { background:var(--amber); }
.seg.fail { background:var(--red); } .seg.unres { background:var(--muted); opacity:.45; }
.bar-label { position:absolute; bottom:-1.4rem; left:0; right:0; text-align:center; font-size:.7rem; color:var(--muted); }
.bar-zero { position:absolute; bottom:0; left:0; right:0; text-align:center; color:var(--muted); }
.legend { margin-top:2rem; font-size:.8rem; color:var(--muted); display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; }
.k { width:10px; height:10px; border-radius:2px; display:inline-block; }
.k.pass{background:var(--good)} .k.flag{background:var(--amber)} .k.fail{background:var(--red)} .k.unres{background:var(--muted);opacity:.45}
ul.verdicts { list-style:none; padding:0; margin:0; font-size:.85rem; }
ul.verdicts li { padding:.4rem .6rem; border-left:3px solid var(--line); background:var(--card); margin-bottom:.3rem; border-radius:0 5px 5px 0; }
ul.verdicts.fail li { border-left-color:var(--red); } ul.verdicts.flag li { border-left-color:var(--amber); }
ul.dist { list-style:none; padding:0; margin:0; font-size:.88rem; }
ul.dist li { display:flex; justify-content:space-between; gap:1rem; padding:.3rem 0; border-bottom:1px solid var(--line); }
.cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:1.5rem; margin-top:.5rem; }
.absent { color:var(--muted); font-size:.9rem; background:var(--card); border:1px dashed var(--line); border-radius:8px; padding:.85rem; }
.warn { color:var(--amber); font-size:.88rem; }
.meta { color:var(--muted); font-size:.8rem; }
.chip { display:inline-block; background:var(--card); border:1px solid var(--line); border-radius:99px; padding:.15rem .55rem; font-size:.8rem; margin:0 .25rem .35rem 0; }
code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em; }
footer { margin-top:3rem; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:.8rem; }
`;

/** Render the whole page. Self-contained: no external CSS, JS, or fonts. */
export function renderDashboard(snapshot: EvalSnapshot): string {
  const w = snapshot.window;
  const cal = snapshot.calibration;
  const tz = w.timeZone;

  const sections = [
    renderSection({
      id: 'sensor',
      title: 'Online — behaviour sensor',
      layer: 'sensor',
      blurb:
        'Every outbound reply is re-read by a separate skeptical model against the pinned repo mirror. FAIL means a factual contradiction or a dead citation shipped. This is the closest thing to a live correctness signal, but it is an LLM judging an LLM — a clean rate here is evidence, not proof.',
      body: renderSensor(snapshot.sensor),
    }),
    renderSection({
      id: 'gates',
      title: 'Online — KB write gates',
      layer: 'gateResults',
      blurb:
        'The pre-commit gates that stand between the agent and the knowledge base. A high block count is not a failure — it is the gate working. A high <em>error</em> count is, because an errored gate is an ungated write.',
      body: renderGates(snapshot.gateMetrics),
    }),
    renderSection({
      id: 'gates-offline',
      title: 'Offline — golden gate set',
      layer: 'gates',
      blurb:
        'The 18 hand-labelled KB-gate cases in <code>container/skills/kb-entry-gate/evals/golden.jsonl</code>, replayed against the real knowledge base. Seven are allow cases that must pass through untouched (two of them adversarial traps) — they catch a gate that has learned to block everything.',
      body: renderRun(snapshot.gates, tz, 'run `npm run eval:gates`'),
    }),
    renderSection({
      id: 'suite',
      title: 'Offline — capability scenarios & unit suite',
      layer: 'suite',
      blurb:
        'The hermetic flow scenarios in <code>src/capability-scenarios.test.ts</code> plus every unit test. Deterministic pass/fail, no model in the loop, no network.',
      body: renderRun(snapshot.suite, tz, 'run `npm run eval:suite`'),
    }),
    renderSection({
      id: 'self',
      title: 'Online — agent self-report',
      layer: 'selfReport',
      blurb:
        'What Coordinator said about its own replies in its <code>&lt;eval&gt;</code> blocks. Treat as telemetry about coverage and topic mix, never as a quality measurement: nothing here is verified against anything.',
      body: renderSelfReport(snapshot.selfReport),
    }),
    cal.gap !== null
      ? renderSection({
          id: 'calibration',
          title: 'Derived — self-report calibration',
          layer: 'selfReport',
          blurb: esc(cal.note),
          body: renderCalibration(cal),
        })
      : '',
    renderSection({
      id: 'delivery',
      title: 'Delivery counters',
      blurb:
        'Context for the rates above — a low FAIL count means little if almost nothing went out.',
      body: [
        `<div class="tiles">`,
        tile({
          label: 'Outbound emails',
          value: String(snapshot.delivery.outboundEmails),
        }),
        tile({
          label: 'Delivery problems',
          value: String(snapshot.delivery.deliveryProblems),
          level: snapshot.delivery.deliveryProblems > 0 ? 'amber' : 'good',
          sub: 'bounce / complaint',
        }),
        tile({
          label: 'Cc-context suppressions',
          value: String(snapshot.delivery.ccSuppressions),
          sub: 'acks deliberately withheld (G56)',
        }),
        `</div>`,
      ].join('\n'),
    }),
  ]
    .filter(Boolean)
    .join('\n\n');

  // Full document shell: without <meta charset>, a server that omits the
  // charset header (python http.server, plain nginx location) makes Chrome
  // fall back to windows-1252 and every em-dash renders as mojibake; without
  // the viewport meta the page renders desktop-scaled on phones.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coordinator Evaluation Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<h1>Coordinator Evaluation Dashboard</h1>
<p class="sub">Window ${esc(w.from)} → ${esc(w.to)} (${w.days} days, ${esc(tz)}) · generated ${esc(formatLocalTime(snapshot.generatedAt, tz))}<br>
Protocol: <code>docs/evaluation-protocol.md</code>. Layers are not equally trustworthy — read the badge on each heading.</p>

${sections}

<footer>
Generated by <code>npm run eval:report</code> from <code>src/eval-metrics.ts</code>.
Missing sections mean the layer produced no data in this window — never a silent zero.
</footer>
</div>
</body>
</html>`;
}
