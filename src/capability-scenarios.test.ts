/**
 * Capability Scenarios — end-to-end coverage for the Program instance ("Coordinator").
 *
 * Each scenario is a realistic narrative that flows through the same module
 * seams production uses, in production order (see webhook.ts: allowlist →
 * loop-guard → thread-derivation), rather than asserting one function in
 * isolation. Plan, success criteria, and evaluation method live in
 * docs/capability-scenarios.md.
 *
 * Hermetic: Resend (fetch), .env, and the pinned-SHA repo mirror are stubbed
 * identically for every run, so no scenario depends on network, wall-clock, or
 * a real program-repo checkout.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// --- Hermetic stubs (mirror ipc-send-email.test.ts so outbound runs offline) ---

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({
    RESEND_API_KEY: 'test-resend-key',
    SEND_FROM_NAME: 'Coordinator',
    SEND_FROM_EMAIL: 'program@example.org',
    OPERATOR_CC_EMAIL: 'avery@example.edu',
  })),
}));

// Pilot personas — the allowlist the outbound path sees. Real canProcessEmailSender
// logic is kept; only the source read is stubbed.
const ALLOWLISTED = new Set([
  'robin.keller@example.edu',
  'dana.ortega@example.edu',
  'nora.adl@example.edu',
  'tessa.bowen@example.edu',
  'user112@example.edu', // Wally Oakes (research observer)
  'user103@example.edu', // Gabe Lowe (research observer)
  'avery@example.edu',
]);

vi.mock('./channels/webhook-allowlist.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('./channels/webhook-allowlist.js')>();
  return {
    ...original,
    loadEmailAllowlistFrom: vi.fn(() => ({
      available: true,
      senders: new Set(ALLOWLISTED),
      source: 'program/EMAIL_ALLOWLIST.md',
    })),
    loadEmailAllowlistFromAsync: vi.fn(async () => ({
      available: true,
      senders: new Set(ALLOWLISTED),
      source: 'program/EMAIL_ALLOWLIST.md',
    })),
  };
});

vi.mock('./repo-reader.js', () => ({
  getRepoReader: vi.fn(() => ({
    readFile: () => null,
    exists: () => false,
    refresh: () => ({ advanced: false, sha: null }),
  })),
}));

import {
  canProcessEmailSender,
  parseEmailAllowlist,
  type EmailAllowlistState,
  type EmailAllowlistFallbackMode,
} from './channels/webhook-allowlist.js';
import { isAutoReplyEml } from './email-loop-detection.js';
import { deriveEmailChatJid } from './channels/webhook-threading.js';
import {
  _resetOutboundEmailQueueForTests,
  _setStaggerMsForTests,
  sendOutboundEmail,
} from './outbound-email.js';
import { MemoryOutboxStore } from './outbound-email-outbox.js';
import {
  isProtectedTaskMutation,
  parseOutreachBatch,
} from './send-email-capability.js';
import {
  isSafeAttachmentName,
  safeAttachmentName,
} from './attachment-safety.js';
import { extractDocument } from './document-extractor.js';
import {
  canProcessTelegramSender,
  parseTelegramAllowlist,
} from './channels/telegram-allowlist.js';
import {
  deriveWebChatChatJid,
  isDerivedWebChatJid,
  normalizeWebChatSessionId,
} from './channels/web-chat-session.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  makeSensorId,
  parseActionItemSections,
  parseVerdict,
  placeholderFor,
  shouldSkipSensor,
  failTypeFromDesc,
} from './behaviour-sensor.js';
import { buildExceptionsReport } from './exceptions-report.js';
import { computeNextRun } from './task-scheduler.js';
import { isWeekendCalendarDate, weekdayOfCalendarDate } from './timezone.js';
import {
  resolveKbTriageApproverCc,
  snapshotKbConflictTriage,
} from './channels/kb-triage-cc.js';
import { ScheduledTask } from './types.js';

// --- Shared fixtures ---------------------------------------------------------

/**
 * A real EMAIL_ALLOWLIST.md: an email table AND a Telegram-handle section in
 * one file (the production layout). Exercises that neither parser scrapes the
 * other's rows.
 */
