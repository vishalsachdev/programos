/**
 * Issue 54: `.env` holds every secret. The host says so at start when other
 * users of the machine can read it, and refuses to start only when asked to.
 * The setup steps create the file private and keep an existing file's mode.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkEnvFilePermissions,
  envFilePermissionProblem,
  writeEnvFile,
} from './env.js';
import { logger } from './logger.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-mode-'));
  file = path.join(dir, '.env');
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  vi.stubEnv('REQUIRE_PRIVATE_ENV_FILE', '');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeWithMode(mode: number, content = 'WEBHOOK_SECRET=placeholder\n') {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
}

describe('envFilePermissionProblem', () => {
  it.each([0o600, 0o400])('accepts mode %o', (mode) => {
    writeWithMode(mode);
    expect(envFilePermissionProblem()).toBeNull();
  });

  it.each([
    [0o644, '644'],
    [0o640, '640'],
    [0o604, '604'],
    [0o660, '660'],
    [0o620, '620'],
  ])(
    'reports mode %o, with the file and the command to fix it',
    (mode, text) => {
      writeWithMode(mode);
      expect(envFilePermissionProblem()).toEqual({
        file,
        mode: text,
        fix: `chmod 600 ${file}`,
      });
    },
  );

  it('says nothing when there is no .env', () => {
    expect(envFilePermissionProblem()).toBeNull();
  });
});

describe('the check at start', () => {
  it('logs one error that names the file and the fix, and lets the host start', () => {
    writeWithMode(0o644);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect(() => checkEnvFilePermissions()).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    const [data, message] = error.mock.calls[0] as [
      Record<string, string>,
      string,
    ];
    expect(data).toEqual({ file, mode: '644', fix: `chmod 600 ${file}` });
    expect(message).toContain(file);
    expect(message).toContain(`chmod 600 ${file}`);
    expect(message).toContain('REQUIRE_PRIVATE_ENV_FILE=true');
    // The secret values are not part of the message.
    expect(JSON.stringify(error.mock.calls)).not.toContain('placeholder');
  });

  it('is silent for a private file', () => {
    writeWithMode(0o600);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    checkEnvFilePermissions();
    expect(error).not.toHaveBeenCalled();
  });

  it('refuses to start with REQUIRE_PRIVATE_ENV_FILE=true in the process environment', () => {
    writeWithMode(0o640);
    vi.stubEnv('REQUIRE_PRIVATE_ENV_FILE', 'true');
    expect(() => checkEnvFilePermissions()).toThrow(
      new RegExp(`chmod 600 ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    expect(() => checkEnvFilePermissions()).toThrow(/refusing to start/);
  });

  it('refuses to start with REQUIRE_PRIVATE_ENV_FILE=true in .env itself', () => {
    writeWithMode(0o644, 'REQUIRE_PRIVATE_ENV_FILE=true\n');
    expect(() => checkEnvFilePermissions()).toThrow(/refusing to start/);
  });

  it('with the setting on, a private file starts as usual', () => {
    writeWithMode(0o600, 'REQUIRE_PRIVATE_ENV_FILE=true\n');
    expect(() => checkEnvFilePermissions()).not.toThrow();
  });

  it.each(['false', '1', 'yes', ''])(
    'only the value "true" makes it a refusal (%j does not)',
    (value) => {
      writeWithMode(0o644);
      vi.stubEnv('REQUIRE_PRIVATE_ENV_FILE', value);
      vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      expect(() => checkEnvFilePermissions()).not.toThrow();
    },
  );
});

describe('writeEnvFile (the setup steps)', () => {
  it('creates a new .env with mode 0600, whatever the umask', () => {
    let previous: number | null = null;
    try {
      previous = process.umask(0);
    } catch {
      /* a worker thread cannot change the umask */
    }
    try {
      writeEnvFile(file, 'TZ=Etc/UTC\n');
    } finally {
      if (previous !== null) process.umask(previous);
    }
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toBe('TZ=Etc/UTC\n');
  });

  it.each([0o600, 0o640, 0o644])(
    'keeps the mode %o of a file that exists',
    (mode) => {
      writeWithMode(mode);
      writeEnvFile(file, 'TZ=Etc/UTC\n');
      expect(fs.statSync(file).mode & 0o777).toBe(mode);
      expect(fs.readFileSync(file, 'utf8')).toBe('TZ=Etc/UTC\n');
    },
  );

  it('the two setup steps that write .env use it, and no setup step writes .env directly', () => {
    for (const rel of ['setup/register.ts', 'setup/timezone.ts']) {
      const text = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(text).toMatch(/writeEnvFile\(envFile,/);
      expect(text).not.toMatch(/writeFileSync\(envFile/);
    }
  });

  it('the host runs the check at start, before it creates or starts anything', () => {
    const text = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
    const main = text.slice(text.indexOf('async function main()'));
    const at = main.indexOf('checkEnvFilePermissions();');
    expect(at).toBeGreaterThan(0);
    for (const later of [
      'ensureHostRepo();',
      'ensureContainerSystemRunning();',
      'initDatabase();',
      'startCredentialProxy(',
    ])
      expect(at).toBeLessThan(main.indexOf(later));
  });
});
