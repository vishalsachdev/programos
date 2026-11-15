/**
 * Fresh-process durability tests for the outbound email outbox.
 *
 * These spawn REAL node processes against a REAL SQLite file in a scratch
 * directory and use real signals. Same-process
 * restart simulations (`_resetOutboundQueueTailForTests`) are not proof of
 * restart safety: module state reset in one process cannot show what a new process
 * reads off disk. Everything here goes through `test/outbox-harness.ts`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const HARNESS = path.join(REPO_ROOT, 'test', 'outbox-harness.ts');
// The tsx ESM loader, imported into a plain node process. The `tsx` bin would
// also work, but it forks a grandchild: SIGKILL against the wrapper would then
// leave the real process (and the outbox lock it holds) alive.
const TSX_LOADER = path.join(
  REPO_ROOT,
  'node_modules',
  'tsx',
  'dist',
  'loader.mjs',
);

interface HarnessEvent {
  event: string;
  [key: string]: unknown;
}

interface HarnessRun {
  child: ChildProcessWithoutNullStreams;
  events: HarnessEvent[];
  stdout: string;
  stderr: string;
  exited: Promise<number>;
}

let workDir: string;

function providerLogPath(): string {
  return path.join(workDir, 'provider-calls.jsonl');
}

function providerCalls(): Array<{ pid: number; key: string }> {
  if (!fs.existsSync(providerLogPath())) return [];
  return fs
    .readFileSync(providerLogPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; key: string });
}

function startHarness(
  mode: string,
  env: Record<string, string> = {},
): HarnessRun {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    HARNESS_LOG: providerLogPath(),
  };
  // The child must NOT look like a test runner: createDefaultOutboxStore()
  // returns the in-memory store under VITEST/NODE_ENV=test, which would make
  // every assertion here vacuous.
  delete childEnv.VITEST;
  delete childEnv.VITEST_WORKER_ID;
  delete childEnv.NODE_ENV;

  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, HARNESS, mode],
    {
      cwd: workDir,
      env: childEnv,
    },
  ) as ChildProcessWithoutNullStreams;

  const run: HarnessRun = {
    child,
    events: [],
    stdout: '',
    stderr: '',
    exited: new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1));
    }),
  };

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    run.stdout += chunk.toString();
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('HARNESS:')) {
        run.events.push(
          JSON.parse(line.slice('HARNESS:'.length)) as HarnessEvent,
        );
      }
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    run.stderr += chunk.toString();
  });

  return run;
}

async function runHarness(
  mode: string,
  env: Record<string, string> = {},
): Promise<HarnessRun & { code: number }> {
  const run = startHarness(mode, env);
  const code = await run.exited;
  return { ...run, code };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function rowsFrom(run: HarnessRun): Array<Record<string, unknown>> {
  const dump = [...run.events].reverse().find((e) => e.event === 'rows');
  if (!dump)
    throw new Error(
      `No rows dump in harness output:\n${run.stdout}\n${run.stderr}`,
    );
  return dump.rows as Array<Record<string, unknown>>;
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-restart-'));
  fs.mkdirSync(path.join(workDir, 'store'), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, '.env'),
    [
      'RESEND_API_KEY=test-resend-key',
      'SEND_FROM_NAME=Coordinator',
      'SEND_FROM_EMAIL=program@example.org',
    ].join('\n'),
  );
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('fresh-process outbox durability', () => {
  it('SIGTERM in the stagger gap leaves the row pending and a new process delivers it exactly once', async () => {
    const seed = startHarness('seed-hold', {
      HARNESS_COUNT: '2',
      // Long enough that a loaded machine cannot drift out of the stagger gap
      // before the signal lands; the test kills it as soon as row 0 is sent.
      HARNESS_STAGGER_MS: '20000',
      HARNESS_BATCH: 'restart',
    });

    await waitFor(
      () => providerCalls().length === 1,
      20_000,
      'the first provider call',
    );

    seed.child.kill('SIGTERM');
    const seedCode = await seed.exited;
    expect(seedCode, `stdout:\n${seed.stdout}\nstderr:\n${seed.stderr}`).toBe(
      0,
    );

    // Graceful shutdown is NOT a delivery disposition: the queued row must
    // still be replayable, never dead-lettered.
    const afterShutdown = rowsFrom(seed);
    expect(afterShutdown).toEqual([
      expect.objectContaining({ deliveryId: 'restart:0', status: 'sent' }),
      expect.objectContaining({ deliveryId: 'restart:1', status: 'pending' }),
    ]);
    expect(providerCalls()).toHaveLength(1);

    const replay = await runHarness('replay', {
      HARNESS_STAGGER_MS: '10',
      HARNESS_BATCH: 'restart',
    });
    expect(
      replay.code,
      `stdout:\n${replay.stdout}\nstderr:\n${replay.stderr}`,
    ).toBe(0);

    const calls = providerCalls();
    expect(calls.map((c) => c.key).sort()).toEqual(['restart:0', 'restart:1']);
    expect(rowsFrom(replay)).toEqual([
      expect.objectContaining({ deliveryId: 'restart:0', status: 'sent' }),
      expect.objectContaining({ deliveryId: 'restart:1', status: 'sent' }),
    ]);
  }, 60_000);

  it('a retryable failure on replay does not strand the row or block later work', async () => {
    // Seed two rows, both left pending for the replay process, and make the
    // provider return a retryable 500 for position 0 only.
    const seed = startHarness('seed-hold', {
      HARNESS_COUNT: '2',
      HARNESS_STAGGER_MS: '20000',
      HARNESS_BATCH: 'retry',
      HARNESS_FETCH: 'fail500-first',
    });
    await waitFor(
      () => providerCalls().length === 1,
      20_000,
      'the first provider call',
    );
    seed.child.kill('SIGTERM');
    await seed.exited;

    const replay = await runHarness('replay', {
      HARNESS_STAGGER_MS: '10',
      HARNESS_BATCH: 'retry',
      HARNESS_FETCH: 'fail500-first',
      HARNESS_DRAIN_MS: '4000',
    });

    const rows = rowsFrom(replay);
    const first = rows.find((r) => r.deliveryId === 'retry:0')!;
    const second = rows.find((r) => r.deliveryId === 'retry:1')!;

    // The failed row must never be left claimed by a process that is done with
    // it, it must keep being retried, and the later row must still be delivered.
    expect(first.status).not.toBe('claimed');
    expect(first.claimPid).toBeUndefined();
    expect(first.attempts as number).toBeGreaterThanOrEqual(2);
    expect(second.status).toBe('sent');
    expect(providerCalls().map((c) => c.key)).toContain('retry:1');
  }, 60_000);

  it('a corrupt database file fails closed and is left byte-identical', async () => {
    const first = await runHarness('init-only');
    expect(first.code).toBe(0);

    const dbPath = path.join(workDir, 'store', 'messages.db');
    // Physical corruption of a cleanly-closed database: the WAL companions go
    // with it, otherwise SQLite recovers a usable database from the WAL and the
    // corruption is not what the operator would actually face.
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    fs.writeFileSync(dbPath, 'this is not a database');
    const before = fs.readFileSync(dbPath);

    const corrupt = await runHarness('init-only');
    expect(corrupt.code).not.toBe(0);
    expect(`${corrupt.stdout}${corrupt.stderr}`).toMatch(/not a database/i);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  }, 60_000);

  it('a second live process is refused the outbox lock', async () => {
    const holder = startHarness('lock-hold', { HARNESS_STAGGER_MS: '5000' });
    await waitFor(
      () => holder.events.some((e) => e.event === 'locked'),
      20_000,
      'the first process to take the lock',
    );

    const second = await runHarness('lock-try');
    expect(second.events.some((e) => e.event === 'lock-refused')).toBe(true);
    expect(second.code).toBe(4);

    holder.child.kill('SIGKILL');
    await holder.exited;

    // The lock is recoverable after the holder dies.
    const third = await runHarness('lock-try');
    expect(third.events.some((e) => e.event === 'lock-acquired')).toBe(true);
    expect(third.code).toBe(0);
  }, 60_000);

  it('leaves any stray file in the store directory alone at startup', async () => {
    // An earlier JSON outbox never shipped, so no host can hold one and there
    // is no import path. A stray file is
    // simply not touched — startup must neither read it nor move it.
    const strayPath = path.join(workDir, 'store', 'outbound-email-outbox.json');
    fs.writeFileSync(strayPath, '{ not the outbox you are looking for');

    const replay = await runHarness('replay', { HARNESS_STAGGER_MS: '10' });

    expect(replay.code).toBe(0);
    expect(fs.readFileSync(strayPath, 'utf8')).toBe(
      '{ not the outbox you are looking for',
    );
    expect(fs.existsSync(`${strayPath}.migrated`)).toBe(false);
    expect(fs.existsSync(`${strayPath}.quarantine`)).toBe(false);
  }, 60_000);

  it('a shortfall alert that never completes survives the process that was delivering it', async () => {
    const hang = await runHarness('alert-hang');
    expect(hang.code).toBe(0);
    expect(hang.events.find((e) => e.event === 'persisted')?.count).toBe(1);

    const next = await runHarness('alert-count');
    expect(next.events.find((e) => e.event === 'count')?.count).toBe(1);
  }, 60_000);
});