const ALLOWLIST_MD = `# Authorized Senders

| Name | Email |
|------|-------|
| Robin Keller | robin.keller@example.edu |
| Dana Ortega | dana.ortega@example.edu |
| Avery | avery@example.edu |

## Telegram Handles

| Name | Handle |
|------|--------|
| Avery | @operatorprogram |
| Robin | @rkeller |
`;

const inboundAllowlist: EmailAllowlistState = {
  available: true,
  senders: parseEmailAllowlist(ALLOWLIST_MD),
  source: 'program/EMAIL_ALLOWLIST.md',
};

let tmpDir: string;

function writeEml(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content.replace(/\n/g, '\r\n'), 'utf-8');
  return p;
}

type IngestDecision =
  | { action: 'reject-sender'; reason: string }
  | { action: 'drop-loop'; reason: string }
  | { action: 'accept'; chatJid: string };

/**
 * The webhook's inbound decision flow, composed in production order
 * (webhook.ts): sender allowlist → auto-reply/loop guard → thread JID.
 */
async function ingestEmail(opts: {
  emlPath: string;
  from: string;
  subject: string;
  messageId?: string;
  allowlist?: EmailAllowlistState;
  fallback?: EmailAllowlistFallbackMode;
}): Promise<IngestDecision> {
  const access = canProcessEmailSender(
    opts.from,
    opts.allowlist ?? inboundAllowlist,
    opts.fallback ?? 'closed',
  );
  if (!access.allowed) {
    return { action: 'reject-sender', reason: access.reason ?? 'denied' };
  }

  const loop = await isAutoReplyEml(opts.emlPath);
  if (loop.isAutoReply) {
    return { action: 'drop-loop', reason: loop.reason ?? 'auto-reply' };
  }

  const chatJid = deriveEmailChatJid({
    rawFilePath: opts.emlPath,
    messageId: opts.messageId,
    subject: opts.subject,
    from: opts.from,
  });
  return { action: 'accept', chatJid };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-scenarios-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
  _setStaggerMsForTests(0);
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ id: 'resend-test-id' }),
  });
});

// --- A. Inbound email decision pipeline -------------------------------------

