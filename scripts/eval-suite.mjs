#!/usr/bin/env node
/**
 * Runs the full vitest suite and distils its JSON report into the same
 * `RunArtifact` shape the dashboard reads for every offline layer.
 *
 * Why not point the dashboard at vitest's own JSON: that format is large,
 * version-coupled, and holds full stack traces for every failure. The
 * dashboard needs four numbers and the ids of what broke.
 *
 * Exit code mirrors vitest's, so this is safe to use as the CI command.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { writeArtifactFile } from './safe-artifact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// cwd-relative to match the reader's STORE_DIR convention (config.ts resolves
// from process.cwd()); npm run always sets cwd to the repo root.
const OUT = path.resolve('store/eval-runs/suite-latest.json');

// Temp dir is removed on every exit path below — this runs per push, so a
// leaked directory per run would slowly fill /tmp on the VPS.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-suite-'));
const raw = path.join(tmpDir, 'vitest.json');
process.on('exit', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const run = spawnSync(
  'npx',
  ['vitest', 'run', '--reporter=json', `--outputFile=${raw}`],
  { cwd: ROOT, stdio: 'inherit', encoding: 'utf-8' },
);

const generatedAt = new Date().toISOString();

// A spawn that never ran (npx missing, ENOENT) leaves run.status null;
// trusting whatever landed at the report path would publish metrics from
// an execution that did not happen.
if (run.error || run.status === null) {
  writeArtifactFile(
    OUT,
    JSON.stringify(
      {
        generatedAt,
        suite: 'vitest',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        skipReason: `vitest process failed to run (${run.error?.code ?? 'no exit status'})`,
      },
      null,
      2,
    ),
  );
  console.error(
    `eval-suite: vitest failed to launch: ${run.error ?? 'no exit status'}`,
  );
  process.exit(1);
}

let report = null;
try {
  report = JSON.parse(fs.readFileSync(raw, 'utf-8'));
} catch (err) {
  // No parseable report means we cannot claim anything about the suite.
  writeArtifactFile(
    OUT,
    JSON.stringify(
      {
        generatedAt,
        suite: 'vitest',
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        skipReason: `vitest produced no readable JSON report (${err.code ?? 'parse error'}); exit ${run.status}`,
      },
      null,
      2,
    ),
  );
  process.exit(run.status ?? 1);
}

const tests = (report.testResults ?? []).flatMap((f) =>
  (f.assertionResults ?? []).map((a) => ({
    id: a.fullName || a.title,
    status: a.status,
    detail: (a.failureMessages ?? [])[0]?.split('\n')[0],
  })),
);

const artifact = {
  generatedAt,
  suite: 'vitest',
  total: report.numTotalTests ?? tests.length,
  passed:
    report.numPassedTests ?? tests.filter((t) => t.status === 'passed').length,
  failed:
    report.numFailedTests ?? tests.filter((t) => t.status === 'failed').length,
  skipped: report.numPendingTests ?? 0,
  // Only failures are carried through — several hundred passing ids would
  // bloat the artifact without telling anyone anything.
  cases: tests
    .filter((t) => t.status === 'failed')
    .map((t) => ({ id: t.id, status: 'fail', detail: t.detail })),
  // Scenario coverage is called out separately: it is the layer that asserts
  // whole flows rather than single units (docs/capability-scenarios.md).
  scenarioCases: tests.filter((t) => /\bS\d\d\b/.test(t.id)).length,
};

writeArtifactFile(OUT, JSON.stringify(artifact, null, 2));
console.log(
  `\n${artifact.passed}/${artifact.total} tests pass (${artifact.scenarioCases} capability scenarios) → ${OUT}`,
);

// A null status means vitest was killed by a signal — that is a failed run,
// not a success (same posture as the no-report path above).
process.exit(run.status ?? 1);
