import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The identity settings are fixed when their module loads, so every case
// sets the environment first and then imports a fresh copy of the modules.

const REAL_PATTERN = '^git@git[.]example[.]edu:team/kb([.]git)?$';
const PLACEHOLDER_ORIGIN = 'git@github.com:example-org/program-repo.git';
const REAL_ORIGIN = 'git@git.example.edu:team/kb.git';
const REAL_DOMAIN = 'uni.test';
const REAL_ADMINS = 'admin@example.org';

let tmp: string;

function repoWithOrigin(name: string, origin: string | null): string {
  const dir = path.join(tmp, name);
  execFileSync('git', ['init', '-q', dir]);
  if (origin) {
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  }
  return dir;
}

function fresh(env: {
  admins?: string;
  domain?: string;
  pattern?: string;
  checkout?: string;
  mirror?: string;
}) {
  vi.resetModules();
  vi.stubEnv('ADMIN_AUTHOR_EMAILS', env.admins ?? '');
  vi.stubEnv('INSTITUTION_DOMAIN', env.domain ?? '');
  vi.stubEnv('PROGRAM_ORIGIN_PATTERN', env.pattern ?? '');
  vi.stubEnv('PROGRAM_REPO', env.checkout ?? path.join(tmp, 'no-checkout'));
  vi.stubEnv('PROGRAM_READ_MIRROR', env.mirror ?? path.join(tmp, 'no-mirror'));
  vi.doMock('./env.js', () => ({ readEnvFile: () => ({}) }));
  // Host git in the checkout drops to the checkout owner when root; these
  // repos belong to whoever runs the tests.
  vi.doMock('./program-repo.js', () => ({
    getProgramRepoPath: () => process.env.PROGRAM_REPO,
    checkoutGitOptions: () => ({
      cwd: process.env.PROGRAM_REPO,
      env: process.env,
      timeout: 30_000,
    }),
  }));
}

async function check(): Promise<() => void> {
  const mod = await import('./identity-settings-check.js');
  return mod.assertIdentitySettingsConfigured;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-settings-'));
});