describe('Inbound email pipeline', () => {
  it('S01: allowlisted faculty reply is accepted with a stable thread JID', async () => {
    const eml = writeEml(
      's01.eml',
      `From: Robin Keller <robin.keller@example.edu>
Subject: Re: Weekly action item check-in
Message-ID: <reply-s01@example.edu>
References: <outreach-orig@example.org>
In-Reply-To: <outreach-orig@example.org>

Three updates: roster finalized, syllabus posted, office hours set.
`,
    );

    const decision = await ingestEmail({
      emlPath: eml,
      from: 'robin.keller@example.edu',
      subject: 'Re: Weekly action item check-in',
      messageId: '<reply-s01@example.edu>',
    });

    expect(decision.action).toBe('accept');
    // Continuity: thread JID follows the original message-id, not the reply's.
    expect(decision).toMatchObject({
      chatJid: 'webhook-email:outreach-orig@example.org',
    });
  });

  it('S02: unknown external sender is rejected fail-closed (no JID assigned)', async () => {
    const eml = writeEml(
      's02.eml',
      `From: Stranger <stranger@gmail.com>
Subject: Partnership opportunity
Message-ID: <spam-s02@gmail.com>

Hello, I would like to discuss a partnership.
`,
    );

    const decision = await ingestEmail({
      emlPath: eml,
      from: 'stranger@gmail.com',
      subject: 'Partnership opportunity',
      messageId: '<spam-s02@gmail.com>',
    });

    expect(decision).toEqual({
      action: 'reject-sender',
      reason: 'sender not on allowlist',
    });
  });

  it('S03: allowlisted sender Outlook OOO is dropped despite being allowlisted', async () => {
    // The loop guard runs even for allowlisted senders — an OOO from a real
    // colleague is exactly the ping-pong case it exists to stop.
    const eml = writeEml(
      's03.eml',
      `From: Dana Ortega <dana.ortega@example.edu>
Subject: Automatic reply: Weekly action item check-in
Message-ID: <ooo-s03@example.edu>
Auto-Submitted: auto-replied
X-Auto-Response-Suppress: All

I am out of the office until Monday with limited email access.
`,
    );

    const decision = await ingestEmail({
      emlPath: eml,
      from: 'dana.ortega@example.edu',
      subject: 'Automatic reply: Weekly action item check-in',
      messageId: '<ooo-s03@example.edu>',
    });

    expect(decision.action).toBe('drop-loop');
  });

  it('S04: listserv / autoresponder traffic is dropped (List-Id, X-Autoreply)', async () => {
    const listEml = writeEml(
      's04-list.eml',
      `From: Faculty List <list@example.edu>
Subject: [program-faculty] Weekly bulletin
Message-ID: <bulletin-s04@example.edu>
List-Id: Program Faculty <faculty.example.edu>

Weekly bulletin contents.
`,
    );
    const autoEml = writeEml(
      's04-auto.eml',
      `From: Tessa Bowen <tessa.bowen@example.edu>
Subject: Re: check-in
Message-ID: <auto-s04@example.edu>
X-Autoreply: yes

Auto: thanks for your message.
`,
    );

    // List sender isn't allowlisted, but if it were the loop guard still catches it;
    // assert the loop guard directly to isolate the capability.
    expect((await isAutoReplyEml(listEml)).isAutoReply).toBe(true);

    const autoDecision = await ingestEmail({
      emlPath: autoEml,
      from: 'tessa.bowen@example.edu', // pretend allowlisted to prove guard order
      subject: 'Re: check-in',
      messageId: '<auto-s04@example.edu>',
      allowlist: {
        available: true,
        senders: new Set(['tessa.bowen@example.edu']),
        source: 'x',
      },
    });
    expect(autoDecision.action).toBe('drop-loop');
  });

  it('S05: allowlist outage — closed fallback rejects, permissive fallback accepts', async () => {
    const eml = writeEml(
      's05.eml',
      `From: Robin Keller <robin.keller@example.edu>
Subject: Quick question
Message-ID: <q-s05@example.edu>

What's the deadline?
`,
    );
    const unavailable: EmailAllowlistState = {
      available: false,
      senders: new Set(),
      source: 'program/EMAIL_ALLOWLIST.md',
    };

    const closed = await ingestEmail({
      emlPath: eml,
      from: 'robin.keller@example.edu',
      subject: 'Quick question',
      allowlist: unavailable,
      fallback: 'closed',
    });
    expect(closed).toMatchObject({ action: 'reject-sender' });

    const permissive = await ingestEmail({
      emlPath: eml,
      from: 'robin.keller@example.edu',
      subject: 'Quick question',
      allowlist: unavailable,
      fallback: 'permissive',
    });
    expect(permissive.action).toBe('accept');
  });
});

// --- B. Thread continuity ----------------------------------------------------

describe('Email thread derivation', () => {
  it('S06: a reply carrying References lands on the original conversation JID', () => {
    const originalEml = writeEml(
      's06-orig.eml',
      `From: Coordinator <program@example.org>
Subject: Weekly action item check-in
Message-ID: <thread-root-s06@example.org>

Please reply with your three updates.
`,
    );
    const replyEml = writeEml(
      's06-reply.eml',
      `From: Nora Adl <nora.adl@example.edu>
Subject: Re: Weekly action item check-in
Message-ID: <reply-s06@example.edu>
References: <thread-root-s06@example.org>

Done — see attached.
`,
    );

    const rootJid = deriveEmailChatJid({
      rawFilePath: originalEml,
      messageId: '<thread-root-s06@example.org>',
      subject: 'Weekly action item check-in',
      from: 'program@example.org',
    });
    const replyJid = deriveEmailChatJid({
      rawFilePath: replyEml,
      messageId: '<reply-s06@example.edu>',
      subject: 'Re: Weekly action item check-in',
      from: 'nora.adl@example.edu',
    });

    expect(replyJid).toBe(rootJid);
    expect(replyJid).toBe('webhook-email:thread-root-s06@example.org');
  });

  it('S07: a fresh email with no references gets a stable synthetic from|subject JID', () => {
    const a = deriveEmailChatJid({
      from: 'Robin Keller <robin.keller@example.edu>'.match(/<(.+)>/)![1],
      subject: 'New advising question',
    });
    const b = deriveEmailChatJid({
      from: 'robin.keller@example.edu',
      subject: 'Re: New advising question', // a later reply normalizes to same key
    });
    expect(a).toBe(
      'webhook-email:robin.keller@example.edu|new advising question',
    );
    expect(b).toBe(a);
  });
});

