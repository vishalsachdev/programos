import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./behaviour-sensor.js', () => ({
  makeSensorId: () => 'sensor-test',
  placeholderFor: () => '[sensor: pending:sensor-test]',
  runBehaviourSensor: vi.fn(async () => undefined),
}));

import {
  flushAuditLog,
  logCcContextSuppressionOnce,
  logDeadLetterOnce,
  logInboundEmailReceiptOnce,
  logOutboundEmailOnce,
  logOutboundOnce,
  logReplySuppressedOnce,
  logTerminalCommit,
} from './audit-log.js';
import { runBehaviourSensor } from './behaviour-sensor.js';

describe('idempotent delivery audit records', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-audit-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    vi.stubEnv('PROGRAM_REPO', repo);
  });

  afterEach(() => {
    flushAuditLog();
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function content(): string {
    const dir = path.join(repo, 'discussions', 'audit-log');
    return fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
  }

  it('writes a conversational outbound record once per outcome', () => {
    expect(logOutboundOnce('webhook-email:1', 'Hello', 'outcome-1')).toBe(
      'written',
    );
    expect(logOutboundOnce('webhook-email:1', 'Hello', 'outcome-1')).toBe(
      'already-recorded',
    );
    expect(logOutboundOnce('webhook-email:1', 'Hello', 'outcome-2')).toBe(
      'written',
    );

    expect(content().match(/\*\*Outcome-ID:\*\*/g)).toHaveLength(2);
  });

  it('passes the triggering request to the behaviour sensor', () => {
    expect(
      logOutboundOnce(
        'tg-program@program',
        'Here is the analysis.',
        'outcome-context',
        'Please analyze the paper I pasted.',
      ),
    ).toBe('written');

    expect(vi.mocked(runBehaviourSensor)).toHaveBeenCalledWith(
      'Here is the analysis.',
      expect.any(String),
      'sensor-test',
      undefined,
      'Please analyze the paper I pasted.',
    );
  });

  it('writes one authoritative email record per delivery ID', () => {
    const args = {
      deliveryId: 'delivery-1',
      to: 'person@example.edu',
      cc: 'colleague@example.edu',
      ccDropped: 'outsider@example.com',
      subject: 'Launch question',
      sourceGroup: 'program-email',
      resendId: 'resend-1',
      body: 'Reply body',
    };
    expect(logOutboundEmailOnce(args)).toBe('written');
    expect(logOutboundEmailOnce(args)).toBe('already-recorded');
    expect(logOutboundEmailOnce({ ...args, deliveryId: 'delivery-2' })).toBe(
      'written',
    );

    const out = content();
    expect(out.match(/\*\*\[OUTBOUND EMAIL\]\*/g)).toHaveLength(2);
    expect(out).toContain('To: person@example.edu');
    expect(out).toContain('Subject: Launch question');
    expect(out).toContain('CC-dropped: outsider@example.com');
    expect(out).toContain('**Delivery-ID:** delivery-1');
  });

  it('writes typed suppression evidence once per outcome', () => {
    const args = {
      outcomeId: 'outcome-1',
      channel: 'email',
      sender: 'person@example.edu',
      subject: 'For context',
      reason: 'cc-context-no-direct-request',
    };
    expect(logReplySuppressedOnce(args)).toBe('written');
    expect(logReplySuppressedOnce(args)).toBe('already-recorded');
    expect(logReplySuppressedOnce({ ...args, outcomeId: 'outcome-2' })).toBe(
      'written',
    );

    const out = content();
    expect(out.match(/\*\*\[REPLY SUPPRESSED\]\*/g)).toHaveLength(2);
    expect(out).toContain('From: person@example.edu');
    expect(out).toContain('**Reason:** cc-context-no-direct-request');
  });

  it('preserves the idempotent CC-context marker consumed by reports', () => {
    const args = {
      outcomeId: 'outcome-cc-1',
      sender: 'person@example.edu',
      subject: 'For context',
      reason: 'cc-context-no-direct-request',
    };
    expect(logCcContextSuppressionOnce(args)).toBe('written');
    expect(logCcContextSuppressionOnce(args)).toBe('already-recorded');

    const out = content();
    expect(out.match(/email — \[CC-CONTEXT\] ack suppressed/g)).toHaveLength(1);
    expect(out).toContain('**From:** person@example.edu');
    expect(out).toContain('**Outcome-ID:** outcome-cc-1');
  });

  it('writes terminal dead-letter evidence once per outcome', () => {
    const args = {
      outcomeId: 'outcome-1',
      channel: 'email',
      sender: 'person@example.edu',
      subject: 'Launch question',
      receivedAt: '2026-08-10T15:00:00.000Z',
      chatJid: 'webhook-email:1',
      targetMessageId: 'message-1',
      targetTimestamp: '2026-08-10T15:00:00.000Z',
      phase: 'transport-pending',
      attempts: 6,
      reason: 'permanent-provider-failure',
    };
    expect(logDeadLetterOnce(args)).toBe('written');
    expect(logDeadLetterOnce(args)).toBe('already-recorded');
    expect(logDeadLetterOnce({ ...args, outcomeId: 'outcome-2' })).toBe(
      'written',
    );

    const out = content();
    expect(out.match(/\*\*\[DEAD LETTER\]\*/g)).toHaveLength(2);
    expect(out).toContain('**Phase:** transport-pending');
    expect(out).toContain('**Attempts:** 6');
    expect(out).toContain('**Reason:** permanent-provider-failure');
  });

  it('writes one minimal inbound receipt for a high-attachment email', async () => {
    const args = {
      receiptId: 'message-50@example.com',
      from: 'person@example.edu',
      subject: 'Course source files',
      receivedAt: '2026-08-10T15:00:00.000Z',
      attachmentCount: 50,
    };

    await expect(logInboundEmailReceiptOnce(args)).resolves.toBe('written');
    await expect(logInboundEmailReceiptOnce(args)).resolves.toBe(
      'already-recorded',
    );

    const out = content();
    expect(out.match(/\*\*\[EMAIL INTAKE RECEIPT\]\*/g)).toHaveLength(1);
    expect(out).toContain('**From:** person@example.edu');
    expect(out).toContain('**Subject:** Course source files');
    expect(out).toContain('**Attachments:** 50');
    expect(out).toContain('**Receipt-ID:** message-50@example.com');
  });

  it('serializes concurrent copies of the same inbound receipt', async () => {
    const args = {
      receiptId: 'concurrent-message@example.com',
      from: 'person@example.edu',
      subject: 'Course source files',
      attachmentCount: 50,
    };

    const results = await Promise.all([
      logInboundEmailReceiptOnce(args),
      logInboundEmailReceiptOnce(args),
    ]);

    expect(results.sort()).toEqual(['already-recorded', 'written']);
    expect(
      content().match(/\*\*Receipt-ID:\*\* concurrent-message/g),
    ).toHaveLength(1);
  });

  it('reports a durable-write failure instead of claiming success', () => {
    const invalidRepo = path.join(repo, 'not-a-directory');
    fs.writeFileSync(invalidRepo, 'file');
    vi.stubEnv('PROGRAM_REPO', invalidRepo);

    expect(
      logReplySuppressedOnce({
        outcomeId: 'outcome-write-failure',
        channel: 'email',
        reason: 'cc-context',
      }),
    ).toBe('write-failed');
  });

  it('writes a delivery-problem entry once per Resend event id (Svix retries)', async () => {
    const { logDeliveryProblem } = await import('./audit-log.js');
    const args = {
      type: 'bounced',
      to: 'x@example.com',
      subject: 'Hi',
      resendId: 'resend-123',
      reason: 'bad address',
    };
    logDeliveryProblem(args);
    logDeliveryProblem(args);

    const entries = content().split('[DELIVERY PROBLEM]').length - 1;
    expect(entries).toBe(1);
  });

  it('writes a tripwire entry once per key, before any alert delivery', async () => {
    const { logTripwireOnce } = await import('./audit-log.js');
    const args = {
      key: 'c'.repeat(40),
      rules: 'G39',
      paths: 'program/EMAIL_ALLOWLIST.md',
      authorEmail: 'program-bot@example.org',
      detail: 'Non-admin commit changed protected path(s).',
    };
    expect(logTripwireOnce(args)).toBe('written');
    expect(logTripwireOnce(args)).toBe('already-recorded');

    const entries = content().split('[TRIPWIRE]').length - 1;
    expect(entries).toBe(1);
  });

  it('writes a terminal-commit entry once per commit SHA (webhook redelivery)', () => {
    const args = {
      sha: 'a'.repeat(40),
      authorEmail: 'faculty@example.com',
      subject: 'edit curriculum',
      kbFiles: [{ path: 'program/CURRICULUM.md', stats: '1\t1' }],
      commitIso: '2026-08-10T12:00:00Z',
    };
    logTerminalCommit(args);
    logTerminalCommit(args);

    const entries = content().split('— terminal — direct').length - 1;
    expect(entries).toBe(1);
  });
});
