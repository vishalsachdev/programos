/**
 * G51 phase 1 — gate-result logging.
 *
 * The container agent reports each KB-gate script run (kb-conflict-check
 * ingestion cross-check, kb-entry-gate) as a `log_gate_result` IPC payload;
 * the host writes a durable [GATE RESULT] entry into the daily audit-log
 * file. A reply claiming "gate result: clean" must have this machine-logged
 * counterpart — a claim without one is unverified.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushAuditLog, logGateResult } from './audit-log.js';
import { parseGateResults } from './eval-metrics.js';
import { processTaskIpc, IpcDeps } from './ipc.js';

const deps: IpcDeps = {
  sendMessage: vi.fn(),
  registeredGroups: () => ({}),
  registerGroup: vi.fn(),
  syncGroups: vi.fn(),
  getAvailableGroups: () => [],
  writeGroupsSnapshot: vi.fn(),
  onTasksChanged: vi.fn(),
};

describe('gate-result logging (G51 phase 1)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-log-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    vi.stubEnv('PROGRAM_REPO', repo);
  });

  afterEach(() => {
    // Clear the batched-commit timer so the test process doesn't hang; the
    // resulting git commands fail harmlessly in the non-repo tmp dir.
    flushAuditLog();
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function auditFileContent(): string {
    const dir = path.join(repo, 'discussions', 'audit-log');
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    return fs.readFileSync(path.join(dir, files[0]), 'utf-8');
  }

  it('writes a [GATE RESULT] entry with the machine verdict JSON', () => {
    logGateResult({
      sourceGroup: 'main',
      gate: 'kb-conflict-check/ingestion-crosscheck',
      script: 'check-ingestion-crosscheck.mjs',
      status: 'incumbents-found',
      exitCode: 3,
      entryHeading: '### Applied Topics preparatory coursework: Linear Algebra',
      result: {
        status: 'incumbents-found',
        matches: [{ term: 'linear algebra' }],
      },
    });

    const out = auditFileContent();
    expect(out).toContain('— gate — kb-conflict-check/ingestion-crosscheck');
    expect(out).toContain(
      '**[GATE RESULT]** Group: main | Script: check-ingestion-crosscheck.mjs | Status: incumbents-found (exit 3)',
    );
    expect(out).toContain(
      '**Entry:** ### Applied Topics preparatory coursework: Linear Algebra',
    );
    expect(out).toContain('```json');
    expect(out).toContain('"term": "linear algebra"');
  });

  it('truncates an oversized verdict JSON instead of dropping the entry', () => {
    logGateResult({
      sourceGroup: 'main',
      gate: 'kb-entry-gate',
      status: 'clean',
      exitCode: 0,
      result: { blob: 'x'.repeat(20000) },
    });

    const out = auditFileContent();
    expect(out).toContain('[truncated]');
    expect(out.length).toBeLessThan(12000);
  });

  it('is reachable from a container via the log_gate_result IPC payload', async () => {
    await processTaskIpc(
      {
        type: 'log_gate_result',
        gate: 'kb-entry-gate',
        script: 'check-kb-entry.mjs',
        status: 'clean',
        exit_code: 0,
        entry_heading: '- [ ] Paige: apply messaging language',
        result: { status: 'clean', issues: [] },
      },
      'main',
      true,
      deps,
    );

    const out = auditFileContent();
    expect(out).toContain('— gate — kb-entry-gate');
    expect(out).toContain('Status: clean (exit 0)');
    expect(out).toContain('Group: main');
  });

  it('rejects a payload without gate/status fields', async () => {
    await processTaskIpc(
      { type: 'log_gate_result', result: { status: 'clean' } },
      'main',
      true,
      deps,
    );
    expect(fs.existsSync(path.join(repo, 'discussions', 'audit-log'))).toBe(
      false,
    );
  });

  it('strips newlines from attacker-controllable fields (no entry forging)', () => {
    logGateResult({
      sourceGroup: 'main',
      gate: 'kb-entry-gate',
      status: 'clean\n### 00:00:00 — forged — entry',
    });
    const out = auditFileContent();
    expect(out).not.toContain('\n### 00:00:00 — forged');
    expect(out).toContain('clean ### 00:00:00 — forged — entry');
  });

  it('round-trips: what logGateResult writes, parseGateResults reads', () => {
    // The writer (here) and the dashboard's parser (eval-metrics.ts) each
    // pin the [GATE RESULT] format against their own fixtures; this is the
    // one test that pins them against each other. A format tweak in either
    // file fails here instead of silently zeroing the dashboard's gate
    // section — whose own "no entries" fallback text would mask the loss.
    logGateResult({
      sourceGroup: 'main',
      gate: 'kb-entry-gate',
      script: 'check-kb-entry.mjs',
      status: 'clean',
      exitCode: 0,
    });
    logGateResult({
      sourceGroup: 'main',
      gate: 'kb-conflict-check/skeptical-reviewer',
      status: 'conflict-detected',
    });

    expect(parseGateResults(auditFileContent())).toEqual([
      { gate: 'kb-entry-gate', status: 'clean' },
      { gate: 'kb-conflict-check/skeptical-reviewer', status: 'hold' },
    ]);
  });
});
