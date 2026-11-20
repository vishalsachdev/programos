import { afterEach, describe, expect, it, vi } from 'vitest';

// Each identity setting is fixed when its module loads, so every case sets
// the environment first and then imports a fresh copy of the modules.

const KEYS = [
  'INSTITUTION_DOMAIN',
  'BOT_MAIL_DOMAIN',
  'INTAKE_GIT_AUTHOR_EMAIL',
  'ADMIN_AUTHOR_EMAILS',
  'SEND_FROM_EMAIL',
];

function fresh(
  env: Record<string, string> = {},
  dotEnv: Record<string, string> = {},
) {
  vi.resetModules();
  for (const key of KEYS) vi.stubEnv(key, env[key] ?? '');
  vi.doMock('./env.js', () => ({
    readEnvFile: (keys: string[]) =>
      Object.fromEntries(
        Object.entries(dotEnv).filter(([key]) => keys.includes(key)),
      ),
  }));
}

afterEach(() => {
  vi.doUnmock('./env.js');
  vi.unstubAllEnvs();
  vi.resetModules();
});

const ALLOWLIST = [
  '| Name | Email | Role | Access | Notes |',
  '|---|---|---|---|---|',
  '| Avery Morgan | avery@example.edu | Faculty | read-write | Program Director · **coordinator-cohort: founding** |',
  '| Omar Haddad | ohaddad@uni.test | Staff | read-write | Program oversight · **coordinator-cohort: founding** |',
  '| Old Omar | ohaddad@example.edu | Staff | read-write | Same name on the placeholder domain · **coordinator-cohort: test** |',
  '| June Hale | jhl@uni.test | Admissions | read-only | Updates route to **Omar Haddad (ohaddad)** for approval · **coordinator-cohort: team-expansion** |',
].join('\n');

describe('identity settings', () => {
  it('default to the placeholders when nothing is set', async () => {
    fresh();
    const id = await import('./instance-identity.js');
    expect(id.INSTITUTION_DOMAIN).toBe('example.edu');
    expect(id.BOT_MAIL_DOMAIN).toBe('example.org');
    expect(id.BOT_GIT_AUTHOR_EMAIL).toBe('program-bot@example.org');
    expect(id.INTAKE_GIT_AUTHOR_EMAIL).toBe('email-inbox@example.org');
    expect(id.ADMIN_AUTHOR_EMAILS).toEqual([
      'avery.personal@gmail.com',
      'avery@example.edu',
      '1000001+example-org@users.noreply.github.com',
    ]);
    const { DEFAULT_BOT_EMAIL } = await import('./config.js');
    expect(DEFAULT_BOT_EMAIL).toBe('program@example.org');
  });

  it('are read from .env, and the process environment wins', async () => {
    fresh(
      { BOT_MAIL_DOMAIN: 'bot-env.test' },
      {
        INSTITUTION_DOMAIN: 'Uni.Test',
        BOT_MAIL_DOMAIN: 'bot-file.test',
        INTAKE_GIT_AUTHOR_EMAIL: 'intake@mail.test',
        ADMIN_AUTHOR_EMAILS:
          'Admin@Uni.Test, 42+admin@users.noreply.github.com',
      },
    );
    const id = await import('./instance-identity.js');
    expect(id.INSTITUTION_DOMAIN).toBe('uni.test');
    expect(id.BOT_MAIL_DOMAIN).toBe('bot-env.test');
    expect(id.INTAKE_GIT_AUTHOR_EMAIL).toBe('intake@mail.test');
    expect(id.ADMIN_AUTHOR_EMAILS).toEqual([
      'admin@uni.test',
      '42+admin@users.noreply.github.com',
    ]);
  });

  it.each([
    ['INSTITUTION_DOMAIN', '@uni.test'],
    ['INSTITUTION_DOMAIN', 'uni.test|evil.test'],
    ['INSTITUTION_DOMAIN', 'localhost'],
    ['BOT_MAIL_DOMAIN', 'https://bot.test'],
    ['INTAKE_GIT_AUTHOR_EMAIL', 'Intake <intake@mail.test>'],
    ['INTAKE_GIT_AUTHOR_EMAIL', 'a@mail.test,b@mail.test'],
    ['ADMIN_AUTHOR_EMAILS', 'admin@uni.test, not-an-address'],
    ['ADMIN_AUTHOR_EMAILS', ' , '],
  ])('refuse a malformed %s (%s) at load', async (key, value) => {
    fresh({ [key]: value });
    await expect(import('./instance-identity.js')).rejects.toThrow(key);
  });
});

describe('BOT_MAIL_DOMAIN', () => {
  it('sets the default bot mailbox, and SEND_FROM_EMAIL still overrides it', async () => {
    fresh({ BOT_MAIL_DOMAIN: 'bot.test' });
    const config = await import('./config.js');
    expect(config.DEFAULT_BOT_EMAIL).toBe('program@bot.test');
    expect(config.BOT_EMAIL).toBe('program@bot.test');

    fresh({ BOT_MAIL_DOMAIN: 'bot.test', SEND_FROM_EMAIL: 'Desk@Other.Test' });
    expect((await import('./config.js')).BOT_EMAIL).toBe('desk@other.test');
  });

  it("sets the author of the host's audit-log commits", async () => {
    fresh({ BOT_MAIL_DOMAIN: 'bot.test' });
    const { runAuditCommit } = await import('./audit-log.js');
    const calls: string[][] = [];
    await runAuditCommit(1, async (args) => {
      calls.push(args);
    });
    expect(calls[1]).toContain('--author=Coordinator <program-bot@bot.test>');
  });
});

describe('ADMIN_AUTHOR_EMAILS', () => {
  it('replaces the placeholder admin identities', async () => {
    fresh({
      ADMIN_AUTHOR_EMAILS: 'admin@uni.test,42+admin@users.noreply.github.com',
    });
    const { isAdminAuthorEmail } = await import('./governance-protection.js');
    expect(isAdminAuthorEmail('Admin@Uni.Test')).toBe(true);
    expect(isAdminAuthorEmail('42+admin@users.noreply.github.com')).toBe(true);
    expect(isAdminAuthorEmail('avery@example.edu')).toBe(false);
    expect(isAdminAuthorEmail('avery.personal@gmail.com')).toBe(false);
    expect(isAdminAuthorEmail(undefined)).toBe(false);
  });
});

describe('INSTITUTION_DOMAIN in routed approvals', () => {
  it('resolves a route name to an address on the configured domain', async () => {
    fresh({ INSTITUTION_DOMAIN: 'uni.test' });
    const { resolveRouteApprover } = await import('./routed-approvals.js');
    expect(
      resolveRouteApprover(ALLOWLIST, 'jhl@uni.test', 'ohaddad@uni.test'),
    ).toMatchObject({
      ok: true,
      basis: 'row-route',
      approver: { name: 'Omar Haddad', email: 'ohaddad@uni.test' },
    });
  });

  it('keeps resolving on the placeholder domain when it is not set', async () => {
    fresh();
    const { resolveRouteApprover } = await import('./routed-approvals.js');
    expect(
      resolveRouteApprover(ALLOWLIST, 'jhl@uni.test', 'ohaddad@example.edu'),
    ).toMatchObject({
      ok: true,
      basis: 'row-route',
      approver: { name: 'Old Omar', email: 'ohaddad@example.edu' },
    });
  });
});
