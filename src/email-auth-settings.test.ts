import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';
import {
  _resetEmailAuthSettingsForTests,
  currentEmailAuthSettings,
  initEmailAuthSettings,
  loadEmailAuthSettings,
} from './email-auth-settings.js';

// The EMAIL_AUTH_* settings are read from the process environment and from
// `.env`. `.env` is looked for in the working directory, so each test runs
// in a folder of its own.

const PLATFORM = 'mx.platform.example';
const KEYS = [
  'EMAIL_AUTH_MODE',
  'EMAIL_AUTH_TRUSTED_AUTHSERV_IDS',
  'EMAIL_AUTH_UNKNOWN',
  'EMAIL_AUTH_REQUIRE_FROM_DOMAIN',
];

let dir: string;
let cwd: string;

function writeEnv(lines: string[]): void {
  fs.writeFileSync(path.join(dir, '.env'), lines.join('\n') + '\n', {
    mode: 0o600,
  });
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-auth-settings-'));
  process.chdir(dir);
  for (const key of KEYS) vi.stubEnv(key, '');
  _resetEmailAuthSettingsForTests();
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  _resetEmailAuthSettingsForTests();
});

describe('where the EMAIL_AUTH_* settings are read from', () => {
  it('reads every one of them from .env', () => {
    writeEnv([
      'EMAIL_AUTH_MODE=enforce',
      `EMAIL_AUTH_TRUSTED_AUTHSERV_IDS=${PLATFORM}`,
      'EMAIL_AUTH_UNKNOWN=allow',
      'EMAIL_AUTH_REQUIRE_FROM_DOMAIN=false',
    ]);
    const settings = loadEmailAuthSettings();
    expect(settings.mode).toBe('enforce');
    expect([...settings.trusted]).toEqual([PLATFORM]);
    expect(settings.unknown).toBe('allow');
    expect(settings.requireFromDomain).toBe(false);
  });

  it('the process environment wins over .env, key by key', () => {
    writeEnv([
      'EMAIL_AUTH_MODE=enforce',
      `EMAIL_AUTH_TRUSTED_AUTHSERV_IDS=${PLATFORM}`,
    ]);
    vi.stubEnv('EMAIL_AUTH_MODE', 'flag');
    const settings = loadEmailAuthSettings();
    expect(settings.mode).toBe('flag');
    expect([...settings.trusted]).toEqual([PLATFORM]);
  });

  it('a value in .env that the host does not know stops the start', () => {
    writeEnv(['EMAIL_AUTH_MODE=enforced']);
    expect(() => initEmailAuthSettings()).toThrow(/"flag" or "enforce"/);
    writeEnv(['EMAIL_AUTH_MODE=enforce']);
    expect(() => initEmailAuthSettings()).toThrow(
      /needs EMAIL_AUTH_TRUSTED_AUTHSERV_IDS/,
    );
    writeEnv(['EMAIL_AUTH_UNKNOWN=perhaps']);
    expect(() => initEmailAuthSettings()).toThrow(/"block" or "allow"/);
    writeEnv(['EMAIL_AUTH_REQUIRE_FROM_DOMAIN=sometimes']);
    expect(() => initEmailAuthSettings()).toThrow(
      /EMAIL_AUTH_REQUIRE_FROM_DOMAIN/,
    );
  });

  it('says the mode in effect once at start, and keeps the settings until the restart', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    writeEnv([
      'EMAIL_AUTH_MODE=enforce',
      `EMAIL_AUTH_TRUSTED_AUTHSERV_IDS=${PLATFORM}`,
    ]);
    initEmailAuthSettings();
    const lines = info.mock.calls.filter((call) =>
      String(call[1]).includes('sender authentication'),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ mode: 'enforce', trusted: [PLATFORM] });
    expect(String(lines[0][1])).toMatch(/enforce/);
    // An edit of .env after the start changes nothing until the restart.
    writeEnv(['EMAIL_AUTH_MODE=flag']);
    expect(currentEmailAuthSettings().mode).toBe('enforce');
  });

  it('with nothing set: flag, and the start line says every verdict is unknown', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const settings = initEmailAuthSettings();
    expect(settings.mode).toBe('flag');
    expect(String(info.mock.calls.at(-1)?.[1])).toMatch(
      /flag.*every verdict is "unknown"/,
    );
  });
});
