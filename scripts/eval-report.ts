/**
 * Builds the eval snapshot and writes the dashboard HTML.
 *
 * Run on the VPS (it needs the read mirror and store/evals.db):
 *   npm run eval:report -- --out docs/eval-dashboard.html
 *
 * Reads are all through RepoReader's pinned mirror, same as the sensor and
 * the exceptions digest — never the writable checkout.
 */
import path from 'path';
import { parseArgs } from 'node:util';

import { TIMEZONE } from '../src/config.js';
import { renderDashboard } from '../src/eval-dashboard.js';
import {
  buildEvalSnapshot,
  DEFAULT_WINDOW_DAYS,
  type LayerStatus,
  type RunArtifact,
} from '../src/eval-metrics.js';
import { getRepoReader } from '../src/repo-reader.js';
import { writeArtifactFile } from './safe-artifact.mjs';

const { values: args } = parseArgs({
  options: {
    out: { type: 'string' },
    days: { type: 'string' },
    json: { type: 'boolean' },
  },
});
const days = Number(args.days);
const windowDays =
  Number.isFinite(days) && days > 0 ? days : DEFAULT_WINDOW_DAYS;

const snapshot = buildEvalSnapshot({
  reader: getRepoReader(),
  timeZone: TIMEZONE,
  windowDays,
});

if (args.json) {
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  const out = path.resolve(args.out || 'docs/eval-dashboard.html');
  writeArtifactFile(out, renderDashboard(snapshot));
  console.log(`Dashboard → ${out}`);
  console.log(
    `  sensor: ${snapshot.sensor.available ? `${snapshot.sensor.data.judged} judged, ${snapshot.sensor.data.fail} FAIL` : snapshot.sensor.reason}`,
  );
  console.log(`  gates (offline): ${runLine(snapshot.gates)}`);
  console.log(`  suite: ${runLine(snapshot.suite)}`);
}

/**
 * One-line summary of an offline layer. A skipped run must not print as
 * `0/18` — that reads as a total failure when nothing actually ran, which is
 * the same conflation the dashboard itself is built to avoid.
 */
function runLine(layer: LayerStatus<RunArtifact>): string {
  if (!layer.available) return layer.reason;
  if (layer.data.skipReason) return `skipped — ${layer.data.skipReason}`;
  const stale = layer.stale ? ` (STALE, ${layer.ageDays}d old)` : '';
  return `${layer.data.passed}/${layer.data.total}${stale}`;
}