// --- C. Allowlist parsing (source of truth) ---------------------------------

describe('Allowlist parsing', () => {
  it('S08: email table and Telegram-handle section parse without cross-contamination', () => {
    const emails = parseEmailAllowlist(ALLOWLIST_MD);
    const handles = parseTelegramAllowlist(ALLOWLIST_MD);

    expect(emails.has('robin.keller@example.edu')).toBe(true);
    expect(emails.has('avery@example.edu')).toBe(true);
    // A Telegram handle is not an email address.
    expect(emails.has('operatorprogram')).toBe(false);

    expect(handles.has('operatorprogram')).toBe(true);
    expect(handles.has('rkeller')).toBe(true);
    // The email addresses in the table must NOT be scraped as handles.
    expect([...handles].some((h) => h.includes('example'))).toBe(false);
    expect(handles.has('avery')).toBe(false);
  });
});

// --- D. Outbound email (host send; Resend mocked) ---------------------------

describe('Outbound email', () => {
  it('S09: a single allowlisted send produces one Resend call with bot Reply-To', async () => {
    const ok = await sendOutboundEmail(
      {
        to: 'robin.keller@example.edu',
        subject: 'Re: Weekly action item check-in',
        body: 'Thanks Robin — recorded your three updates.',
      },
      { sourceGroup: 'program-email', forceBotReplyTo: false },
    );

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.to).toEqual(['robin.keller@example.edu']);
    expect(payload.reply_to).toBe('program@example.org');
    expect(payload.from).toContain('program@example.org');
  });

  it('S10: the observer digest goes to both observers in one send', async () => {
    const ok = await sendOutboundEmail(
      {
        to: 'user112@example.edu, user103@example.edu',
        subject: 'Pilot observer digest — week of 6/19',
        body: 'System changes this week: ...',
      },
      { sourceGroup: 'program-telegram', forceBotReplyTo: false },
    );

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.to).toEqual(['user112@example.edu', 'user103@example.edu']);
  });

  it('S11: a multi-To send aborts entirely if any recipient is not allowlisted', async () => {
    const ok = await sendOutboundEmail(
      {
        to: 'user112@example.edu, stranger@gmail.com',
        subject: 'Pilot observer digest',
        body: '...',
      },
      { sourceGroup: 'program-telegram', forceBotReplyTo: false },
    );

    expect(ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('S12: a non-allowlisted CC is dropped but the To-only send still proceeds', async () => {
    const ok = await sendOutboundEmail(
      {
        to: 'robin.keller@example.edu',
        cc: 'outsider@gmail.com',
        subject: 'Re: question',
        body: '...',
      },
      { sourceGroup: 'program-email', forceBotReplyTo: false },
    );

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.to).toEqual(['robin.keller@example.edu']);
    expect(payload.cc).toBeUndefined();
  });

  it('S13: forceBotReplyTo overrides an injected reply_to (anti-redirect)', async () => {
    const ok = await sendOutboundEmail(
      {
        to: 'robin.keller@example.edu',
        subject: 'Weekly nudge',
        body: '...',
        reply_to: 'attacker@evil.com',
      },
      { sourceGroup: 'program-email', forceBotReplyTo: true },
    );

    expect(ok).toBe(true);
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.reply_to).toBe('program@example.org');
  });
});

