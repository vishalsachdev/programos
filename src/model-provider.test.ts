import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) =>
    Object.fromEntries(
      Object.entries(mockEnv).filter(([k]) => keys.includes(k)),
    ),
  ),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { logger } from './logger.js';
import {
  DEFAULT_FAILOVER_COOLDOWN_MS,
  DEFAULT_FAILOVER_THRESHOLD,
  failureReason,
  isProviderInCooldown,
  loadModelProviderConfig,
  readFoundrySettings,
  recordProviderResult,
  resetModelProviderState,
  selectProvider,
  setProviderChangeNotifier,
} from './model-provider.js';

const FOUNDRY_ENV = {
  ANTHROPIC_FOUNDRY_RESOURCE: 'unit-resource',
  ANTHROPIC_FOUNDRY_API_KEY: 'foundry-real-key',
};
const BOTH = {
  MODEL_PROVIDERS: 'anthropic,foundry',
  ANTHROPIC_API_KEY: 'sk-ant-real-key',
  ...FOUNDRY_ENV,
};

function setEnv(env: Record<string, string>) {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  Object.assign(mockEnv, env);
  resetModelProviderState();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
  vi.clearAllMocks();
  setEnv({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('model provider settings', () => {
  it('with no settings: one provider, anthropic, and no credential check', () => {
    expect(loadModelProviderConfig()).toEqual({
      order: ['anthropic'],
      threshold: DEFAULT_FAILOVER_THRESHOLD,
      cooldownMs: DEFAULT_FAILOVER_COOLDOWN_MS,
    });
    expect(DEFAULT_FAILOVER_THRESHOLD).toBe(3);
    expect(DEFAULT_FAILOVER_COOLDOWN_MS).toBe(30 * 60 * 1000);
    expect(selectProvider()).toBe('anthropic');
  });

  it('with no settings, failures never change the provider or notify', () => {
    const notify = vi.fn();
    setProviderChangeNotifier(notify);
    for (let i = 0; i < 10; i++)
      recordProviderResult('anthropic', { status: 500 });
    expect(selectProvider()).toBe('anthropic');
    expect(notify).not.toHaveBeenCalled();
  });

  it('reads the order as written, so Foundry can be primary', () => {
    setEnv({ ...BOTH, MODEL_PROVIDERS: ' Foundry , anthropic ' });
    expect(loadModelProviderConfig().order).toEqual(['foundry', 'anthropic']);
    expect(selectProvider()).toBe('foundry');
  });

  it('builds the Foundry base URL from the resource name', () => {
    setEnv(BOTH);
    const { foundry } = loadModelProviderConfig();
    expect(foundry!.baseUrl.href).toBe(
      'https://unit-resource.services.ai.azure.com/anthropic',
    );
    expect(foundry!.keyHeader).toBe('api-key');
  });

  it('prefers an explicit Foundry base URL and reads the optional settings', () => {
    setEnv({
      ...BOTH,
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://other.example.edu/anthropic/',
      FOUNDRY_KEY_HEADER: 'X-Api-Key',
      FOUNDRY_AGENT_MODEL: 'agent-deploy',
      FOUNDRY_HAIKU_MODEL: 'claude-haiku-5-5',
      MODEL_FAILOVER_THRESHOLD: '5',
      MODEL_FAILOVER_COOLDOWN_MS: '60000',
    });
    const cfg = loadModelProviderConfig();
    expect(cfg.foundry!.baseUrl.host).toBe('other.example.edu');
    expect(cfg.foundry!.keyHeader).toBe('x-api-key');
    expect(cfg.foundry!.agentModel).toBe('agent-deploy');
    expect(cfg.foundry!.haikuModel).toBe('claude-haiku-5-5');
    expect(cfg.threshold).toBe(5);
    expect(cfg.cooldownMs).toBe(60000);
  });

  it.each([
    [
      'foundry listed without a resource or base URL',
      { ...BOTH, ANTHROPIC_FOUNDRY_RESOURCE: '' },
      /lists foundry.*ANTHROPIC_FOUNDRY_RESOURCE or ANTHROPIC_FOUNDRY_BASE_URL/,
    ],
    [
      'foundry listed without a key',
      { ...BOTH, ANTHROPIC_FOUNDRY_API_KEY: '' },
      /lists foundry.*ANTHROPIC_FOUNDRY_API_KEY/,
    ],
    [
      'a resource that is a URL, not a name',
      { ...BOTH, ANTHROPIC_FOUNDRY_RESOURCE: 'https://x.example' },
      /resource name only/,
    ],
    [
      'anthropic listed without a credential',
      { MODEL_PROVIDERS: 'anthropic,foundry', ...FOUNDRY_ENV },
      /lists anthropic.*ANTHROPIC_API_KEY/,
    ],
    [
      'an unknown provider',
      { ...BOTH, MODEL_PROVIDERS: 'anthropic,bedrock' },
      /unknown provider "bedrock"/,
    ],
    [
      'a provider listed twice',
      { ...BOTH, MODEL_PROVIDERS: 'anthropic,anthropic' },
      /listed twice/,
    ],
    ['an empty list', { ...BOTH, MODEL_PROVIDERS: ' , ' }, /names no provider/],
    [
      'a bad key header',
      { ...BOTH, FOUNDRY_KEY_HEADER: 'authorization' },
      /FOUNDRY_KEY_HEADER/,
    ],
    [
      'a bad threshold',
      { ...BOTH, MODEL_FAILOVER_THRESHOLD: '0' },
      /MODEL_FAILOVER_THRESHOLD/,
    ],
    [
      'a bad cooldown',
      { ...BOTH, MODEL_FAILOVER_COOLDOWN_MS: '30m' },
      /MODEL_FAILOVER_COOLDOWN_MS/,
    ],
  ])('fails clearly on %s', (_name, env, message) => {
    // The mock drops empty values the way the real parser does.
    setEnv(Object.fromEntries(Object.entries(env).filter(([, v]) => v)));
    expect(() => loadModelProviderConfig()).toThrow(message);
    expect(() => selectProvider()).toThrow(message);
  });

  it('an error message never contains a key', () => {
    setEnv({ ...BOTH, FOUNDRY_KEY_HEADER: 'nope' });
    try {
      loadModelProviderConfig();
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as Error).message).not.toContain('foundry-real-key');
      expect((err as Error).message).not.toContain('sk-ant-real-key');
    }
  });

  it('readFoundrySettings works without MODEL_PROVIDERS and throws when incomplete', () => {
    setEnv(FOUNDRY_ENV);
    expect(readFoundrySettings().apiKey).toBe('foundry-real-key');
    setEnv({ ANTHROPIC_FOUNDRY_RESOURCE: 'unit-resource' });
    expect(() => readFoundrySettings()).toThrow(/ANTHROPIC_FOUNDRY_API_KEY/);
  });
});

describe('failureReason', () => {
  it('counts network errors, 401, 403, 429 and 5xx; nothing else', () => {
    expect(failureReason({ networkError: true })).toBe('network error');
    expect(failureReason({ status: 401 })).toBe('auth error (401)');
    expect(failureReason({ status: 403 })).toBe('auth error (403)');
    expect(failureReason({ status: 429 })).toBe('rate limited (429)');
    expect(failureReason({ status: 500 })).toBe('server error (5xx)');
    expect(failureReason({ status: 529 })).toBe('server error (5xx)');
    for (const status of [200, 204, 301, 400, 404, 413])
      expect(failureReason({ status })).toBeNull();
  });
});

describe('circuit breaker', () => {
  beforeEach(() => setEnv(BOTH));

  it.each([
    ['401', { status: 401 }],
    ['429', { status: 429 }],
    ['5xx', { status: 503 }],
    ['a network error', { networkError: true }],
  ])('trips at the threshold on %s, not before', (_name, result) => {
    recordProviderResult('anthropic', result);
    recordProviderResult('anthropic', result);
    expect(isProviderInCooldown('anthropic')).toBe(false);
    expect(selectProvider()).toBe('anthropic');
    recordProviderResult('anthropic', result);
    expect(isProviderInCooldown('anthropic')).toBe(true);
    expect(selectProvider()).toBe('foundry');
  });

  it('a 400 or 404 does not count', () => {
    for (let i = 0; i < 10; i++) {
      recordProviderResult('anthropic', { status: 400 });
      recordProviderResult('anthropic', { status: 404 });
    }
    expect(selectProvider()).toBe('anthropic');
  });

  it('a 2xx resets the count', () => {
    recordProviderResult('anthropic', { status: 500 });
    recordProviderResult('anthropic', { status: 500 });
    recordProviderResult('anthropic', { status: 200 });
    recordProviderResult('anthropic', { status: 500 });
    recordProviderResult('anthropic', { status: 500 });
    expect(selectProvider()).toBe('anthropic');
    recordProviderResult('anthropic', { status: 500 });
    expect(selectProvider()).toBe('foundry');
  });

  it('returns to the first provider when the cooldown ends', () => {
    for (let i = 0; i < 3; i++)
      recordProviderResult('anthropic', { status: 500 });
    expect(selectProvider()).toBe('foundry');
    vi.advanceTimersByTime(DEFAULT_FAILOVER_COOLDOWN_MS - 1);
    expect(selectProvider()).toBe('foundry');
    vi.advanceTimersByTime(1);
    expect(selectProvider()).toBe('anthropic');
  });

  it('half-open: one failure after the cooldown trips it again at once', () => {
    for (let i = 0; i < 3; i++)
      recordProviderResult('anthropic', { status: 500 });
    vi.advanceTimersByTime(DEFAULT_FAILOVER_COOLDOWN_MS);
    expect(selectProvider()).toBe('anthropic');
    recordProviderResult('anthropic', { status: 429 });
    expect(selectProvider()).toBe('foundry');
  });

  it('half-open: a 2xx after the cooldown restores the full threshold', () => {
    for (let i = 0; i < 3; i++)
      recordProviderResult('anthropic', { status: 500 });
    vi.advanceTimersByTime(DEFAULT_FAILOVER_COOLDOWN_MS);
    recordProviderResult('anthropic', { status: 200 });
    recordProviderResult('anthropic', { status: 500 });
    recordProviderResult('anthropic', { status: 500 });
    expect(selectProvider()).toBe('anthropic');
  });

  it('failures during the cooldown do not extend it', () => {
    for (let i = 0; i < 3; i++)
      recordProviderResult('anthropic', { status: 500 });
    vi.advanceTimersByTime(DEFAULT_FAILOVER_COOLDOWN_MS - 1000);
    for (let i = 0; i < 5; i++)
      recordProviderResult('anthropic', { status: 500 });
    vi.advanceTimersByTime(1000);
    expect(selectProvider()).toBe('anthropic');
  });

  it('when every provider is in cooldown, selects the first', () => {
    for (let i = 0; i < 3; i++) {
      recordProviderResult('anthropic', { status: 500 });
      recordProviderResult('foundry', { networkError: true });
    }
    expect(selectProvider()).toBe('anthropic');
  });

  it('uses the configured threshold and cooldown', () => {
    setEnv({
      ...BOTH,
      MODEL_FAILOVER_THRESHOLD: '1',
      MODEL_FAILOVER_COOLDOWN_MS: '5000',
    });
    recordProviderResult('anthropic', { status: 401 });
    expect(selectProvider()).toBe('foundry');
    vi.advanceTimersByTime(5000);
    expect(selectProvider()).toBe('anthropic');
  });
});

describe('provider change notice', () => {
  beforeEach(() => setEnv(BOTH));

  it('notifies once per change, naming old, new and the status class', () => {
    const notify = vi.fn();
    setProviderChangeNotifier(notify);
    expect(selectProvider()).toBe('anthropic');
    expect(notify).not.toHaveBeenCalled();

    for (let i = 0; i < 3; i++)
      recordProviderResult('anthropic', { status: 503 });
    selectProvider();
    selectProvider();
    selectProvider();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('anthropic → foundry');
    expect(notify.mock.calls[0][0]).toContain('server error (5xx)');
    expect(logger.warn).toHaveBeenCalledWith(
      {
        from: 'anthropic',
        to: 'foundry',
        reason: 'anthropic: server error (5xx)',
      },
      'Model provider changed',
    );

    vi.advanceTimersByTime(DEFAULT_FAILOVER_COOLDOWN_MS);
    selectProvider();
    selectProvider();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toContain('foundry → anthropic');
    expect(notify.mock.calls[1][0]).toContain('cooldown ended');
  });

  it('a throwing notifier does not break selection', () => {
    setProviderChangeNotifier(() => {
      throw new Error('alert channel down');
    });
    for (let i = 0; i < 3; i++)
      recordProviderResult('anthropic', { status: 500 });
    expect(selectProvider()).toBe('foundry');
    expect(logger.error).toHaveBeenCalled();
  });
});
