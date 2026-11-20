/**
 * The hole this change closes, shown through the public audit-log API only,
 * so the same file can be run against the code before the change.
 *
 * Before: the host committed and pushed the audit log with git running in
 * the agent-writable checkout, so a hook planted there ran on the host.
 * This test FAILS on that code (checked on `main` at 4f1d81a: the canary
 * holds post-commit, pre-push, reference-transaction and post-index-change).
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./behaviour-sensor.js', () => ({
  makeSensorId: () => 'sensor-test',
  placeholderFor: () => '[sensor: pending:sensor-test]',
  runBehaviourSensor: vi.fn(async () => undefined),
}));

import { flushAuditLog, logDroppedEmail } from './audit-log.js';
import { makeKbFixture, type KbFixture } from './test-support/kb-fixture.js';

let kb: KbFixture;

beforeEach(() => {
  kb = makeKbFixture();
});

afterEach(() => {
  kb.cleanup();
});

it('a hook the agent planted in its checkout does not run when the host commits and pushes the audit log', async () => {
  const hooks = path.join(kb.checkout, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of [
    'pre-commit',
    'post-commit',
    'pre-push',
    'reference-transaction',
    'post-index-change',
  ])
    fs.copyFileSync(kb.canaryScript, path.join(hooks, hook));

  logDroppedEmail('stranger@example.org', 'hello');
  await flushAuditLog();

  expect(kb.canaryLines()).toEqual([]);
  // And the audit entry still reached the remote.
  expect(kb.originLog('%s')[0]).toBe('Audit log: 1 entries');
});