// --- E. Outreach capability gating ------------------------------------------

describe('Outreach capability', () => {
  it('S14: outreach batch parses from fenced and bare JSON; a malformed entry is rejected', () => {
    const fenced = parseOutreachBatch(
      'Here is the batch:\n```json\n' +
        JSON.stringify({
          emails: [
            { to: 'robin.keller@example.edu', subject: 'Hi', body: 'B' },
          ],
          summary: '1 nudge',
        }) +
        '\n```\n',
    );
    expect(fenced?.emails).toHaveLength(1);
    expect(fenced?.summary).toBe('1 nudge');

    const bare = parseOutreachBatch(
      JSON.stringify({
        emails: [{ to: 'a@example.edu', subject: 's', body: 'b' }],
      }),
    );
    expect(bare?.emails).toHaveLength(1);
    expect(bare?.summary).toBe('(no summary provided)');

    // Entry missing `body` → whole batch rejected (fail-loud at the caller).
    const malformed = parseOutreachBatch(
      JSON.stringify({ emails: [{ to: 'a@example.edu', subject: 's' }] }),
    );
    expect(malformed).toBeNull();
  });

  it('S15: the approved outreach task is protected from non-main mutation', () => {
    const prev = process.env.EMAIL_OUTREACH_TASK_ID;
    process.env.EMAIL_OUTREACH_TASK_ID = 'approved-outreach';
    try {
      // A non-main group (e.g. program-email container) may not mutate it.
      expect(isProtectedTaskMutation('approved-outreach', false)).toBe(true);
      // The host / main group owns its lifecycle.
      expect(isProtectedTaskMutation('approved-outreach', true)).toBe(false);
      // Any other task id is unprotected.
      expect(isProtectedTaskMutation('some-other-task', false)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EMAIL_OUTREACH_TASK_ID;
      else process.env.EMAIL_OUTREACH_TASK_ID = prev;
    }
  });
});

// --- F. Attachment & document safety ----------------------------------------

describe('Attachment & document safety', () => {
  it('S16: a path-traversal attachment name is replaced with a safe fallback', () => {
    expect(isSafeAttachmentName('../../etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('roster.xlsx')).toBe(true);

    const rejections: string[] = [];
    const safe = safeAttachmentName('../../etc/passwd', 'attachment', (raw) =>
      rejections.push(raw),
    );
    expect(safe).not.toBe('../../etc/passwd');
    expect(safe.startsWith('attachment-')).toBe(true);
    expect(rejections).toEqual(['../../etc/passwd']);

    // A safe name is passed through untouched.
    expect(safeAttachmentName('syllabus.pdf')).toBe('syllabus.pdf');
  });

  it('S17: documents extract by type; unsupported & oversize return messages', async () => {
    const csv = await extractDocument(
      Buffer.from('owner,open\nRobin,3\nDana,5\n', 'utf-8'),
      'action-items.csv',
    );
    expect(csv.fullText).toContain('Robin,3');

    const txt = await extractDocument(
      Buffer.from('hello world', 'utf-8'),
      'note.txt',
    );
    expect(txt.fullText).toBe('hello world');

    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Owner', 'Open'],
      ['Robin', 3],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Items');
    const xlsxBuf = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;
    const xlsx = await extractDocument(xlsxBuf, 'tracker.xlsx');
    expect(xlsx.sheets).toEqual(['Items']);
    expect(xlsx.fullText).toContain('Owner');

    const unsupported = await extractDocument(Buffer.from('x'), 'archive.zip');
    expect(unsupported.fullText).toBe('[Unsupported file type: .zip]');

    // limit + 1 exercises the >20MB branch without allocating a full extra MB.
    const oversize = await extractDocument(
      Buffer.alloc(20 * 1024 * 1024 + 1),
      'huge.pdf',
    );
    expect(oversize.fullText).toContain('too large');
  });
});

// --- G. Channel identity & allowlists ---------------------------------------

describe('Channel identity & allowlists', () => {
  it('S18: Telegram allowlist matches a known handle and drops a no-username sender', () => {
    const state = {
      available: true,
      handles: parseTelegramAllowlist(ALLOWLIST_MD),
      source: 'program/EMAIL_ALLOWLIST.md',
    };
    expect(
      canProcessTelegramSender('@operatorprogram', state, 'closed').allowed,
    ).toBe(true);
    expect(
      canProcessTelegramSender('operatorprogram', state, 'closed').allowed,
    ).toBe(true);
    expect(
      canProcessTelegramSender('randomuser', state, 'closed').allowed,
    ).toBe(false);
    // Telegram usernames are optional; no username → dropped in closed mode.
    expect(canProcessTelegramSender(undefined, state, 'closed').allowed).toBe(
      false,
    );
  });

  it('S19: a messy web-chat session id normalizes to a stable, recognized JID', () => {
    const sessionId = normalizeWebChatSessionId('  Visitor #42!! <script> ');
    expect(sessionId).toBe('Visitor42script');
    const jid = deriveWebChatChatJid(sessionId);
    expect(jid).toBe('web-chat:Visitor42script');
    expect(isDerivedWebChatJid(jid)).toBe(true);
    expect(isDerivedWebChatJid('webhook-email:foo')).toBe(false);
    // Same input → same JID (session continuity for the read-only FAQ channel).
    expect(
      deriveWebChatChatJid(
        normalizeWebChatSessionId('  Visitor #42!! <script> '),
      ),
    ).toBe(jid);
  });

  it('S20: chat-config allowlist honours drop mode and per-chat trigger gating', () => {
    const cfgPath = path.join(tmpDir, 'sender-allowlist.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        default: { allow: '*', mode: 'trigger' },
        chats: {
          'noisy@g.us': { allow: [], mode: 'drop' },
          'team@g.us': { allow: ['+15551234567'], mode: 'trigger' },
        },
        logDenied: true,
      }),
      'utf-8',
    );
    const cfg = loadSenderAllowlist(cfgPath);

    // drop-mode chat: messages are dropped wholesale.
    expect(shouldDropMessage('noisy@g.us', cfg)).toBe(true);
    expect(shouldDropMessage('team@g.us', cfg)).toBe(false);

    // per-chat trigger allowlist.
    expect(isSenderAllowed('team@g.us', '+15551234567', cfg)).toBe(true);
    expect(isSenderAllowed('team@g.us', '+15559999999', cfg)).toBe(false);

    // default chat allows everyone.
    expect(isSenderAllowed('other@g.us', 'anyone', cfg)).toBe(true);
  });
});

// --- H. Behaviour sensor -----------------------------------------------------

describe('Behaviour sensor', () => {
  const ACTION_ITEMS = `# Action Items

## Robin Keller
- [ ] Finalize roster
- [x] Post syllabus
- [ ] Set office hours

## Dana Ortega
- [ ] Submit grades
`;

  it('S21: per-owner open-count is deterministic (feeds action_item_counts.json)', () => {
    const sections = parseActionItemSections(ACTION_ITEMS);
    const robin = sections.find((s) => s.owner === 'Robin Keller');
    const dana = sections.find((s) => s.owner === 'Dana Ortega');
    // Deterministic count from the structure (the R1 count-anchoring fix):
    // open items are `- [ ]`, completed `- [x]` are not counted. Since the
    // G40 scope revert this parser feeds only the outreach
    // counts artifact — the sensor classifies tracking-state replies out of
    // scope instead of verifying them.
    expect(robin?.openCount).toBe(2);
    expect(dana?.openCount).toBe(1);
  });

  it('S22: verdicts parse to annotations; trivial / lore replies skip the sensor', () => {
    expect(parseVerdict('PASS').annotation).toBe('[sensor: pass]');

    const flag = parseVerdict('FLAG: curriculum.md still shows ToolAlpha');
    expect(flag.isFail).toBe(false);
    expect(flag.annotation).toContain('[sensor: flag:');

    const fail = parseVerdict(
      'FAIL: Applied Topics is Draft, not Core | type: factual',
    );
    expect(fail.isFail).toBe(true);
    expect(fail.annotation).toContain('[sensor: fail —');
    expect(failTypeFromDesc(fail.desc)).toBe('factual');

    // Skip gate: empty / whitespace-only / lore-tagged replies are not checked.
    expect(shouldSkipSensor('')).toBe(true);
    expect(shouldSkipSensor('<internal>only internal</internal>')).toBe(true);
    expect(shouldSkipSensor('lore: intentional — this is a joke')).toBe(true);
    expect(shouldSkipSensor('The deadline is Friday.')).toBe(false);

    // The pending placeholder carries a unique id so concurrent sensors don't clash.
    const id = makeSensorId('09:00:00');
    expect(placeholderFor(id)).toBe(`[sensor: pending:${id}]`);
  });
});

// --- I. Exceptions digest ----------------------------------------------------

describe('Weekly exceptions digest', () => {
  const TZ = 'America/Chicago';
  const NOW = new Date('2026-06-19T17:00:00Z'); // 2026-06-19 12:00 CT

  function stubReader(files: Record<string, string>) {
    return {
      refresh: () => ({ advanced: false, sha: 'stub' }),
      readFile: (p: string) => files[p] ?? null,
      listDir: (dir: string) => {
        const prefix = `${dir}/`;
        const entries = new Set<string>();
        for (const key of Object.keys(files)) {
          if (key.startsWith(prefix))
            entries.add(key.slice(prefix.length).split('/')[0]);
        }
        return entries.size > 0 ? [...entries] : null;
      },
    };
  }

  it('S23: a clean week stays quiet; an exceptional week wakes the agent with samples', () => {
    const clean = buildExceptionsReport({
      reader: stubReader({
        'CLAUDE.md': '## KB Write Protocol\n\nrules',
        'discussions/audit-log/2026-06-19.md': '[sensor: pass]\n',
        'courses/crs554/sync/_last-synced.md':
          '**Last synced:** 2026-06-19 (auto)',
      }),
      taskRuns: [],
      pausedTasks: [],
      workingContextEntries: [],
      timeZone: TZ,
      now: NOW,
    });
    expect(clean.wakeAgent).toBe(false);

    const exceptional = buildExceptionsReport({
      reader: stubReader({
        'CLAUDE.md': '## KB Write Protocol\n\nrules',
        'discussions/audit-log/2026-06-19.md':
          '[sensor: fail — Applied Topics is Draft, not Core | type: factual]\n',
        'discussions/kb-triage/2026-06-12-conflicts.md': 'open hold',
        'courses/elc550/sync/_last-synced.md':
          '**Last synced:** 2026-06-04 (auto)',
      }),
      taskRuns: [],
      pausedTasks: [],
      workingContextEntries: [],
      timeZone: TZ,
      now: NOW,
    });
    expect(exceptional.wakeAgent).toBe(true);
    expect(exceptional.data.sensor.fail).toBe(1);
    expect(exceptional.data.sensor.samples.length).toBeGreaterThan(0);
    expect(exceptional.data.triage.openHolds.length).toBeGreaterThan(0);
    expect(exceptional.data.sync.stale.length).toBeGreaterThan(0);

    // Governance contract: if the referenced heading vanishes, that alone wakes.
    const contractBreak = buildExceptionsReport({
      reader: stubReader({
        'CLAUDE.md': '## Some Other Heading\n\nno protocol section',
        'discussions/audit-log/2026-06-19.md': '[sensor: pass]\n',
      }),
      taskRuns: [],
      pausedTasks: [],
      workingContextEntries: [],
      timeZone: TZ,
      now: NOW,
    });
    expect(contractBreak.wakeAgent).toBe(true);
    expect(contractBreak.data.notes.join(' ')).toContain('KB Write Protocol');
  });
});

// --- J. Scheduler & timezone -------------------------------------------------

describe('Scheduler & timezone', () => {
  it('S24: next-run is computed per schedule type; the weekday guard is exact', () => {
    const base: ScheduledTask = {
      id: 't',
      group_folder: 'program-email',
      chat_jid: 'webhook-email@program',
      prompt: 'p',
      schedule_type: 'once',
      schedule_value: '',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-06-19T00:00:00.000Z',
      last_run: null,
      last_result: null,
    };

    // computeNextRun() reads Date.now() (directly and via cron-parser); pin the
    // clock so the scenario is hermetic and date/timezone-independent.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T12:00:00.000Z')); // a Friday
    try {
      const now = Date.now();

      // A one-shot task has no next run.
      expect(computeNextRun({ ...base, schedule_type: 'once' })).toBeNull();

      // A cron task (Monday 08:00) yields a future ISO timestamp.
      const cronNext = computeNextRun({
        ...base,
        schedule_type: 'cron',
        schedule_value: '0 8 * * 1',
      });
      expect(cronNext).not.toBeNull();
      expect(new Date(cronNext!).getTime()).toBeGreaterThan(now);

      // An interval task anchored in the past skips forward into the future.
      const intervalNext = computeNextRun({
        ...base,
        schedule_type: 'interval',
        schedule_value: '60000',
        next_run: new Date(now - 5 * 60_000).toISOString(),
      });
      expect(new Date(intervalNext!).getTime()).toBeGreaterThan(now);
    } finally {
      vi.useRealTimers();
    }

    // Weekday guard ("Friday" must not land on a Saturday).
    // These are pure calendar-date functions, independent of the clock.
    expect(weekdayOfCalendarDate('2026-06-12')).toBe('Friday');
    expect(weekdayOfCalendarDate('2026-06-13')).toBe('Saturday');
    expect(isWeekendCalendarDate('2026-06-13')).toBe(true);
    expect(isWeekendCalendarDate('2026-06-12')).toBe(false);
  });
});

// --- K. KB-triage approver CC routing ---------------------------------------

describe('KB-triage approver CC', () => {
  const GATE_APPROVERS = `# Authorized Senders

| Name | Email | Role |
|------|-------|------|
| Avery **Gate Approver: content** | avery@example.edu | Director |
| Wren **Gate Approver: structure** | wren@example.edu | Program Lead |
`;

  function makeRepoWithConflict(text: string): string {
    const repo = fs.mkdtempSync(path.join(tmpDir, 'kb-repo-'));
    const triageDir = path.join(repo, 'discussions', 'kb-triage');
    fs.mkdirSync(triageDir, { recursive: true });
    fs.writeFileSync(
      path.join(triageDir, '2026-06-19-conflicts.md'),
      text,
      'utf-8',
    );
    return repo;
  }

  it('S25: a structure conflict routes to the structure approver, with self-CC fallback', () => {
    const conflictText = `## Conflict

**Category:** Onboarding & Prerequisites

The proposed start date shifts prerequisites into Spring 2031.`;

    // `before` is an empty snapshot → the whole file counts as "changed".
    const emptySnapshot = { files: {} };

    // A faculty sender (not an approver) → CC the structure approver, Wren.
    const repo1 = makeRepoWithConflict(conflictText);
    const cc1 = resolveKbTriageApproverCc({
      repoPath: repo1,
      before: emptySnapshot,
      allowlistContent: GATE_APPROVERS,
      senderEmail: 'robin.keller@example.edu',
    });
    expect(cc1).toBe('wren@example.edu');

    // When the sender IS the domain approver, fall back to the content approver.
    const repo2 = makeRepoWithConflict(conflictText);
    const cc2 = resolveKbTriageApproverCc({
      repoPath: repo2,
      before: emptySnapshot,
      allowlistContent: GATE_APPROVERS,
      senderEmail: 'wren@example.edu',
    });
    expect(cc2).toBe('avery@example.edu');

    // Sanity: snapshotting a repo records the conflict file.
    const snap = snapshotKbConflictTriage(repo1);
    expect(Object.keys(snap.files)).toContain(
      'discussions/kb-triage/2026-06-19-conflicts.md',
    );
  });
});
