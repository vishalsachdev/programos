import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { HOST_SYNC_BUDGET_MS, HOST_SYNC_UNDO_MS } from './host-repo.js';

// shutdown() in src/index.ts awaits every step in full: an audit flush can be
// mid rebase in the host repo, and a SIGKILL there strands the rebase. pm2's
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
    // One knowledge-base sync (commit, fetch, import from the checkout,
    // push, rebase and push again) is capped as a whole by
    // HOST_SYNC_BUDGET_MS, whatever its steps, plus the steps that undo a
    // rebase. flushAuditLog chains behind a sync already in flight, so
    // shutdown can wait for two of them.
    const syncMs = 2 * (HOST_SYNC_BUDGET_MS + HOST_SYNC_UNDO_MS);
    // shutdownOutboundEmailQueue(10000) + queue.shutdown(10000) in index.ts.
    const graceMs = 10_000 + 10_000;
    expect(app.kill_timeout).toBeGreaterThanOrEqual(syncMs + graceMs);
  });
});
