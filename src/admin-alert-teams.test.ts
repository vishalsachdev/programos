import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Teams route of ADMIN_ALERT_ROUTE (admin-alert.ts). fetch is mocked:
// nothing here reaches Microsoft. The URL below is obviously fake.

const mocks = vi.hoisted(() => ({
  env: { ASSISTANT_NAME: 'Coordinator' } as Record<string, string>,
  fetch: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) =>
    Object.fromEntries(
      keys.filter((k) => mocks.env[k]).map((k) => [k, mocks.env[k]]),
    ),
}));

vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: vi.fn(),
    readFile: vi.fn(() => null),
    readFileAsync: vi.fn(async () => null),
  }),
}));

import {
  TEAMS_ALERT_MAX_BODY_BYTES,
  _setTeamsAlertTimeoutMsForTests,
  buildTeamsAlertPayload,
  checkAdminAlertConfig,
  createThrowingAdminAlerter,
  dispatchAdminAlert,
  fitTeamsAlertText,
  parseAdminAlertRoute,
  redactTeamsUrl,
  sendAdminAlert,
  sendAdminAlertTeams,
  sendTestAdminAlerts,
  teamsTruncationMarker,
  type AdminAlertResult,
} from './admin-alert.js';
import { flushAuditLog } from './audit-log.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import { logger } from './logger.js';
import {
  _resetOutboundEmailQueueForTests,
  _setProviderTimeoutMsForTests,
  _setStaggerMsForTests,
} from './outbound-email.js';
import { MemoryOutboxStore } from './outbound-email-outbox.js';

const SIG = 'FAKEsignatureFAKEsignatureFAKE000';
const FAKE_URL = `https://example.invalid/workflows/fake-flow-id/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${SIG}`;

const BASE_ENV = {
  RESEND_API_KEY: 're_test',
  SEND_FROM_NAME: 'Coordinator',
  SEND_FROM_EMAIL: 'program@example.org',
  OPERATOR_CC_EMAIL: 'avery@example.edu',
  ADMIN_ALERT_TEAMS_WORKFLOW_URL: FAKE_URL,
};

function setRoute(
  route: string | undefined,
  env: Record<string, string> = BASE_ENV,
): void {
  mocks.env = { ...env, ...(route ? { ADMIN_ALERT_ROUTE: route } : {}) };
}

function telegramReturning(result: AdminAlertResult) {
  return vi.fn(async () => result);
}

/** Calls to the Teams URL only (the email route also uses fetch). */
function teamsCalls(): { url: string; init: RequestInit; body: unknown }[] {
  return mocks.fetch.mock.calls
    .filter((call) => String(call[0]) === FAKE_URL)
    .map((call) => {
      const init = call[1] as RequestInit;
      return {
        url: String(call[0]),
        init,
        body: JSON.parse(String(init.body)),
      };
    });
}

function respond(status: number, body = ''): void {
  mocks.fetch.mockImplementation(async (url: string) =>
    String(url) === FAKE_URL
      ? new Response(body || null, { status })
      : new Response(JSON.stringify({ id: 're_alert_1' }), { status: 200 }),
  );
}