afterEach(() => {
  vi.doUnmock('./env.js');
  vi.doUnmock('./program-repo.js');
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('real program repo, ADMIN_AUTHOR_EMAILS unset', () => {
  it('refuses to start when PROGRAM_ORIGIN_PATTERN is set', async () => {
    fresh({ pattern: REAL_PATTERN, domain: REAL_DOMAIN });
    const assert = await check();
    expect(assert).toThrow(/ADMIN_AUTHOR_EMAILS is not set/);
    expect(assert).not.toThrow(/INSTITUTION_DOMAIN/);
    expect(assert).toThrow(/PROGRAM_ORIGIN_PATTERN is set/);
    expect(assert).toThrow(/`\.env` file in the repo root/);
    expect(assert).toThrow(/config\/instance\.env\.example/);
  });

  it('refuses to start when the checkout origin is not the placeholder', async () => {
    fresh({ checkout: repoWithOrigin('kb', REAL_ORIGIN), domain: REAL_DOMAIN });
    const assert = await check();
    expect(assert).toThrow(/ADMIN_AUTHOR_EMAILS is not set/);
    expect(assert).toThrow(/origin of the program repo checkout/);
  });

  it('refuses to start when a hand-made read mirror has a real origin', async () => {
    fresh({
      checkout: repoWithOrigin('kb', PLACEHOLDER_ORIGIN),
      mirror: path.join(repoWithOrigin('mirror', REAL_ORIGIN), '.git'),
      domain: REAL_DOMAIN,
    });
    expect(await check()).toThrow(/origin of the read mirror/);
  });

  it('does not put the origin URL in the error', async () => {
    const origin = 'https://x-token:hunter2@git.example.edu/team/kb.git';
    fresh({ checkout: repoWithOrigin('kb', origin), domain: REAL_DOMAIN });
    const assert = await check();
    expect(assert).toThrow(/ADMIN_AUTHOR_EMAILS is not set/);
    expect(assert).not.toThrow(/hunter2|git\.example\.edu/);
  });
});

describe('real program repo, ADMIN_AUTHOR_EMAILS holds a placeholder', () => {
  it.each([
    'avery@example.edu',
    'Avery.Personal@gmail.com',
    '1000001+example-org@users.noreply.github.com',
  ])('refuses to start with %s in the list', async (placeholder) => {
    fresh({
      pattern: REAL_PATTERN,
      domain: REAL_DOMAIN,
      admins: `admin@example.org, ${placeholder}`,
    });
    const assert = await check();
    expect(assert).toThrow(/ADMIN_AUTHOR_EMAILS contains a placeholder/);
    expect(assert).toThrow(placeholder.toLowerCase());
  });
});

describe('real program repo, ADMIN_AUTHOR_EMAILS holds real identities', () => {
  it('starts, and the admin check uses the setting', async () => {
    fresh({
      checkout: repoWithOrigin('kb', REAL_ORIGIN),
      admins: 'Admin@Example.org,42+admin@users.noreply.github.com',
      domain: REAL_DOMAIN,
    });
    expect(await check()).not.toThrow();
    const { isAdminAuthorEmail } = await import('./governance-protection.js');
    expect(isAdminAuthorEmail('admin@example.org')).toBe(true);
    expect(isAdminAuthorEmail('42+admin@users.noreply.github.com')).toBe(true);
    expect(isAdminAuthorEmail('avery@example.edu')).toBe(false);
    expect(isAdminAuthorEmail('avery.personal@gmail.com')).toBe(false);
    expect(
      isAdminAuthorEmail('1000001+example-org@users.noreply.github.com'),
    ).toBe(false);
  });
});

describe('real program repo, INSTITUTION_DOMAIN unset', () => {
  it('refuses to start when PROGRAM_ORIGIN_PATTERN is set', async () => {
    fresh({ pattern: REAL_PATTERN, admins: REAL_ADMINS });
    const assert = await check();
    expect(assert).toThrow(/INSTITUTION_DOMAIN is not set/);
    expect(assert).not.toThrow(/ADMIN_AUTHOR_EMAILS/);
    expect(assert).toThrow(/PROGRAM_ORIGIN_PATTERN is set/);
    expect(assert).toThrow(/`\.env` file in the repo root/);
    expect(assert).toThrow(/config\/instance\.env\.example/);
  });

  it('refuses to start when the checkout origin is not the placeholder', async () => {
    fresh({ checkout: repoWithOrigin('kb', REAL_ORIGIN), admins: REAL_ADMINS });
    const assert = await check();
    expect(assert).toThrow(/INSTITUTION_DOMAIN is not set/);
    expect(assert).toThrow(/origin of the program repo checkout/);
  });

  it('refuses to start when a hand-made read mirror has a real origin', async () => {
    fresh({
      checkout: repoWithOrigin('kb', PLACEHOLDER_ORIGIN),
      mirror: path.join(repoWithOrigin('mirror', REAL_ORIGIN), '.git'),
      admins: REAL_ADMINS,
    });
    const assert = await check();
    expect(assert).toThrow(/INSTITUTION_DOMAIN is not set/);
    expect(assert).toThrow(/origin of the read mirror/);
  });

  it('does not put the origin URL in the error', async () => {
    const origin = 'https://x-token:hunter2@git.example.edu/team/kb.git';
    fresh({ checkout: repoWithOrigin('kb', origin), admins: REAL_ADMINS });
    const assert = await check();
    expect(assert).toThrow(/INSTITUTION_DOMAIN is not set/);
    expect(assert).not.toThrow(/hunter2|git\.example\.edu/);
  });
});

describe('real program repo, INSTITUTION_DOMAIN is the placeholder', () => {
  it.each(['example.edu', 'Example.EDU'])(
    'refuses to start with %s',
    async (placeholder) => {
      fresh({
        pattern: REAL_PATTERN,
        admins: REAL_ADMINS,
        domain: placeholder,
      });
      const assert = await check();
      expect(assert).toThrow(/INSTITUTION_DOMAIN is the placeholder domain/);
      expect(assert).toThrow('"example.edu"');
      expect(assert).not.toThrow(/ADMIN_AUTHOR_EMAILS/);
    },
  );
});

describe('real program repo, INSTITUTION_DOMAIN holds a real domain', () => {
  it('starts, and the setting is the domain in use', async () => {
    fresh({
      checkout: repoWithOrigin('kb', REAL_ORIGIN),
      admins: REAL_ADMINS,
      domain: 'Uni.Test',
    });
    expect(await check()).not.toThrow();
    const { INSTITUTION_DOMAIN } = await import('./instance-identity.js');
    expect(INSTITUTION_DOMAIN).toBe('uni.test');
  });
});

describe('real program repo, both settings missing', () => {
  it('names both settings in one error', async () => {
    fresh({ pattern: REAL_PATTERN });
    const assert = await check();
    expect(assert).toThrow(/INSTITUTION_DOMAIN is not set/);
    expect(assert).toThrow(/ADMIN_AUTHOR_EMAILS is not set/);
  });
});

describe('real program repo, the other identity settings', () => {
  it('starts with BOT_MAIL_DOMAIN and INTAKE_GIT_AUTHOR_EMAIL unset', async () => {
    fresh({ pattern: REAL_PATTERN, admins: REAL_ADMINS, domain: REAL_DOMAIN });
    vi.stubEnv('BOT_MAIL_DOMAIN', '');
    vi.stubEnv('INTAKE_GIT_AUTHOR_EMAIL', '');
    expect(await check()).not.toThrow();
  });
});

describe('placeholder program repo', () => {
  it.each([
    ['no checkout and no mirror', () => ({})],
    [
      'a checkout of the placeholder repo (ssh)',
      () => ({ checkout: repoWithOrigin('kb', PLACEHOLDER_ORIGIN) }),
    ],
    [
      'a checkout of the placeholder repo (https with a token)',
      () => ({
        checkout: repoWithOrigin(
          'kb',
          'https://x-token:abc@github.com/example-org/program-repo',
        ),
      }),
    ],
    [
      'a checkout with no origin',
      () => ({ checkout: repoWithOrigin('kb', null) }),
    ],
  ])(
    'starts with ADMIN_AUTHOR_EMAILS and INSTITUTION_DOMAIN unset: %s',
    async (_name, env: () => Parameters<typeof fresh>[0]) => {
      fresh(env());
      expect(await check()).not.toThrow();
      const { isAdminAuthorEmail } = await import('./governance-protection.js');
      expect(isAdminAuthorEmail('avery@example.edu')).toBe(true);
      const { INSTITUTION_DOMAIN } = await import('./instance-identity.js');
      expect(INSTITUTION_DOMAIN).toBe('example.edu');
    },
  );

  it('starts with a placeholder address in the setting', async () => {
    fresh({ admins: 'avery@example.edu' });
    expect(await check()).not.toThrow();
  });

  it('starts with INSTITUTION_DOMAIN set to the placeholder domain', async () => {
    fresh({ domain: 'example.edu' });
    expect(await check()).not.toThrow();
  });
});

describe('main()', () => {
  it('runs the check before anything else starts', () => {
    const source = fs.readFileSync(
      new URL('./index.ts', import.meta.url),
      'utf-8',
    );
    const body = source.slice(source.indexOf('async function main()'));
    const firstStatement = body.slice(body.indexOf('{') + 1).trim();
    expect(firstStatement.replace(/^(\/\/[^\n]*\n\s*)+/, '')).toMatch(
      /^assertIdentitySettingsConfigured\(\);/,
    );
  });
});
