import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'fixture-secret',
    RESEND_API_KEY: 'fixture-key',
    SEND_FROM_EMAIL: 'program@example.org',
  }),
}));
vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({
    readFile: () => '| Person | person@example.edu |',
    readFileAsync: async () => '| Person | person@example.edu |',
    refresh: vi.fn(),
    exists: () => false,
  }),
}));
vi.mock('./audit-log.js', () => ({
  logOutboundEmail: vi.fn(),
  logGateResult: vi.fn(),
}));
vi.mock('./delivery-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./delivery-gate.js')>()),
  reportDeliveryShortfall: vi.fn(),
}));
vi.mock('./program-repo.js', () => ({
  getProgramRepoPath: () => '/tmp/synthetic-program-repo',
}));

import './channels/webhook.js';
import { getChannelFactory } from './channels/registry.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import { loadDeliveryState, saveDeliveryState } from './delivery-state.js';
import * as formatter from './email-format.js';
import { MemoryOutboxStore } from './outbound-email-outbox.js';
import {
  _resetOutboundEmailQueueForTests,
  _setStaggerMsForTests,
  sendOutboundEmailResult,
  startOutboundEmailQueue,
} from './outbound-email.js';
import { processTaskIpc } from './ipc.js';
import { processOutreachResult } from './task-scheduler.js';
import { emailProfile } from './delivery-gate.js';
import type { PreparedDelivery } from './types.js';

const containerFormatter = await import(
  new URL('../container/agent-runner/src/email-format.ts', import.meta.url).href
);
const mockFetch = vi.fn();
let outbox: MemoryOutboxStore;
const jid = 'webhook-email:r4-final';
const now = new Date().toISOString();
const allowlist = {
  available: true,
  source: 'fixture',
  senders: new Set(['person@example.edu', 'advisor_@example.org']),
};
const email = {
  to: 'person@example.edu',
  subject: 'Contact',
  body: 'Contact person@example.edu',
};
const options = {
  sourceGroup: jid,
  forceBotReplyTo: true,
  trustedBodyAddresses: [],
  allowlistState: allowlist,
};