describe('admin alert Teams route', () => {
  let repo: string;
  let logged: string[];

  beforeEach(() => {
    _initTestDatabase();
    _resetOutboundEmailQueueForTests(new MemoryOutboxStore());
    _setStaggerMsForTests(0);
    _setProviderTimeoutMsForTests(200);
    _setTeamsAlertTimeoutMsForTests(50);
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-alert-teams-'));
    fs.mkdirSync(path.join(repo, '.git'));
    vi.stubEnv('PROGRAM_HOST_REPO', repo);
    vi.stubEnv('ADMIN_ALERT_ROUTE', '');
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    vi.stubEnv('TELEGRAM_ADMIN_CHAT_ID', '');
    mocks.fetch.mockReset();
    vi.stubGlobal('fetch', mocks.fetch);
    respond(202);
    setRoute(undefined);
    logged = [];
    for (const level of ['error', 'warn', 'info', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(
          JSON.stringify(args, (_k, v) =>
            v instanceof Error ? `${v.name}: ${v.message}` : v,
          ),
        );
      }) as never);
    }
  });

  afterEach(() => {
    _setTeamsAlertTimeoutMsForTests(undefined);
    flushAuditLog();
    _closeDatabase();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function auditLog(): string {
    const dir = path.join(repo, 'discussions', 'audit-log');
    if (!fs.existsSync(dir)) return '';
    return fs
      .readdirSync(dir)
      .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
      .join('\n');
  }

  function expectUrlNowhere(): void {
    flushAuditLog();
    const everything = [logged.join('\n'), auditLog()].join('\n');
    expect(everything).not.toContain(FAKE_URL);
    expect(everything).not.toContain(SIG);
    expect(everything).not.toContain('fake-flow-id');
  }

  describe('route selection', () => {
    it('parses teams alone and combined', () => {
      expect(parseAdminAlertRoute('teams')).toEqual({ routes: ['teams'] });
      expect(parseAdminAlertRoute('telegram,teams')).toEqual({
        routes: ['telegram', 'teams'],
      });
      expect(parseAdminAlertRoute('email, teams')).toEqual({
        routes: ['email', 'teams'],
      });
      expect(parseAdminAlertRoute('telegram,email,teams')).toEqual({
        routes: ['telegram', 'email', 'teams'],
      });
      // `both` keeps its old meaning.
      expect(parseAdminAlertRoute('both')).toEqual({
        routes: ['telegram', 'email'],
      });
    });

    it('the default route does not touch Teams', async () => {
      const telegram = telegramReturning('sent');
      expect(await sendAdminAlert('Hello', { telegram })).toBe('sent');
      expect(telegram).toHaveBeenCalledOnce();
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('route teams posts once to the workflow and does not call Telegram', async () => {
      setRoute('teams');
      const telegram = telegramReturning('sent');
      expect(await sendAdminAlert('Disk full', { telegram })).toBe('sent');
      expect(telegram).not.toHaveBeenCalled();
      expect(teamsCalls()).toHaveLength(1);
      expect(mocks.fetch).toHaveBeenCalledOnce();
      const { init } = teamsCalls()[0];
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('telegram,teams sends on both', async () => {
      setRoute('telegram,teams');
      const telegram = telegramReturning('sent');
      expect(await sendAdminAlert('Both', { telegram })).toBe('sent');
      expect(telegram).toHaveBeenCalledOnce();
      expect(teamsCalls()).toHaveLength(1);
    });

    it('email,teams sends one mail and one Teams post', async () => {
      setRoute('email,teams');
      expect(
        await sendAdminAlert('Both', { telegram: telegramReturning('sent') }),
      ).toBe('sent');
      expect(teamsCalls()).toHaveLength(1);
      expect(
        mocks.fetch.mock.calls.filter((c) =>
          String(c[0]).includes('api.resend.com'),
        ),
      ).toHaveLength(1);
    });

    it('counts the alert delivered when Telegram delivered and Teams failed', async () => {
      setRoute('telegram,teams');
      respond(500);
      expect(
        await sendAdminAlert('x', { telegram: telegramReturning('sent') }),
      ).toBe('sent');
    });
  });

  describe('payload', () => {
    it('pins the exact request body', () => {
      expect(
        JSON.stringify(buildTeamsAlertPayload('Line one\nLine "two"')),
      ).toBe(
        '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","contentUrl":null,"content":{"$schema":"http://adaptivecards.io/schemas/adaptive-card.json","type":"AdaptiveCard","version":"1.2","body":[{"type":"TextBlock","text":"Line one\\nLine \\"two\\"","wrap":true}]}}]}',
      );
    });

    it('posts that body, carrying only the alert text', async () => {
      setRoute('teams');
      await sendAdminAlertTeams('Bounce: to sam@example.edu, Subject: Hi');
      expect(teamsCalls()[0].body).toEqual(
        buildTeamsAlertPayload('Bounce: to sam@example.edu, Subject: Hi'),
      );
    });
  });

  describe('results', () => {
    it.each([200, 202])('HTTP %i is success', async (status) => {
      setRoute('teams');
      respond(status);
      expect(await sendAdminAlertTeams('ok')).toBe('sent');
    });

    it.each([
      [400, 'failed-permanent'],
      [401, 'failed-permanent'],
      [404, 'failed-permanent'],
      [413, 'failed-permanent'],
      [302, 'failed-permanent'],
      [429, 'failed-transient'],
      [500, 'failed-transient'],
      [503, 'failed-transient'],
    ] as const)('HTTP %i is %s', async (status, expected) => {
      setRoute('teams');
      respond(status);
      expect(await sendAdminAlertTeams('x')).toBe(expected);
    });

    it('a timeout is a transient failure', async () => {
      setRoute('teams');
      mocks.fetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
          }),
      );
      expect(await sendAdminAlertTeams('slow')).toBe('failed-transient');
      expectUrlNowhere();
    });

    it('a network error is a transient failure', async () => {
      setRoute('teams');
      mocks.fetch.mockRejectedValue(
        new TypeError(`fetch failed for ${FAKE_URL}`),
      );
      expect(await sendAdminAlertTeams('x')).toBe('failed-transient');
      expectUrlNowhere();
    });

    it('a missing or non-https URL is unconfigured and nothing is sent', async () => {
      setRoute('teams', { ...BASE_ENV, ADMIN_ALERT_TEAMS_WORKFLOW_URL: '' });
      expect(await sendAdminAlertTeams('x')).toBe('unconfigured');
      setRoute('teams', {
        ...BASE_ENV,
        ADMIN_ALERT_TEAMS_WORKFLOW_URL: 'http://example.invalid/hook',
      });
      expect(await sendAdminAlertTeams('x')).toBe('unconfigured');
      expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('does not read the URL from the process environment', async () => {
      setRoute('teams', { ...BASE_ENV, ADMIN_ALERT_TEAMS_WORKFLOW_URL: '' });
      vi.stubEnv('ADMIN_ALERT_TEAMS_WORKFLOW_URL', FAKE_URL);
      expect(await sendAdminAlertTeams('x')).toBe('unconfigured');
    });
  });

  describe('throw-on-failure contract', () => {
    it('route teams: rejects when the post failed', async () => {
      setRoute('teams');
      respond(500);
      const alerter = createThrowingAdminAlerter(vi.fn(async () => {}));
      await expect(alerter('Dead letter')).rejects.toThrow(
        'Admin alert not delivered',
      );
    });

    it('route teams: rejects on a timeout', async () => {
      setRoute('teams');
      mocks.fetch.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(init.signal!.reason),
            );
          }),
      );
      const alerter = createThrowingAdminAlerter(vi.fn(async () => {}));
      await expect(alerter('Dead letter')).rejects.toThrow();
    });

    it('route teams: resolves once the workflow accepted it, with no Telegram send', async () => {
      setRoute('teams');
      const channel = vi.fn(async () => {});
      await expect(
        createThrowingAdminAlerter(channel)('Dead letter'),
      ).resolves.toBeUndefined();
      expect(channel).not.toHaveBeenCalled();
    });

    it('the rejection does not carry the URL', async () => {
      setRoute('teams');
      mocks.fetch.mockRejectedValue(new Error(`boom ${FAKE_URL}`));
      const err = await createThrowingAdminAlerter(vi.fn(async () => {}))(
        'x',
      ).catch((e: Error) => e);
      expect(String((err as Error).message)).not.toContain(SIG);
      expectUrlNowhere();
    });
  });

  describe('audit entry', () => {
    it('writes one entry for each delivered post', async () => {
      setRoute('teams');
      await sendAdminAlert('First alert', {
        telegram: telegramReturning('sent'),
      });
      await sendAdminAlert('Second alert', {
        telegram: telegramReturning('sent'),
      });
      flushAuditLog();
      const log = auditLog();
      expect(log.match(/\*\*\[ADMIN ALERT TEAMS\]\*\*/g)).toHaveLength(2);
      expect(log).toContain('**[ADMIN ALERT TEAMS]** Accepted: HTTP 202');
      expect(log).toContain('**Source:** admin-alert');
      expect(log).toContain('First alert');
      expect(log).toContain('Second alert');
      expectUrlNowhere();
    });

    it('writes no entry for a refused post', async () => {
      setRoute('teams');
      respond(400);
      await sendAdminAlertTeams('Refused');
      flushAuditLog();
      expect(auditLog()).not.toContain('[ADMIN ALERT TEAMS]');
    });
  });

  describe('the URL is never logged', () => {
    it('in success, refusal, error and startup paths', async () => {
      setRoute('teams');
      await sendAdminAlertTeams('ok');
      respond(403, `denied ${FAKE_URL}`);
      await sendAdminAlertTeams('denied');
      mocks.fetch.mockRejectedValue(
        Object.assign(new Error('fetch failed'), {
          cause: new Error(`connect to ${FAKE_URL}`),
        }),
      );
      await sendAdminAlertTeams('err');
      checkAdminAlertConfig();
      await sendTestAdminAlerts({ telegram: async () => 'sent' });
      expect(logged.length).toBeGreaterThan(0);
      expectUrlNowhere();
    });

    it('redactTeamsUrl removes the URL, its path and its signature', () => {
      const out = redactTeamsUrl(
        `a ${FAKE_URL} b /workflows/fake-flow-id/triggers/manual/paths/invoke c sig=${SIG}`,
        FAKE_URL,
      );
      expect(out).not.toContain(SIG);
      expect(out).not.toContain('fake-flow-id');
      expect(redactTeamsUrl('x?sig=abc123&y=1', undefined)).toBe(
        'x?sig=[redacted]&y=1',
      );
    });
  });

  describe('no recursion', () => {
    it('a failed Teams post raises no further alert and is posted once', async () => {
      setRoute('teams');
      respond(500);
      const alerter = createThrowingAdminAlerter(vi.fn(async () => {}));
      await alerter('Original').catch(() => {});
      expect(teamsCalls()).toHaveLength(1);
    });

    it('an alert raised while a Teams post is in flight is not posted to Teams', async () => {
      setRoute('telegram,teams');
      const inner: Promise<unknown>[] = [];
      const telegram = telegramReturning('sent');
      mocks.fetch.mockImplementation(async () => {
        // Something reacting to the post raises another alert.
        inner.push(
          dispatchAdminAlert('Alert about the Teams post', { telegram }),
        );
        return new Response(null, { status: 202 });
      });
      await dispatchAdminAlert('Original', { telegram });
      await Promise.all(inner);
      expect(teamsCalls()).toHaveLength(1);
      expect(telegram).toHaveBeenCalledTimes(2);
    });

    it('with teams alone, that inner alert is suppressed, not posted', async () => {
      setRoute('teams');
      let innerOutcome: unknown;
      mocks.fetch.mockImplementation(async () => {
        innerOutcome = await dispatchAdminAlert('inner', {
          telegram: telegramReturning('sent'),
        });
        return new Response(null, { status: 202 });
      });
      await dispatchAdminAlert('Original', {
        telegram: telegramReturning('sent'),
      });
      expect(innerOutcome).toBe('suppressed');
      expect(teamsCalls()).toHaveLength(1);
    });
  });

  describe('truncation', () => {
    it('leaves a text that fits unchanged', () => {
      expect(fitTeamsAlertText('short')).toEqual({
        text: 'short',
        truncated: false,
      });
    });

    it('cuts a long alert to the limit with a marker, in one post', async () => {
      setRoute('teams');
      const long = 'é'.repeat(40_000);
      await sendAdminAlertTeams(long);
      expect(teamsCalls()).toHaveLength(1);
      const body = String(teamsCalls()[0].init.body);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
        TEAMS_ALERT_MAX_BODY_BYTES,
      );
      const posted = (
        teamsCalls()[0].body as {
          attachments: { content: { body: { text: string }[] } }[];
        }
      ).attachments[0].content.body[0].text;
      expect(posted.startsWith('éééé')).toBe(true);
      expect(posted).toMatch(
        /\[Cut to fit the Teams message size limit: \d+ characters left out\.\]$/,
      );
      const kept = posted.indexOf('\n\n[Cut');
      expect(posted).toContain(teamsTruncationMarker(40_000 - kept));
      flushAuditLog();
      expect(auditLog()).toContain('Truncated: yes');
    });

    it('fills the limit as closely as it can', () => {
      const { text, truncated } = fitTeamsAlertText('a'.repeat(5000), 2000);
      expect(truncated).toBe(true);
      const size = Buffer.byteLength(
        JSON.stringify(buildTeamsAlertPayload(text)),
      );
      expect(size).toBeLessThanOrEqual(2000);
      expect(size).toBeGreaterThan(1990);
    });
  });

  describe('startup check', () => {
    it('is silent when the URL is set', () => {
      setRoute('teams');
      expect(checkAdminAlertConfig()).toEqual([]);
    });

    it('names the setting when the route includes teams and it is unset', () => {
      setRoute('teams', { ...BASE_ENV, ADMIN_ALERT_TEAMS_WORKFLOW_URL: '' });
      expect(checkAdminAlertConfig()).toEqual([
        'ADMIN_ALERT_ROUTE includes teams but ADMIN_ALERT_TEAMS_WORKFLOW_URL is not set; operator alerts will not reach Teams',
      ]);
    });

    it('names a URL that is not https', () => {
      setRoute('teams', {
        ...BASE_ENV,
        ADMIN_ALERT_TEAMS_WORKFLOW_URL: 'http://example.invalid/x',
      });
      expect(checkAdminAlertConfig()).toEqual([
        expect.stringContaining('must be an https:// URL'),
      ]);
    });

    it('reports each missing setting with three routes on', () => {
      setRoute('telegram,email,teams', {
        SEND_FROM_EMAIL: 'program@example.org',
      });
      const problems = checkAdminAlertConfig().join('\n');
      expect(problems).toContain('OPERATOR_CC_EMAIL');
      expect(problems).toContain('ADMIN_ALERT_TEAMS_WORKFLOW_URL');
      expect(problems).toContain('TELEGRAM_BOT_TOKEN');
    });
  });

  describe('first-start test alert', () => {
    it('covers the Teams route', async () => {
      setRoute('teams');
      const telegram = vi.fn(async () => 'sent' as const);
      const report = await sendTestAdminAlerts({ telegram });
      expect(report).toEqual({ telegram: 'off', email: 'off', teams: 'sent' });
      expect(telegram).not.toHaveBeenCalled();
      expect(JSON.stringify(teamsCalls()[0].body)).toContain(
        'Test alert from Coordinator',
      );
    });

    it('a working route does not hide a broken Teams route', async () => {
      setRoute('telegram,teams');
      respond(404);
      expect(
        await sendTestAdminAlerts({ telegram: async () => 'sent' }),
      ).toEqual({ telegram: 'sent', email: 'off', teams: 'failed-permanent' });
    });
  });
});
