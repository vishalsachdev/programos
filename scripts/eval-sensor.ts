#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  DEFAULT_SENSOR_MODEL,
  evaluateBehaviourReply,
  type SensorVerdict,
} from '../src/behaviour-sensor.js';
import { RepoReader } from '../src/repo-reader.js';
import { writeArtifactFile } from './safe-artifact.mjs';
import {
  extractReplayReply,
  readReplaySource,
  selectReplayCases,
  scoreReplayCase,
} from '../src/sensor-replay.js';

interface ReplayCase {
  id: string;
  allowed: SensorVerdict[];
  rationale: string;
  requestContext?: string;
  asOfDate?: string;
  reply?: string;
  sourceFile?: string;
  heading?: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CASES = path.join(
  ROOT,
  'evals',
  'behaviour-sensor',
  'expected.jsonl',
);

function args() {
  const { values } = parseArgs({
    options: {
      mirror: { type: 'string' },
      cases: { type: 'string' },
      out: { type: 'string' },
      case: { type: 'string' },
      refresh: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  return values;
}

function loadCases(file: string): ReplayCase[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ReplayCase);
}

function resolveReply(testCase: ReplayCase, reader: RepoReader): string {
  if (testCase.reply) return testCase.reply;
  if (!testCase.sourceFile || !testCase.heading) {
    throw new Error('case needs reply or sourceFile+heading');
  }
  const source = readReplaySource(testCase.sourceFile, (file) =>
    reader.readFile(file),
  );
  return extractReplayReply(source, testCase.heading);
}

async function main(): Promise<void> {
  const options = args();
  if (options.help) {
    console.log(
      'Usage: npm run eval:sensor -- --mirror <git-dir> [--refresh] [--cases <jsonl>] [--case <id,id>] [--out <json>]',
    );
    return;
  }
  const mirror =
    options.mirror ||
    process.env.PROGRAM_READ_MIRROR ||
    '/srv/repos/program-repo-read.git';
  const casesFile = path.resolve(options.cases || DEFAULT_CASES);
  const out = path.resolve(
    options.out || 'store/eval-runs/sensor-replay-latest.json',
  );
  const reader = new RepoReader(mirror);
  if (!reader.init()) throw new Error(`cannot initialize KB reader: ${mirror}`);
  if (options.refresh) reader.refresh({ force: true });
  const pinnedSha = reader.currentSha;
  if (!pinnedSha) throw new Error('KB reader has no pinned revision');

  const selectedIds = options.case
    ?.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const cases = selectReplayCases(loadCases(casesFile), selectedIds);
  const results = [];
  for (const testCase of cases) {
    const verdicts: SensorVerdict[] = [];
    const annotations: string[] = [];
    let reply: string;
    try {
      reply = resolveReply(testCase, reader);
    } catch (error) {
      verdicts.push('error', 'error', 'error');
      annotations.push(
        '[sensor: error: replay-source]',
        '[sensor: error: replay-source]',
        '[sensor: error: replay-source]',
      );
      const score = scoreReplayCase(testCase.allowed, verdicts);
      results.push({
        id: testCase.id,
        allowed: testCase.allowed,
        verdicts,
        annotations,
        ...score,
        rationale: testCase.rationale,
        asOfDate: testCase.asOfDate,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (let run = 0; run < 3; run++) {
      try {
        const result = await evaluateBehaviourReply(reply, reader, {
          requestContext: testCase.requestContext,
          asOfDate: testCase.asOfDate,
          refresh: false,
        });
        verdicts.push(result.verdict);
        annotations.push(result.annotation);
      } catch (error) {
        verdicts.push('error');
        annotations.push(
          `[sensor: error: ${error instanceof Error ? error.message : String(error)}]`,
        );
        console.error(
          `${testCase.id} run ${run + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const score = scoreReplayCase(testCase.allowed, verdicts);
    results.push({
      id: testCase.id,
      allowed: testCase.allowed,
      verdicts,
      annotations,
      ...score,
      rationale: testCase.rationale,
      asOfDate: testCase.asOfDate,
    });
    console.log(
      `${score.passed ? 'PASS' : 'FAIL'} ${testCase.id}: ${verdicts.join(', ')} (allowed: ${testCase.allowed.join('|')})`,
    );
    if (!score.passed) {
      annotations.forEach((annotation, index) =>
        console.log(`  run ${index + 1}: ${annotation}`),
      );
    }
  }

  const failed = results.filter((result) => !result.passed).length;
  const artifact = {
    generatedAt: new Date().toISOString(),
    suite: 'behaviour-sensor/historical-replay',
    policy: 'three runs per case; at least two allowed verdicts required',
    model: process.env.SENSOR_MODEL || DEFAULT_SENSOR_MODEL,
    pinnedKbSha: pinnedSha,
    total: results.length,
    passed: results.length - failed,
    failed,
    skipped: 0,
    cases: results,
  };
  writeArtifactFile(out, JSON.stringify(artifact, null, 2));
  console.log(`\n${artifact.passed}/${artifact.total} cases pass → ${out}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
