import fs from 'fs';
import os from 'os';
import path from 'path';

import { Parser } from 'htmlparser2';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The system assigns a free port at connect(); see connectOnFreePort.
let TEST_PORT = 0;
const receivedProbe = vi.hoisted(() => ({
  eml: '',
  readyTimer: undefined as Promise<number> | undefined,
  onParsed: undefined as (() => void) | undefined,
}));

vi.mock('mailparser', async (importOriginal) => {
  const original = await importOriginal<typeof import('mailparser')>();
  return {
    ...original,
    simpleParser: async (input: string) => {
      const result = await original.simpleParser(input);
      // Lets a test start counting only after MIME parsing (mailparser has its
      // own HTML handling, which is not the code under test).
      receivedProbe.onParsed?.();
      // R3-2: arm the ready timer AFTER real email parsing, before evidence collection.
      const start = performance.now();
      receivedProbe.readyTimer = new Promise((resolve) =>
        setTimeout(() => resolve(performance.now() - start), 0),
      );
      return result;
    },
  };
});

vi.hoisted(() => {
  process.env.WEBHOOK_PORT = '0';
  process.env.WEBHOOK_HOST = '127.0.0.1';
});

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
  }),
}));

vi.mock('../program-repo.js', () => ({
  CHECKOUT_OWNER: { uid: 1000, gid: 1000 },
  checkoutGitOptions: () => ({
    cwd: process.env.PROGRAM_REPO,
    env: process.env,
    timeout: 30_000,
  }),
  getProgramRepoPath: () => '/tmp/program-repo-test',
}));

vi.mock('../repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: vi.fn(),
    readFile: vi.fn((relPath: string) =>
      relPath === 'program/EMAIL_ALLOWLIST.md'
        ? '| Person | person@example.edu | Staff | read-write | Program |\n'
        : null,
    ),
    readFileAsync: vi.fn(async (relPath: string) =>
      relPath === 'discussions/raw/2026-08-10-launch-question.md'
        ? 'From: person@example.edu\nTo: program@example.org\nPlease contact inbound-only@example.org\nAgent edit: invented@example.org'
        : null,
    ),
    readFileBuffer: vi.fn(() =>
      receivedProbe.eml ? Buffer.from(receivedProbe.eml) : null,
    ),
    readFileAtCreationAsync: vi.fn(async () => receivedProbe.eml || null),
  }),
}));

import './webhook.js';
import { connectOnFreePort } from '../test-support/webhook-test-port.js';
import { inboundEmailAddressesInHtml } from '../inbound-html-addresses.js';
import { resolveChannelDeliveryContext } from '../channel-delivery.js';
import { resolveEmailGateContext } from '../email-gate-context.js';
import { processDelivery } from '../delivery-processor.js';
import { loadDeliveryState, saveDeliveryState } from '../delivery-state.js';
import { MemoryOutboxStore } from '../outbound-email-outbox.js';
import {
  _resetOutboundEmailQueueForTests,
  _setStaggerMsForTests,
} from '../outbound-email.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import type { NewMessage } from '../types.js';
import { getChannelFactory } from './registry.js';

