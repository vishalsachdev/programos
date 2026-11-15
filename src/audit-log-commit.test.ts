import { describe, expect, it } from 'vitest';

import { runAuditCommit } from './audit-log.js';

type Call = string[];

function recorder(fail: (args: Call) => boolean = () => false) {
  const calls: Call[] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    if (fail(args)) throw new Error(`git ${args[0]} failed`);
  };
  return { calls, run };
}

describe('runAuditCommit', () => {
  it('stages, commits and pushes with git argv only (no shell, no chown)', async () => {
    const r = recorder();
    await runAuditCommit(3, r.run);
    expect(r.calls).toEqual([
      ['add', 'discussions/audit-log/', 'discussions/kb-triage/'],
      [
        'commit',
        '-m',
        'Audit log: 3 entries',
        '--author=Coordinator <program-bot@example.org>',
        '--no-verify',
      ],
      ['push'],
    ]);
    expect(r.calls.flat().join(' ')).not.toMatch(/chown/);
  });

  it('on a rejected push, rebases onto origin and pushes again', async () => {
    let pushes = 0;
    const r = recorder((a) => a[0] === 'push' && pushes++ === 0);
    await runAuditCommit(1, r.run);
    expect(r.calls.slice(2)).toEqual([
      ['push'],
      ['pull', '--rebase', '--autostash', 'origin', 'main'],
      ['push'],
    ]);
  });

  it('aborts a failed rebase and reports failure', async () => {
    const r = recorder((a) => a[0] === 'push' || a[0] === 'pull');
    await expect(runAuditCommit(1, r.run)).rejects.toThrow();
    expect(r.calls.at(-1)).toEqual(['rebase', '--abort']);
  });

  it('with nothing new to commit, still pushes a stranded local commit', async () => {
    // commit fails, but `git diff --cached --quiet` succeeds: nothing staged.
    const r = recorder((a) => a[0] === 'commit');
    await runAuditCommit(1, r.run);
    expect(r.calls.map((c) => c[0])).toEqual(['add', 'commit', 'diff', 'push']);
  });

  it('stops before pushing when the commit fails with staged changes', async () => {
    const r = recorder((a) => a[0] === 'commit' || a[0] === 'diff');
    await expect(runAuditCommit(1, r.run)).rejects.toThrow();
    expect(r.calls.map((c) => c[0])).toEqual(['add', 'commit', 'diff']);
  });
});

describe('commitAuditLog (awaitable, retry-safe)', () => {
  it('resolves only after the push finishes, so shutdown can await it', async () => {
    const { commitAuditLog, _setPendingWritesForTests } =
      await import('./audit-log.js');
    _setPendingWritesForTests(2);
    const order: string[] = [];
    const run = async (args: string[]) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(args[0]);
    };
    await commitAuditLog(run);
    expect(order).toEqual(['add', 'commit', 'push']);
  });

  it('keeps the entries pending after a failure, so the next cycle retries', async () => {
    const { commitAuditLog, _setPendingWritesForTests } =
      await import('./audit-log.js');
    _setPendingWritesForTests(2);
    await commitAuditLog(async (args) => {
      if (args[0] === 'commit' || args[0] === 'diff')
        throw new Error('index.lock');
    });
    const calls: string[] = [];
    await commitAuditLog(async (args) => {
      calls.push(args.join(' '));
    });
    expect(calls[1]).toContain('Audit log: 2 entries');
  });
});
