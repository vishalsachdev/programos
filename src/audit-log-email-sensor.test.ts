/**
 * The reply sensor on email replies (SENSOR_EMAIL_REPLIES, off by default).
 *
 * The real sensor runs here with `fetch` mocked: no model endpoint is called.
 * The audit log and the triage files are written in a temporary host-owned
 * repository.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CURRICULUM = `# Program Curriculum

## Courses
- CRS 554 (Core)
- Applied Topics Studio (Draft, not yet approved as Core)
`;
const FILES: Record<string, string> = { 'program/curriculum.md': CURRICULUM };

vi.mock('./repo-reader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./repo-reader.js')>()),
  getRepoReader: () => ({
    refresh: () => ({ advanced: false, sha: 'stub-sha' }),
    readFile: (relPath: string) => FILES[relPath] ?? null,
    exists: (relPath: string) => relPath in FILES,
  }),
}));

import {
  flushAuditLog,
  logOutboundEmail,
  logOutboundEmailOnce,
  logOutboundOnce,
} from './audit-log.js';
import { sensorEmailRepliesEnabled } from './behaviour-sensor.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function modelReply(text: string) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  };
}

const REPLY = 'Applied Topics Studio is a Core course in the program.';
const REQUEST = 'Is Applied Topics Studio a Core course?';

describe('reply sensor on email replies', () => {
  let repo: string;

  beforeEach(() => {
    mockFetch.mockReset();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'email-sensor-'));
    fs.mkdirSync(path.join(repo, '.git')); // checkout-fs refuses a non-checkout
    vi.stubEnv('PROGRAM_HOST_REPO', repo);
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('SENSOR_EMAIL_REPLIES', '');
    vi.stubEnv('SENSOR_PROVIDER', '');
    vi.stubEnv('MODEL_PROVIDERS', '');
    vi.stubEnv('BEHAVIOUR_SENSOR_DISABLED', '');
  });

  afterEach(() => {
    flushAuditLog();
    vi.unstubAllEnvs();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function audit(): string {
    const dir = path.join(repo, 'discussions', 'audit-log');
    return fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
  }

  function triage(): string {
    const dir = path.join(repo, 'discussions', 'kb-triage');
    if (!fs.existsSync(dir)) return '';
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
  }

  /** The sensor runs after the entry is written; wait for its line. */
  async function settled(): Promise<string> {
    await vi.waitFor(() => {
      expect(audit()).not.toContain('[sensor: pending:');
    });
    return audit();
  }

  function delivery(deliveryId = 'delivery-1') {
    return {
      deliveryId,
      to: 'person@example.edu',
      cc: 'colleague@example.edu, second@example.edu',
      subject: 'Course question',
      sourceGroup: 'program-email',
      resendId: 'provider-1',
      body: REPLY,
    };
  }
  const reply = { replyText: REPLY, requestContext: REQUEST };

  it('reads the setting as off unless it is 1, true or on', () => {
    expect(sensorEmailRepliesEnabled()).toBe(false);
    for (const value of ['0', 'false', 'off', 'yes']) {
      vi.stubEnv('SENSOR_EMAIL_REPLIES', value);
      expect(sensorEmailRepliesEnabled()).toBe(false);
    }
    for (const value of ['1', 'true', 'on', ' ON ']) {
      vi.stubEnv('SENSOR_EMAIL_REPLIES', value);
      expect(sensorEmailRepliesEnabled()).toBe(true);
    }
  });

  it('off by default: an email reply makes no request and its entry has no sensor line', async () => {
    expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockFetch).not.toHaveBeenCalled();
    const out = audit();
    expect(out).toContain('**[OUTBOUND EMAIL]** To: person@example.edu');
    expect(out).toContain('**Delivery-ID:** delivery-1');
    expect(out).not.toContain('[sensor:');
    // The entry is the one written without the reply argument.
    const withReply = out;
    fs.rmSync(path.join(repo, 'discussions'), { recursive: true });
    expect(logOutboundEmailOnce(delivery())).toBe('written');
    const strip = (s: string) => s.replace(/^### \S+/gm, '###');
    expect(strip(audit())).toBe(strip(withReply));
  });

  it('off by default: a chat reply is still checked', async () => {
    mockFetch.mockResolvedValue(modelReply('PASS'));
    expect(logOutboundOnce('tg-program@program', REPLY, 'outcome-chat')).toBe(
      'written',
    );
    expect(await settled()).toContain('[sensor: pass]');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('on: one evaluation per delivered reply, whatever the number of recipients, and the entry carries the verdict', async () => {
    vi.stubEnv('SENSOR_EMAIL_REPLIES', '1');
    mockFetch.mockResolvedValue(modelReply('PASS'));

    expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
    const out = await settled();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const prompt = JSON.parse(init.body).messages[0].content as string;
    expect(prompt).toContain(REPLY);
    expect(prompt).toContain(REQUEST);
    // The verdict line sits inside the email entry, before its Delivery-ID.
    expect(out).toMatch(
      /\*\*\[OUTBOUND EMAIL\]\*\*[\s\S]*\n\[sensor: pass\]\n\*\*Delivery-ID:\*\* delivery-1\n---/,
    );
    expect(triage()).toBe('');
  });

  it('on: a FAIL verdict files a triage report, as for chat', async () => {
    vi.stubEnv('SENSOR_EMAIL_REPLIES', 'true');
    mockFetch.mockResolvedValue(
      modelReply('FAIL: Applied Topics is Draft, not Core | type: factual'),
    );

    expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
    const out = await settled();

    expect(out).toContain('[sensor: fail');
    await vi.waitFor(() => expect(triage()).toContain(REPLY));
    expect(triage()).toContain('Applied Topics is Draft, not Core');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('on: a retry of the same delivery does not evaluate twice', async () => {
    vi.stubEnv('SENSOR_EMAIL_REPLIES', '1');
    mockFetch.mockResolvedValue(modelReply('PASS'));

    expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
    expect(logOutboundEmailOnce(delivery(), reply)).toBe('already-recorded');
    await settled();
    expect(logOutboundEmailOnce(delivery(), reply)).toBe('already-recorded');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(audit().match(/\*\*\[OUTBOUND EMAIL\]\*\*/g)).toHaveLength(1);
    expect(audit().match(/\[sensor: /g)).toHaveLength(1);
  });

  it('on: mail that is not a reply (send_email tool, operator alert, scheduled mail) is not evaluated', async () => {
    vi.stubEnv('SENSOR_EMAIL_REPLIES', '1');

    // These all reach the audit log through logOutboundEmail, with or
    // without a delivery ID, and never with reply text.
    logOutboundEmail({
      ...delivery('alert-1'),
      subject: '[ALERT] dead letter',
      sourceGroup: 'operator-alert',
    });
    logOutboundEmail({
      to: 'person@example.edu',
      subject: 'Weekly reminder',
      sourceGroup: 'scheduled-task',
      resendId: 'provider-2',
      body: REPLY,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(audit().match(/\*\*\[OUTBOUND EMAIL\]\*\*/g)).toHaveLength(2);
    expect(audit()).not.toContain('[sensor:');
  });

  it('only the reply delivery path hands reply text to the email audit', () => {
    const src = (name: string) =>
      fs.readFileSync(path.join(process.cwd(), 'src', name), 'utf8');
    // outbound-email.ts sends tool mail, alerts and scheduled mail.
    expect(src('outbound-email.ts')).not.toContain('logOutboundEmailOnce');
    expect(src('outbound-email.ts')).toMatch(/logOutboundEmail\(\{/);
    // index.ts audits a delivered reply, and passes the gated reply text.
    expect(src('index.ts')).toMatch(
      /logOutboundEmailOnce\(\s*\{[\s\S]*?\},\s*(\/\/[^\n]*\n\s*)?\{ replyText: args\.replyText, requestContext: args\.inboundText \},\s*\)/,
    );
  });

  it.each([
    [
      'a provider error',
      () => mockFetch.mockRejectedValue(new Error('ECONNRESET')),
    ],
    [
      'an HTTP 500',
      () =>
        mockFetch.mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'overloaded',
        }),
    ],
    [
      'a timeout',
      () =>
        mockFetch.mockRejectedValue(
          Object.assign(new Error('aborted'), { name: 'AbortError' }),
        ),
    ],
  ])(
    'on: %s leaves the email audited and is recorded as a sensor error',
    async (_name, arrange) => {
      vi.stubEnv('SENSOR_EMAIL_REPLIES', '1');
      arrange();

      // The result the delivery path acts on does not depend on the sensor.
      expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
      const out = await settled();

      expect(out).toContain('**[OUTBOUND EMAIL]** To: person@example.edu');
      expect(out).toContain('[sensor: error: exception]');
      expect(out).toContain('**Delivery-ID:** delivery-1');
      expect(triage()).toBe('');
    },
  );

  it('on: a missing credential is recorded and no request is made', async () => {
    vi.stubEnv('SENSOR_EMAIL_REPLIES', '1');
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
    const out = await settled();

    expect(out).toContain('[sensor: error: no-api-key]');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('on: the sensor follows SENSOR_PROVIDER and makes no request elsewhere when its settings are missing', async () => {
    vi.stubEnv('SENSOR_EMAIL_REPLIES', '1');
    vi.stubEnv('SENSOR_PROVIDER', 'foundry');

    expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
    const out = await settled();

    expect(out).toContain('[sensor: error: no-foundry-settings]');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('BEHAVIOUR_SENSOR_DISABLED=1 wins over SENSOR_EMAIL_REPLIES', async () => {
    vi.stubEnv('SENSOR_EMAIL_REPLIES', '1');
    vi.stubEnv('BEHAVIOUR_SENSOR_DISABLED', '1');

    expect(logOutboundEmailOnce(delivery(), reply)).toBe('written');
    const out = await settled();

    expect(out).toContain('[sensor: disabled]');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(triage()).toBe('');
  });
});