describe('webhook inbound delivery context', () => {
  let disconnect: (() => Promise<void>) | undefined;
  let tempDir: string | undefined;
  const parserSpies: Array<{ mockRestore: () => void }> = [];

  afterEach(async () => {
    await disconnect?.();
    disconnect = undefined;
    _closeDatabase();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
    receivedProbe.eml = '';
    receivedProbe.readyTimer = undefined;
    receivedProbe.onParsed = undefined;
    for (const spy of parserSpies.splice(0)) spy.mockRestore();
  });

  // Catches losing addresses supplied in the actual inbound body across intake and restart.
  it('uses received content after a delayed raw-file edit and preserves it across intake-to-agent restart', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-restart-'));
    const dbPath = path.join(tempDir, 'messages.db');
    _initTestDatabase(dbPath);
    const onMessage = vi.fn(
      (chatJid: string, message: NewMessage, deliveryContext?: unknown) => {
        storeChatMetadata(
          chatJid,
          message.timestamp,
          'Program Email',
          'webhook',
          false,
        );
        storeMessage({ ...message, delivery_context: deliveryContext });
      },
    );
    const channel = getChannelFactory('webhook')?.({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('webhook channel not registered');
    disconnect = () => channel.disconnect();
    TEST_PORT = await connectOnFreePort(channel);

    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        // R1-3: the mirror is now edited, but the buffered payload retains the received message.
        raw_email:
          'From: person@example.edu\r\nTo: program@example.org\r\nSubject: Launch question\r\n\r\nPlease contact inbound-only@example.org',
        filename: '2026-08-10-launch-question.md',
        subject: 'Launch question',
        from: 'person@example.edu',
        to: 'program@example.org',
        cc: '',
        date: '2026-08-10T15:00:00Z',
        message_id: '<message-1@example.com>',
      }),
    });

    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
    const expectedContext = {
      type: 'webhook-email-v1',
      bodyEvidenceVersion: 1,
      bodyAddresses: [
        'person@example.edu',
        'program@example.org',
        'inbound-only@example.org',
      ],
      from: 'person@example.edu',
      subject: 'Launch question',
      messageId: '<message-1@example.com>',
      kbConflictSnapshot: { files: {} },
      allowlistSnapshot: {
        available: true,
        source: 'program/EMAIL_ALLOWLIST.md',
        senders: ['person@example.edu'],
      },
      ccContext: {
        ccOnly: false,
        suppressAck: false,
        reason: 'no .eml available — envelope headers untrusted, acking',
      },
    };
    expect(onMessage.mock.calls[0][2]).toEqual(expectedContext);

    // Simulate a process restart: reopen the database and use a fresh channel
    // instance whose in-memory email map starts empty.
    _initTestDatabase(dbPath);
    const [recovered] = getMessagesSince(
      'webhook-email:message-1@example.com',
      '',
      'Coordinator',
    );
    const recoveryChannel = getChannelFactory('webhook')?.({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!recoveryChannel) throw new Error('recovery channel not registered');
    const recoveredContext = resolveChannelDeliveryContext(
      recoveryChannel,
      recovered.chat_jid,
      recovered,
    );

    expect(recoveredContext).toEqual(expectedContext);
    expect(
      recoveryChannel.restoreDeliveryContext?.(
        recovered.chat_jid,
        recoveredContext,
      ),
    ).toBe(true);
    await expect(
      recoveryChannel.prepareDelivery(
        recovered.chat_jid,
        '<reply>Recovered reply</reply>',
        'delivery-after-restart',
      ),
    ).resolves.toMatchObject({
      status: 'prepared',
      delivery: {
        payload: {
          email: {
            to: 'person@example.edu',
            subject: 'Re: Launch question',
          },
          options: {
            inReplyTo: '<message-1@example.com>',
          },
        },
      },
    });
  });

  // R2-4: reproduces intake dropping an address supplied only in the subject, then refusing its reply.
  it.each(['payload', 'received eml'])(
    'trusts a subject-only address from the %s through reply preparation',
    async (source) => {
      _initTestDatabase();
      const onMessage = vi.fn();
      const channel = getChannelFactory('webhook')?.({
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });
      if (!channel) throw new Error('missing webhook');
      disconnect = () => channel.disconnect();
      TEST_PORT = await connectOnFreePort(channel);
      const subject = 'Please confirm subject-only@example.org';
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          filename: '2026-10-07-subject-only.md',
          from: 'person@example.edu',
          to: 'program@example.org',
          cc: '',
          subject: source === 'payload' ? subject : 'Question',
          ...(source === 'received eml'
            ? {
                raw_email: `From: person@example.edu\r\nTo: program@example.org\r\nSubject: ${subject}\r\n\r\nPlease confirm.`,
              }
            : {}),
          date: '2026-10-07T15:00:00Z',
          message_id: '<subject-only@example.com>',
        }),
      });
      expect(response.status).toBe(200);
      expect(onMessage).toHaveBeenCalledOnce();
      const [jid, , context] = onMessage.mock.calls[0];
      expect(context.bodyAddresses).toContain('subject-only@example.org');
      const gateContext = await resolveEmailGateContext([], context);
      const gate = channel.gateProfile.validate(
        '<reply>Confirmed subject-only@example.org</reply>',
        gateContext,
      );
      expect(gate.ok).toBe(true);
      expect(
        await channel.prepareDelivery(
          jid,
          'Confirmed subject-only@example.org',
          'subject-reply',
          gateContext,
        ),
      ).toMatchObject({ status: 'prepared' });
    },
  );

  // R8-3: the ready timer starts after MIME parsing, isolating the new evidence scan.
  //
  // What is protected: 64,000 closing tags that match no open element must not
  // each search the parser's stack of 64,000 open elements. That search is
  // quadratic (about 9 s here on a 4-core machine; the scan as shipped takes
  // about 50 ms) and it runs synchronously, so it would hold the event loop.
  //
  // The proof is a count, not a clock: htmlparser2's own `onclosetag` is the
  // only place that searches the stack, so the scan must never reach it for an
  // orphan closer. A count does not depend on machine speed. The earlier
  // version asserted only "ready timer delayed by less than 100 ms", which
  // failed on loaded CI runners at 101 to 103 ms with the scan unchanged. The
  // timer is kept as a backstop against any other long synchronous stall, with
  // a limit (1,000 ms) that sits about 20 times above the normal cost and about
  // 9 times below the quadratic one.
  it('scans deeply mismatched received HTML without the quadratic stack search or a long event-loop stall', async () => {
    _initTestDatabase();
    const stackSearch = vi.spyOn(Parser.prototype, 'onclosetag');
    const parserEnd = vi.spyOn(Parser.prototype, 'end');
    parserSpies.push(stackSearch, parserEnd);
    receivedProbe.onParsed = () => {
      stackSearch.mockClear();
      parserEnd.mockClear();
    };
    const onMessage = vi.fn();
    const channel = getChannelFactory('webhook')!({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    })!;
    disconnect = () => channel.disconnect();
    TEST_PORT = await connectOnFreePort(channel);
    const html = '<span>'.repeat(64_000) + '</div>'.repeat(64_000);
    const raw = `From: person@example.edu\r\nTo: program@example.org\r\nSubject: Evidence\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="deep-html"\r\n\r\n--deep-html\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOrdinary received text.\r\n--deep-html\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--deep-html--\r\n`;
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        raw_email: raw,
        filename: 'deep-html.md',
        from: 'person@example.edu',
        to: 'program@example.org',
        subject: 'Evidence',
        date: new Date().toISOString(),
        message_id: '<deep-html@example.org>',
      }),
    });
    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
    expect(receivedProbe.readyTimer).toBeDefined();
    const readyDelayMs = await receivedProbe.readyTimer;
    // The evidence scan ran on this HTML after MIME parsing, through the same
    // Parser class the spies watch...
    expect(parserEnd).toHaveBeenCalledTimes(1);
    expect(parserEnd).toHaveBeenCalledWith(html);
    // ...and not one of the 64,000 orphan closers reached the stack search.
    expect(stackSearch).not.toHaveBeenCalled();
    // Control: the spy does count the stack search when a closer has an opener,
    // so the zero above is not a spy that sees nothing.
    inboundEmailAddressesInHtml('<p>text</p>');
    expect(stackSearch).toHaveBeenCalledTimes(1);
    expect(readyDelayMs).toBeLessThan(1_000);
  }, 20_000);

  // R3-2: reproduces 128,000 brackets in the original .eml delaying an already-ready timer at intake.
  it('collects original bracket-heavy inbound evidence without delaying a ready timer by 50ms', async () => {
    _initTestDatabase();
    const onMessage = vi.fn();
    const channel = getChannelFactory('webhook')?.({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('missing webhook');
    disconnect = () => channel.disconnect();
    TEST_PORT = await connectOnFreePort(channel);
    receivedProbe.eml = `From: person@example.edu\r\nTo: program@example.org\r\nSubject: Evidence\r\n\r\n${'['.repeat(128_000)}person@example.edu`;
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filename: '2026-10-07-brackets.md',
        eml_file_path: 'discussions/raw/2026-10-07-brackets.eml',
        from: 'person@example.edu',
        to: 'program@example.org',
        subject: 'Evidence',
        date: '2026-10-07T15:00:00Z',
        message_id: '<brackets@example.com>',
      }),
    });
    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][2].bodyAddresses).toContain(
      'person@example.edu',
    );
    expect(receivedProbe.readyTimer).toBeDefined();
    expect(await receivedProbe.readyTimer).toBeLessThan(50);
  }, 15_000);

  // R3-3: original fenced content and raw underscore markup must retain received contacts through reply/repair validation.
  it('trusts contacts in original fenced content and adds underscore variants only to inbound evidence', async () => {
    _initTestDatabase();
    const onMessage = vi.fn();
    const channel = getChannelFactory('webhook')?.({
      onMessage,
      onChatMetadata: vi.fn(),
      registeredGroups: () => ({}),
    });
    if (!channel) throw new Error('missing webhook');
    disconnect = () => channel.disconnect();
    TEST_PORT = await connectOnFreePort(channel);
    receivedProbe.eml =
      'From: person@example.edu\r\nTo: "__header-contact@example.org__" <program@example.org>\r\nSubject: Confirm __subject-contact@example.org__\r\n\r\nPlease confirm:\n```\ninbound-only@example.org\n```\nContact __wrapped-contact@example.org__ and genuine_@example.org.';
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filename: '2026-10-07-fenced.md',
        eml_file_path: 'discussions/raw/2026-10-07-fenced.eml',
        from: 'person@example.edu',
        to: 'program@example.org',
        subject: 'Confirm',
        date: '2026-10-07T15:00:00Z',
        message_id: '<fenced@example.com>',
      }),
    });
    expect(response.status).toBe(200);
    const [jid, , context] = onMessage.mock.calls[0];
    expect(context.bodyAddresses).toEqual(
      expect.arrayContaining([
        'inbound-only@example.org',
        '__wrapped-contact@example.org__',
        'wrapped-contact@example.org',
        'genuine_@example.org',
        '__subject-contact@example.org__',
        'subject-contact@example.org',
        '__header-contact@example.org__',
        'header-contact@example.org',
      ]),
    );
    const gateContext = await resolveEmailGateContext([], context);
    // The additional inbound variant removes outer markup, not an underscore inside a real local part.
    expect(context.bodyAddresses).not.toContain('genuine@example.org');
    expect(
      channel.gateProfile.validate(
        '<reply>Confirmed genuine@example.org</reply>',
        gateContext,
      ),
    ).toMatchObject({ ok: false, addresses: ['genuine@example.org'] });
    const runRepairAgent = vi.fn(async () => ({
      status: 'success' as const,
      raw: '<reply>Should not repair</reply>',
    }));
    const now = '2026-10-07T15:00:00.000Z';
    const result = await processDelivery(
      {
        chatJid: jid,
        prompt: 'Please confirm',
        inboundText: 'Original received message',
        targetTimestamp: now,
        previousCursor: '',
        context: { channelData: context },
      },
      {
        loadState: () => ({ status: 'none' }),
        saveState: () => ({ status: 'saved' }),
        clearState: () => undefined,
        runBusinessAgent: async () => ({
          status: 'success',
          raw: '<reply>Confirmed inbound-only@example.org and wrapped-contact@example.org.</reply>',
        }),
        runRepairAgent,
        validateOutput: (raw) => channel.gateProfile.validate(raw, gateContext),
        prepareDelivery: (text, id) =>
          channel.prepareDelivery(jid, text, id, gateContext),
        deliverPrepared: async () => ({
          status: 'sent',
          providerId: 'fenced-contact',
        }),
        writeCursor: vi.fn(),
        auditSent: () => 'written',
        auditSuppressed: () => 'written',
        auditCcContext: () => 'written',
        auditDeadLetter: () => 'written',
        closeContainer: () => undefined,
        alertDeadLetter: async () => undefined,
        now: () => new Date(now),
        newDeliveryId: () => 'fenced-reply',
      },
    );
    expect(result).toEqual({ status: 'complete' });
    expect(runRepairAgent).not.toHaveBeenCalled();
  });

  // R4-3: original CC header/body contains a genuine _advisor mailbox; raw intake, persisted evidence, replay and final provider must not authorize advisor.
  it.each<{
    actualAddress: string;
    outgoingAddress: string;
    receivedBody: string;
    includeCc: boolean;
    bareCc?: boolean;
    foldedCc?: boolean;
    refusedAddress?: string;
  }>([
    ...[
      '_advisor@example.org',
      "o'advisor@example.org",
      'fake|advisor@example.org',
      'fake`advisor@example.org',
      "'advisor@example.org",
    ].map((actualAddress) => ({
      actualAddress,
      outgoingAddress: actualAddress,
      receivedBody: `Contact <${actualAddress}>.`,
      includeCc: true,
    })),
    // R8-2: raw Cc headers must not grant a suffix of a leading-pipe mailbox.
    {
      actualAddress: '|advisor@example.org',
      outgoingAddress: '|advisor@example.org',
      receivedBody: 'Please reply to this thread.',
      includeCc: true,
      refusedAddress: 'advisor@example.org',
      bareCc: true,
    },
    {
      actualAddress: '|fake|advisor@example.org',
      outgoingAddress: '|fake|advisor@example.org',
      receivedBody: 'Please reply to this thread.',
      includeCc: true,
      refusedAddress: 'fake|advisor@example.org',
      bareCc: true,
    },
    {
      actualAddress: '|fake|advisor@example.org|',
      outgoingAddress: "'|fake|advisor@example.org|'",
      receivedBody: 'Please reply to this thread.',
      includeCc: true,
      bareCc: true,
      foldedCc: true,
      refusedAddress: 'advisor@example.org',
    },
    // R7-3: storing a cleaned token must not create table boundaries or strip another mailto prefix.
    {
      actualAddress: '|fake|advisor@example.org|',
      outgoingAddress: "'|fake|advisor@example.org|'",
      receivedBody: "Please use '|fake|advisor@example.org|'",
      includeCc: false,
    },
    {
      actualAddress: 'mailto:advisor@example.org',
      outgoingAddress: 'mailto:mailto:advisor@example.org',
      receivedBody: "Please use 'mailto:mailto:advisor@example.org'",
      includeCc: false,
    },
  ])(
    'does not trust a sub-token of incoming %s at intake, saved replay or repair restart',
    async ({
      actualAddress,
      outgoingAddress,
      receivedBody,
      includeCc,
      bareCc = false,
      foldedCc = false,
      refusedAddress = 'advisor@example.org',
    }) => {
      _initTestDatabase();
      _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
      _setStaggerMsForTests(0);
      const onMessage = vi.fn();
      const channel = getChannelFactory('webhook')?.({
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });
      if (!channel) throw new Error('missing webhook');
      disconnect = () => channel.disconnect();
      TEST_PORT = await connectOnFreePort(channel);
      receivedProbe.eml = `From: person@example.edu\r\nTo: program@example.org\r\n${includeCc ? `Cc:${foldedCc ? '\r\n ' : ' '}${bareCc ? actualAddress : `<${actualAddress}>`}\r\n` : ''}Subject: Contact\r\n\r\n${receivedBody}`;
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          filename: '2026-10-07-unpaired.md',
          eml_file_path: 'discussions/raw/2026-10-07-unpaired.eml',
          from: 'person@example.edu',
          to: 'program@example.org',
          subject: 'Contact',
          date: '2026-10-07T15:00:00Z',
          message_id: '<unpaired@example.com>',
        }),
      });
      expect(response.status).toBe(200);
      const [jid, , context] = onMessage.mock.calls[0];
      expect(context.bodyAddresses).toContain(actualAddress);
      expect(context.bodyAddresses).not.toContain(refusedAddress);
      const gateContext = await resolveEmailGateContext([], context);
      expect(
        channel.gateProfile.validate(
          `<reply>Contact ${refusedAddress}</reply>`,
          gateContext,
        ),
      ).toMatchObject({ ok: false, addresses: [refusedAddress] });
      expect(
        await channel.prepareDelivery(
          jid,
          `Contact ${refusedAddress}`,
          'unpaired-refusal',
          gateContext,
        ),
      ).toMatchObject({
        status: 'failed',
        reason: expect.stringContaining(refusedAddress),
      });
      const allowed = await channel.prepareDelivery(
        jid,
        `Contact ${outgoingAddress}`,
        'unpaired-real',
        gateContext,
      );
      expect(allowed.status).toBe('prepared');
      if (allowed.status !== 'prepared')
        throw new Error('actual received address refused');
      // Persist the exact intake evidence, then reproduce the unsafe canonical reply
      // at the saved-transport boundary as if an earlier validator had admitted it.
      const prepared = structuredClone(allowed.delivery);
      prepared.deliveryId = 'unpaired-canonical';
      (prepared.payload as { email: { body: string } }).email.body =
        `Contact ${refusedAddress}`;
      const now = new Date().toISOString();
      expect(
        saveDeliveryState({
          version: 1,
          phase: 'transport-pending',
          chatJid: jid,
          targetTimestamp: now,
          previousCursor: '',
          context: { channelData: context },
          outcomeId: prepared.deliveryId,
          trustedBodyAddresses: context.bodyAddresses,
          prepared,
          replyText: `Contact ${refusedAddress}`,
          attempt: 1,
          createdAt: now,
        }),
      ).toEqual({ status: 'saved' });
      const loaded = loadDeliveryState(jid);
      if (
        loaded.status !== 'valid' ||
        loaded.state.phase !== 'transport-pending'
      )
        throw new Error('missing saved state');
      const restarted = getChannelFactory('webhook')?.({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });
      if (!restarted) throw new Error('missing restarted webhook');
      expect(
        restarted.restoreDeliveryContext?.(
          jid,
          loaded.state.context.channelData,
        ),
      ).toBe(true);
      const provider = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ id: 'must-not-send' }), {
          status: 200,
        }),
      );
      try {
        expect(
          await restarted.deliverPrepared(loaded.state.prepared),
        ).toMatchObject({
          status: 'failed',
          reason: expect.stringContaining(refusedAddress),
        });
        expect(provider).not.toHaveBeenCalled();
        // The actual incoming identity remains usable, including the host CC disclosure.
        expect(await restarted.deliverPrepared(allowed.delivery)).toMatchObject(
          {
            status: 'sent',
          },
        );
        expect(
          JSON.parse(String(provider.mock.calls[0][1]?.body)).text,
        ).toContain(`Contact ${outgoingAddress}`);
        // R5-3: signed saved-repair restart must carry exact intake evidence without
        // granting a former narrow reading to the repair agent.
        provider.mockClear();
        expect(
          saveDeliveryState({
            version: 1,
            phase: 'repair-required',
            chatJid: jid,
            targetTimestamp: now,
            previousCursor: '',
            context: { channelData: context },
            outcomeId: 'r5-saved-repair',
            trustedBodyAddresses: context.bodyAddresses,
            gateReason: 'missing-reply-block',
            rejectedOutput: 'Missing reply tags',
            attempt: 1,
            createdAt: now,
          }),
        ).toEqual({ status: 'saved' });
        const repair = loadDeliveryState(jid);
        if (
          repair.status !== 'valid' ||
          repair.state.phase !== 'repair-required'
        )
          throw new Error('missing saved repair');
        const resumedGateContext = await resolveEmailGateContext(
          [],
          repair.state.context.channelData,
          repair.state,
        );
        expect(
          await processDelivery(
            {
              chatJid: jid,
              prompt: 'Original question',
              inboundText: '',
              targetTimestamp: now,
              previousCursor: '',
              context: repair.state.context,
            },
            {
              loadState: () => repair,
              saveState: (state) => saveDeliveryState(state),
              clearState: vi.fn(),
              runBusinessAgent: async () => ({
                status: 'success',
                raw: '<reply>must not rerun</reply>',
              }),
              runRepairAgent: async () => ({
                status: 'success',
                raw: `<reply>Contact ${refusedAddress}</reply>`,
              }),
              validateOutput: (raw) =>
                restarted.gateProfile.validate(raw, resumedGateContext),
              prepareDelivery: (text, id) =>
                restarted.prepareDelivery(jid, text, id, resumedGateContext),
              deliverPrepared: (delivery) =>
                restarted.deliverPrepared(delivery),
              writeCursor: vi.fn(),
              auditSent: () => 'written',
              auditSuppressed: () => 'written',
              auditCcContext: () => 'written',
              auditDeadLetter: () => 'written',
              closeContainer: vi.fn(),
              alertDeadLetter: async () => {},
              now: () => new Date(now),
              newDeliveryId: () => 'r5-repair',
            },
          ),
        ).toEqual({ status: 'retry', attempt: 2 });
        expect(provider).not.toHaveBeenCalled();
      } finally {
        provider.mockRestore();
        _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
      }
    },
  );
  // R6-4: HTML alternatives carry received contacts even when text/plain omits them.
  it.each(
    [
      '<p>Contact <a href="mailto:html-only@example.org">Advisor</a>.</p>',
      '<p>Contact html-only&#64;example.org.</p>',
      '<p>Contact <span>html-only</span><span>@example.org</span>.</p>',
      '<p>Contact <a href="mailto:html-only%40example.org?subject=Question">Advisor</a>.</p>',
      // R9-2: the received quoted local part must survive whitespace and restart.
      '<a href="mailto:%22team%20lead%22%40example.org">Team contact</a>',
      // R7-4: recipient fields in a received mailto link are actual supplied contacts.
      '<a href="mailto:primary@example.org?cc=html-only@example.org">Use primary and copy Advisor</a>',
      '<a href="mailto:primary@example.org?bcc=html-only%40example.org">Use primary and copy Advisor</a>',
      '<a href="mailto:primary@example.org?to=html-only@example.org">Use primary and Advisor</a>',
      // R8-4: percent decoding precedes recipient-list parsing.
      ...['to', 'cc', 'bcc'].map(
        (field) =>
          `<a href="mailto:primary@example.org?${field}=backup%40example.org%2Csecond%40example.org">Contact</a>`,
      ),
    ].map((html) => ({
      html,
      contact: html.includes('%22team%20lead%22')
        ? '"team lead"@example.org'
        : html.includes('backup%40')
          ? 'backup@example.org'
          : 'html-only@example.org',
    })),
  )(
    'retains exact received HTML contact across restart: %s',
    async ({ html, contact }) => {
      _initTestDatabase();
      const onMessage = vi.fn();
      const channel = getChannelFactory('webhook')!({
        onMessage,
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      })!;
      disconnect = () => channel.disconnect();
      TEST_PORT = await connectOnFreePort(channel);
      const raw = `From: person@example.edu\r\nTo: program@example.org\r\nSubject: HTML contact\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="html-contact"\r\n\r\n--html-contact\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease use the Advisor contact link.\r\n--html-contact\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--html-contact--\r\n`;
      const response = await fetch(`http://127.0.0.1:${TEST_PORT}/`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          raw_email: raw,
          filename: 'html-contact.md',
          from: 'person@example.edu',
          to: 'program@example.org',
          subject: 'HTML contact',
          message_id: '<html-contact@example.org>',
          date: new Date().toISOString(),
        }),
      });
      expect(response.status).toBe(200);
      const [jid, message, context] = onMessage.mock.calls[0];
      expect(context.bodyAddresses).toContain(contact);
      if (html.includes('%2C'))
        expect(context.bodyAddresses).toContain('second@example.org');
      const evidence = await resolveEmailGateContext([
        { ...message, delivery_context: context },
      ]);
      expect(
        channel.gateProfile.validate(
          `<reply>Confirmed ${contact}</reply>`,
          evidence,
        ),
      ).toMatchObject({ ok: true });
      const prepared = await channel.prepareDelivery(
        jid,
        `Confirmed ${contact}`,
        'html-contact-send',
        evidence,
      );
      expect(prepared.status).toBe('prepared');
      if (prepared.status !== 'prepared')
        throw new Error('HTML contact refused');
      const timestamp = new Date().toISOString();
      expect(
        saveDeliveryState({
          version: 1,
          phase: 'transport-pending',
          chatJid: jid,
          targetTimestamp: timestamp,
          previousCursor: '',
          context: { channelData: context },
          outcomeId: prepared.delivery.deliveryId,
          trustedBodyAddresses: context.bodyAddresses,
          prepared: prepared.delivery,
          replyText: `Confirmed ${contact}`,
          attempt: 1,
          createdAt: timestamp,
        }),
      ).toEqual({ status: 'saved' });
      const saved = loadDeliveryState(jid);
      if (saved.status !== 'valid' || saved.state.phase !== 'transport-pending')
        throw new Error('HTML state missing');
      const restarted = getChannelFactory('webhook')!({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      })!;
      expect(
        restarted.restoreDeliveryContext?.(
          jid,
          saved.state.context.channelData,
        ),
      ).toBe(true);
      _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
      _setStaggerMsForTests(0);
      const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response(JSON.stringify({ id: 'html-contact-provider' }), {
            status: 200,
          }),
      );
      try {
        expect(
          await restarted.deliverPrepared(saved.state.prepared),
        ).toMatchObject({ status: 'sent' });
        expect(JSON.parse(String(provider.mock.calls[0][1]?.body)).text).toBe(
          `Confirmed ${contact}`,
        );
        if (html.includes('%2C') || html.includes('%22team%20lead%22')) {
          // Resume a signed repair item after earlier failed attempts: the exact
          // supplied contact must complete repair rather than exhaust the budget.
          expect(
            saveDeliveryState({
              version: 1,
              phase: 'repair-required',
              chatJid: jid,
              targetTimestamp: timestamp,
              previousCursor: '',
              context: { channelData: context },
              outcomeId: 'encoded-list-repair',
              trustedBodyAddresses: context.bodyAddresses,
              gateReason: 'unverified-email-address',
              rejectedOutput: `Copy ${contact}`,
              attempt: 5,
              createdAt: timestamp,
            }),
          ).toEqual({ status: 'saved' });
          const repair = loadDeliveryState(jid);
          if (
            repair.status !== 'valid' ||
            repair.state.phase !== 'repair-required'
          )
            throw new Error('missing saved repair');
          const resumedContext = await resolveEmailGateContext(
            [],
            repair.state.context.channelData,
            repair.state,
          );
          expect(
            await processDelivery(
              {
                chatJid: jid,
                prompt: 'Original question',
                inboundText: '',
                targetTimestamp: timestamp,
                previousCursor: '',
                context: repair.state.context,
              },
              {
                loadState: () => repair,
                saveState: (state) => saveDeliveryState(state),
                clearState: vi.fn(),
                runBusinessAgent: async () => {
                  throw new Error('repair must resume');
                },
                runRepairAgent: async () => ({
                  status: 'success',
                  raw: `<reply>Copy ${contact}</reply>`,
                }),
                validateOutput: (raw) =>
                  restarted.gateProfile.validate(raw, resumedContext),
                prepareDelivery: (text, id) =>
                  restarted.prepareDelivery(jid, text, id, resumedContext),
                deliverPrepared: (delivery) =>
                  restarted.deliverPrepared(delivery),
                writeCursor: vi.fn(),
                auditSent: () => 'written',
                auditSuppressed: () => 'written',
                auditCcContext: () => 'written',
                auditDeadLetter: () => 'written',
                closeContainer: vi.fn(),
                alertDeadLetter: async () => {},
                now: () => new Date(timestamp),
                newDeliveryId: () => 'encoded-list-repaired',
              },
            ),
          ).toEqual({ status: 'complete' });
          expect(JSON.parse(String(provider.mock.calls[1][1]?.body)).text).toBe(
            `Copy ${contact}`,
          );
        }
      } finally {
        provider.mockRestore();
        _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
      }
    },
  );
});
