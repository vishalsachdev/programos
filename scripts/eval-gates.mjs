#!/usr/bin/env node
/**
 * Golden-set runner for the KB entry gate — the deterministic leg.
 *
 * `container/skills/kb-entry-gate/evals/golden.jsonl` has existed since G37 v2
 * (cases were written before the skill prompt, deliberately) but nothing ever
 * executed it: every reported number came from a hand-run. This runs the leg
 * that can be run without a model in the loop.
 *
 * WHAT THIS MEASURES — evidence recall, not verdict accuracy.
 *   The gate is two stages: a deterministic pre-filter (check-kb-entry.mjs)
 *   that over-generates candidate KB lines, then an Opus-tier subagent that
 *   reads those candidates and returns block / hold / allow. The subagent can
 *   only be right if the pre-filter put the relevant evidence in front of it.
 *   So for each `block`/`hold` case we assert the labelled `evidence_file`
 *   appears among the emitted candidates. That is a hard necessary condition
 *   for the case to be winnable, it is fully deterministic, and it is where
 *   the measured v1 misses actually lived.
 *
 *   `allow` cases are scored differently and deliberately loosely: the
 *   pre-filter is SUPPOSED to over-generate, so surfacing candidates for a
 *   case that should ultimately be allowed is correct behaviour, not a miss.
 *   They are recorded as `informational` and excluded from the pass count.
 *
 * WHAT THIS DOES NOT MEASURE — the semantic verdict. That needs the subagent,
 * a container, and subscription auth; it stays a manual pre-deploy step (see
 * docs/evaluation-protocol.md §"The semantic leg"). The artifact records the
 * distinction so the dashboard can never imply the gate is fully covered.
 *
 * Usage: node scripts/eval-gates.mjs [--kb-root <path>] [--out <file>]
 * Exit 0 when every scorable case passes or the run is honestly skipped;
 * exit 1 on a real recall miss, so CI can gate on it once the KB is reachable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { writeArtifactFile } from './safe-artifact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(
  ROOT,
  'container/skills/kb-entry-gate/evals/golden.jsonl',
);
const CHECKER = path.join(
  ROOT,
  'container/skills/kb-entry-gate/check-kb-entry.mjs',
);

function cliArgs() {
  const { values } = parseArgs({
    options: {
      'kb-root': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return { kbRoot: values['kb-root'], out: values.out, help: values.help };
}

function resolveKbRoot(explicit) {
  // Env var + VPS default duplicate src/program-repo.ts (getProgramRepoPath),
  // which this plain-node script cannot import. If the host default path ever
  // moves, update both.
  const candidates = [
    explicit,
    process.env.PROGRAM_REPO,
    '/workspace/extra/program-repo',
    '/srv/program-repo',
    path.resolve(ROOT, '../program-repo'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'discussions', 'ACTION_ITEMS.md'))) return c;
  }
  return null;
}

function writeArtifact(out, artifact) {
  writeArtifactFile(out, JSON.stringify(artifact, null, 2));
  console.log(`\nArtifact → ${out}`);
}

function main() {
  let args;
  try {
    args = cliArgs();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (args.help) {
    console.log('Usage: node scripts/eval-gates.mjs [--kb-root <path>] [--out <file>]');
    process.exit(0);
  }

  // cwd-relative to match the reader's STORE_DIR convention (config.ts
  // resolves from process.cwd()); npm run always sets cwd to the repo root.
  const out = args.out || path.resolve('store/eval-runs/gates-latest.json');
  // Shared across the skip and scoring branches so the artifact schema
  // cannot silently diverge between them.
  const artifactBase = {
    generatedAt: new Date().toISOString(),
    suite: 'kb-entry-gate/golden',
    leg: 'deterministic-prefilter',
    semanticLegRun: false,
    semanticLegNote:
      'Verdict accuracy (block/hold/allow) requires the kb-gate-reviewer subagent and is not covered by this run.',
  };

  const cases = fs
    .readFileSync(GOLDEN, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const kbRoot = resolveKbRoot(args.kbRoot);
  if (!kbRoot) {
    // A missing KB is a skip, never a pass. The artifact says so out loud and
    // the dashboard renders the reason instead of a green tile.
    const artifact = {
      ...artifactBase,
      total: cases.length,
      passed: 0,
      failed: 0,
      skipped: cases.length,
      skipReason:
        'program-repo checkout not found — set PROGRAM_REPO or pass --kb-root',
      cases: cases.map((c) => ({ id: c.id, status: 'skip', scored: false })),
    };
    console.error(`SKIP: ${artifact.skipReason}`);
    writeArtifact(out, artifact);
    process.exit(0);
  }

  console.log(`KB root: ${kbRoot}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-gates-'));
  const results = [];

  for (const c of cases) {
    const proposedFile = path.join(tmp, `${c.id}.md`);
    fs.writeFileSync(proposedFile, c.proposal);

    // Both tracking files are passed as --current so cross-file twins (the
    // measured v1 miss class) are reachable; the checker treats the first as
    // the append target, so it goes first.
    const other =
      c.target === 'OPEN_QUESTIONS.md' ? 'ACTION_ITEMS.md' : 'OPEN_QUESTIONS.md';
    const currents = [c.target, other];

    let parsed;
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          CHECKER,
          ...currents.flatMap((f) => [
            '--current',
            path.join(kbRoot, 'discussions', f),
          ]),
          '--proposed', proposedFile,
          '--kb-root', kbRoot,
          '--emit-candidates',
        ],
        { encoding: 'utf-8' },
      );
      parsed = JSON.parse(stdout);
    } catch (err) {
      // The checker exits non-zero when it blocks — that is a verdict, not a
      // crash, and stdout still holds the JSON.
      const stdout = err.stdout;
      try {
        parsed = JSON.parse(stdout);
      } catch (_parseErr) {
        results.push({
          id: c.id,
          status: 'error',
          detail: `checker produced no parseable output: ${String(err.message).slice(0, 160)}`,
        });
        continue;
      }
    }

    const expected = c.expected || {};
    if (expected.verdict === 'allow') {
      results.push({
        id: c.id,
        status: 'informational',
        scored: false,
        detail: 'allow case — pre-filter over-generation is expected; verdict needs the semantic leg',
      });
      continue;
    }

    const surfaced = new Set([
      ...(parsed.candidates?.kbSnippets ?? []).map((s) => s.file),
      ...(parsed.candidates?.trackingTwins ?? []).map(
        (s) => s.file ?? s.path ?? '',
      ),
    ]);
    // Golden labels are repo-relative ('discussions/ACTION_ITEMS.md'); the
    // checker emits the same shape for kbSnippets, but tracking twins may
    // carry the absolute --current path, so compare on basename too.
    const want = expected.evidence_file || '';
    const wantBase = path.basename(want);
    const hit = [...surfaced].some(
      (f) => f === want || path.basename(f) === wantBase,
    );

    results.push({
      id: c.id,
      status: hit ? 'pass' : 'fail',
      detail: hit
        ? `evidence surfaced: ${want}`
        : `expected evidence ${want} not among ${surfaced.size} candidate file(s): ${[...surfaced].slice(0, 5).join(', ') || 'none'}`,
    });
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter(
    (r) => r.status === 'fail' || r.status === 'error',
  ).length;
  const informational = results.filter(
    (r) => r.status === 'informational',
  ).length;

  for (const r of results) {
    const mark =
      r.status === 'pass' ? 'PASS' : r.status === 'informational' ? 'INFO' : 'FAIL';
    console.log(`${mark}  ${r.id}${r.status === 'pass' ? '' : ` — ${r.detail}`}`);
  }
  console.log(
    `\n${passed}/${passed + failed} scorable cases pass ` +
      `(${informational} allow-cases informational, semantic leg not run).`,
  );

  writeArtifact(out, {
    ...artifactBase,
    kbRoot,
    total: passed + failed,
    passed,
    failed,
    skipped: 0,
    // Allow-cases are not scored by design — their own field, so the
    // dashboard's Skipped tile stays meaningful for genuine skips.
    informational,
    cases: results,
  });

  process.exit(failed > 0 ? 1 : 0);
}

main();