function channelWithContext(droppedCc = false) {
  const channel = getChannelFactory('webhook')!({
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('missing webhook channel');
  expect(
    channel.restoreDeliveryContext?.(jid, {
      type: 'webhook-email-v1',
      bodyEvidenceVersion: 1,
      bodyAddresses: [],
      from: email.to,
      subject: email.subject,
      messageId: '',
      kbConflictSnapshot: { files: {} },
      allowlistSnapshot: { ...allowlist, senders: [...allowlist.senders] },
      ...(droppedCc
        ? {
            ccContext: {
              botInTo: true,
              realTo: 'program@example.org',
              realCc: 'other_person@example.org',
              ccOnly: false,
              suppressAck: false,
              reason: 'direct',
            },
          }
        : {}),
    }),
  ).toBe(true);
  return channel;
}

async function preparedReply(
  body: string,
  droppedCc = false,
): Promise<PreparedDelivery> {
  const channel = channelWithContext(droppedCc);
  const checked = channel.gateProfile.validate(`<reply>${body}</reply>`, {
    allowlist,
    inboundText: [],
  });
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw new Error('unexpected early refusal');
  const prepared = await channel.prepareDelivery(
    jid,
    checked.text,
    'r4-prepared',
    { allowlist, inboundText: [] },
  );
  expect(prepared.status).toBe('prepared');
  if (prepared.status !== 'prepared')
    throw new Error('unexpected preparation failure');
  return prepared.delivery;
}

function savedReplay(delivery: PreparedDelivery): PreparedDelivery {
  expect(
    saveDeliveryState({
      version: 1,
      phase: 'transport-pending',
      chatJid: jid,
      targetTimestamp: now,
      previousCursor: '',
      context: {},
      outcomeId: delivery.deliveryId,
      trustedBodyAddresses: [],
      prepared: delivery,
      replyText: 'Contact',
      attempt: 1,
      createdAt: now,
    }),
  ).toEqual({ status: 'saved' });
  const loaded = loadDeliveryState(jid);
  expect(loaded.status).toBe('valid');
  if (loaded.status !== 'valid' || loaded.state.phase !== 'transport-pending')
    throw new Error('missing saved transport');
  return loaded.state.prepared;
}

beforeEach(() => {
  _initTestDatabase();
  outbox = new MemoryOutboxStore();
  _resetOutboundEmailQueueForTests(outbox);
  _setStaggerMsForTests(0);
  mockFetch
    .mockReset()
    .mockResolvedValue({ ok: true, json: async () => ({ id: 'r4-provider' }) });
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _closeDatabase();
});

// R4-2/C: underscores inside words and a closing-only underscore before @ must never pair across distinct contacts.
it.each([
  'Contact advisor_@example.org and other_person@example.org.',
  'Contact other_person@example.org and advisor_@example.org.',
  'Contact other__person@example.org and __person@example.edu__.',
])(
  'preserves actual address underscores in host and container formatting: %s',
  (text) => {
    const expected = text.replace(
      '__person@example.edu__',
      'person@example.edu',
    );
    expect(formatter.stripMarkdown(text)).toBe(expected);
    expect(containerFormatter.stripMarkdown(text)).toBe(expected);
  },
);

// R4-2: exact review sequence through validation, note append, actual provider and signed saved-transport replay.
it.each([false, true])(
  'keeps advisor_ unchanged after dropped-CC disclosure (saved replay: %s)',
  async (replay) => {
    let delivery = await preparedReply('Contact advisor_@example.org', true);
    if (replay) delivery = savedReplay(delivery);
    expect(await channelWithContext().deliverPrepared(delivery)).toMatchObject({
      status: 'sent',
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body).text;
    expect(body).toBe(
      "Contact advisor_@example.org\n\nNote: this reply was not copied to other_person@example.org from the original thread — Coordinator can only email addresses on the program's authorized recipient list.",
    );
    expect(body).not.toContain('advisor@example.org');
  },
);

// R4-2: reviewer's two-address scheduled message must not become a permanently refused bulk row.
it('sends both approved underscore contacts unchanged in a durable scheduled bulk message', async () => {
  const body = 'Contact advisor_@example.org and other_person@example.org.';
  const result = await sendOutboundEmailResult(
    { ...email, subject: 'Monday reminder', body },
    {
      ...options,
      deliveryId: 'r4-bulk',
      lane: 'bulk',
      allowlistState: {
        ...allowlist,
        senders: new Set([...allowlist.senders, 'other_person@example.org']),
      },
    },
  );
  expect(result).toEqual({ status: 'sent', resendId: 'r4-provider' });
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).text).toBe(body);
  expect(outbox.get('r4-bulk')?.status).toBe('sent');
});

// R4-A: a controlled final formatting change reproduces scan/sent disagreement on every entry path, independent of any specific formatter defect.
it.each([
  'direct',
  'reply',
  'prepared-replay',
  'outbox-replay',
  'send_email',
] as const)(
  'refuses an address introduced by final formatting on %s, without formatting that final text again',
  async (path) => {
    const delivery =
      path === 'reply' || path === 'prepared-replay'
        ? await preparedReply(email.body)
        : undefined;
    const replay =
      path === 'prepared-replay' && delivery ? savedReplay(delivery) : delivery;
    const original = formatter.stripMarkdown;
    let bodyFormats = 0;
    vi.spyOn(formatter, 'stripMarkdown').mockImplementation((text) => {
      if (text === email.body && ++bodyFormats === 2)
        return 'Contact invented@example.org';
      // Reformatting the final bytes would conceal the invented address again.
      if (text === 'Contact invented@example.org') return email.body;
      return original(text);
    });
    if (replay) {
      expect(await channelWithContext().deliverPrepared(replay)).toMatchObject({
        status: 'failed',
        retryable: false,
        reason: expect.stringContaining('invented@example.org'),
      });
    } else if (path === 'outbox-replay') {
      outbox.insert({
        deliveryId: 'r4-replayed-row',
        lane: 'transactional',
        status: 'pending',
        email,
        sendOptions: {
          ...options,
          allowlistState: { ...allowlist, senders: [...allowlist.senders] },
        },
        intended: [email.to],
        createdAt: now,
        updatedAt: now,
      });
      startOutboundEmailQueue();
      await vi.waitFor(() =>
        expect(['sent', 'dead-letter']).toContain(
          outbox.get('r4-replayed-row')?.status,
        ),
      );
      expect(outbox.get('r4-replayed-row')).toMatchObject({
        status: 'dead-letter',
        result: {
          reason: expect.stringContaining('invented@example.org'),
          retryable: false,
        },
      });
    } else if (path === 'send_email') {
      await processTaskIpc({ type: 'send_email', ...email }, 'main', true, {
        sendMessage: vi.fn(),
        registeredGroups: () => ({}),
        registerGroup: vi.fn(),
        syncGroups: vi.fn(),
        getAvailableGroups: () => [],
        writeGroupsSnapshot: vi.fn(),
        onTasksChanged: vi.fn(),
      });
    } else {
      expect(
        await sendOutboundEmailResult(email, {
          ...options,
          deliveryId: 'r4-final-direct',
        }),
      ).toMatchObject({
        status: 'failed',
        retryable: false,
        reason: expect.stringContaining('invented@example.org'),
      });
    }
    expect(bodyFormats).toBe(2);
    expect(mockFetch).not.toHaveBeenCalled();
  },
);

const r5Task = {
  id: 'r5-outreach',
  group_folder: 'main',
  chat_jid: 'tg-fixture',
  prompt: 'Weekly digest',
  schedule_type: 'once' as const,
  schedule_value: now,
  context_mode: 'group' as const,
  next_run: now,
  last_run: null,
  last_result: null,
  status: 'active' as const,
  created_at: now,
};
// R5-1/2: reviewer sequences at actual provider entry points; saved rows already admitted by old code still carry current empty evidence and must be refused.
it.each(
  [
    '"invented"@example.org',
    'invented@example.xn--p1ai',
    'person@example.edué',
    // R6-1: a www. local part is a mailbox, not an exempt URL.
    'www.contact@example.org',
    // R6-2/3: delimiters and unmatched wrappers must not approve another mailbox.
    'fake|person@example.edu',
    'fake`person@example.edu',
    "'person@example.edu",
    // R7-1/2: URL/handle exemptions cannot cover a separate contact token.
    'www.example.org/<contact@example.org>',
    '@handle-contact@example.org',
    '@handle.name<contact@example.org>',
    // R8-1: mismatched URL parentheses expose a separate mail link.
    'www.example.org/)(contact@example.org)',
    'https://example.org/(contact@example.org!',
    // R11-1: normalize Unicode domain punctuation and full-width @ before final detection.
    'contact@example。org',
    'contact@example．org',
    'contact@example｡org',
    'contact＠example.org',
    // R10: require dotted nonempty hostname labels and no address-adjacent opening wrapper.
    'www./(contact@example.org)',
    'https://example.org../(contact@example.org)',
    'https://example.org/(contact@example.org)',
    'https://github.com/search?q=(person@example.edu)',
    "https://example.org/people/o'person@example.edu",
    'http://[::1]/@handle.name',
    // R9-1: ambiguous URI punctuation must not hide a separate mail link.
    'www.example.org/｜contact@example.org',
    "www.example.org/'(contact@example.org)",
  ].flatMap((token) =>
    (
      [
        'direct',
        'prepared-replay',
        'outbox-replay',
        'send_email',
        'scheduled',
      ] as const
    ).map((path) => [token, path] as const),
  ),
)('refuses raw token %s on %s before the provider', async (token, path) => {
  const badEmail = { ...email, body: `Contact ${token}` };
  if (path === 'prepared-replay') {
    const delivery = savedReplay({
      channel: 'webhook',
      deliveryId: 'r5-saved',
      jid,
      payload: {
        email: badEmail,
        options: {
          ...options,
          allowlistState: { ...allowlist, senders: [...allowlist.senders] },
        },
      },
    });
    expect(await channelWithContext().deliverPrepared(delivery)).toMatchObject({
      status: 'failed',
      retryable: false,
      reason: expect.stringContaining(token),
    });
  } else if (path === 'outbox-replay') {
    outbox.insert({
      deliveryId: 'r5-row',
      lane: 'transactional',
      status: 'pending',
      email: badEmail,
      sendOptions: {
        ...options,
        allowlistState: { ...allowlist, senders: [...allowlist.senders] },
      },
      intended: [email.to],
      createdAt: now,
      updatedAt: now,
    });
    startOutboundEmailQueue();
    await vi.waitFor(() =>
      expect(['sent', 'dead-letter']).toContain(outbox.get('r5-row')?.status),
    );
    expect(outbox.get('r5-row')).toMatchObject({
      status: 'dead-letter',
      result: { reason: expect.stringContaining(token), retryable: false },
    });
  } else if (path === 'send_email') {
    await processTaskIpc({ type: 'send_email', ...badEmail }, 'main', true, {
      sendMessage: vi.fn(),
      registeredGroups: () => ({}),
      registerGroup: vi.fn(),
      syncGroups: vi.fn(),
      getAvailableGroups: () => [],
      writeGroupsSnapshot: vi.fn(),
      onTasksChanged: vi.fn(),
    });
  } else if (path === 'scheduled') {
    expect(
      await processOutreachResult(
        r5Task,
        JSON.stringify({ emails: [badEmail] }),
        vi.fn(),
        [email.to],
      ),
    ).toContain('1 blocked/failed');
  } else {
    expect(
      await sendOutboundEmailResult(badEmail, {
        ...options,
        deliveryId: 'r5-direct',
      }),
    ).toMatchObject({
      status: 'failed',
      retryable: false,
      reason: expect.stringContaining(token),
    });
  }
  expect(mockFetch).not.toHaveBeenCalled();
});
// R5-1: same quoted-local token must be caught by normal reply validation and channel preparation, with the original token named.
it('refuses a double-quoted local-part token in the ordinary reply and preparation', async () => {
  const body = 'Contact "invented"@example.org';
  expect(
    emailProfile.validate(`<reply>${body}</reply>`, {
      allowlist,
      inboundText: [],
    }),
  ).toMatchObject({ ok: false, addresses: ['"invented"@example.org'] });
  expect(
    await channelWithContext().prepareDelivery(jid, body, 'r5-normal', {
      allowlist,
      inboundText: [],
    }),
  ).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('"invented"@example.org'),
  });
});
// R5-4: actual weekly-digest processing and bulk persistence must not dead-letter approved table contacts or email-like URL query strings.
it.each([
  'Reference: https://github.com/search?q=person@example.edu',
  '|Owner|Email|\n|---|---|\n|Person|person@example.edu|',
  'Reference: http://example.org/search?q=person@example.edu',
  'Reference: www.example.org/search?q=person@example.edu',
  'Telegram @ProgramBot',
])('delivers the scheduled digest unchanged: %s', async (body) => {
  expect(
    await processOutreachResult(
      r5Task,
      JSON.stringify({ emails: [{ ...email, body }] }),
      vi.fn(),
      [email.to],
    ),
  ).toContain('1 sent, 0 blocked/failed');
  expect(mockFetch).toHaveBeenCalledOnce();
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).text).toBe(body);
  expect(outbox.listAll()[0].status).toBe('sent');
});

// R7-3: a retained exact token must never become a shorter trusted address at the final send boundary.
it.each(['|fake|advisor@example.org|', 'mailto:advisor@example.org'])(
  'does not reparse retained evidence %s on a direct send',
  async (stored) => {
    expect(
      await sendOutboundEmailResult(
        { ...email, body: 'Contact advisor@example.org' },
        {
          ...options,
          deliveryId: 'r7-exact-evidence',
          trustedBodyAddresses: [stored],
        },
      ),
    ).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('advisor@example.org'),
    });
    expect(mockFetch).not.toHaveBeenCalled();
  },
);

// R11-1: normalization is detection-only; the provider receives the original Unicode spelling.
it.each([
  'person@example。edu',
  'person＠example.edu',
  'ｐｅｒｓｏｎ＠ｅｘａｍｐｌｅ．ｅｄｕ',
])(
  'sends trusted normalized identity %s without changing provider bytes',
  async (address) => {
    const body = `Please email ${address} for details.`;
    expect(
      await sendOutboundEmailResult(
        { ...email, body },
        { ...options, deliveryId: 'r11-preserve-unicode' },
      ),
    ).toMatchObject({ status: 'sent' });
    const request = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(request.text).toBe(body);
  },
);
