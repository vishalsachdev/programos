import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { checkoutGitOptions } from './program-repo.js';

// shutdown() in src/index.ts awaits every step in full: an audit flush can be
// mid `pull --rebase`, and a SIGKILL there strands the rebase. pm2's
// kill_timeout must therefore cover the slowest shutdown the code allows.
const require = createRequire(import.meta.url);
const ecosystem = require(path.join(process.cwd(), 'ecosystem.config.cjs'));

describe('pm2 kill_timeout', () => {
  const app = ecosystem.apps.find(
    (a: { name: string }) => a.name === 'programos',
  );

  it('runs the same entry point as the live process', () => {
    expect(app.script).toBe('./start.sh');
    expect(app.interpreter).toBe('bash');
  });

  it('covers the worst-case shutdown the code allows', () => {
    // runAuditCommit: add, commit, diff --cached, push, pull --rebase, push,
    // rebase --abort, run one after another, each capped by execFile timeout.
    // flushAuditLog chains behind a commit already in flight, and a failed
    // commit restores its entries, so shutdown can wait for two sequences.
    const gitSteps = 2 * 7;
    const gitTimeout = checkoutGitOptions({ isRoot: false }).timeout;
    // shutdownOutboundEmailQueue(10000) + queue.shutdown(10000) in index.ts.
    const graceMs = 10_000 + 10_000;
    expect(app.kill_timeout).toBeGreaterThanOrEqual(
      gitSteps * gitTimeout + graceMs,
    );
  });
});
