/** Reply sensor: the URL and key header for each SENSOR_PROVIDER. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: config.ts reads settings while it is imported.
const mockEnv = vi.hoisted(() => ({}) as Record<string, string>);
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) =>
    Object.fromEntries(
      Object.entries(mockEnv).filter(([k]) => keys.includes(k)),
    ),
  ),
}));

import {
  evaluateBehaviourReply,
  resolveSensorTarget,
} from './behaviour-sensor.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const stubReader = {
  refresh: () => ({ advanced: false, sha: 'stub-sha' }),
  readFile: (relPath: string) =>
    relPath === 'program/curriculum.md'
      ? '# Curriculum\n\n| Course | Status |\n|---|---|\n| CRS 501 | Core |\n'
      : null,
  exists: (relPath: string) => relPath === 'program/curriculum.md',
};

const REPLY = 'The program is 30 credits over 12 months.';

function modelReply(text: string) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text }] }),
  };
}

describe('sensor provider', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    delete process.env.SENSOR_PROVIDER;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.BEHAVIOUR_SENSOR_DISABLED;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('default: the Anthropic API with x-api-key', () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-real-key';
    expect(resolveSensorTarget()).toEqual({
      provider: 'anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      keyHeader: 'x-api-key',
      apiKey: 'sk-ant-real-key',
    });
  });

  it('default ignores Foundry settings, and reports a missing key as before', () => {
    Object.assign(mockEnv, {
      ANTHROPIC_FOUNDRY_RESOURCE: 'unit-resource',
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-real-key',
    });
    expect(resolveSensorTarget()).toEqual({ error: 'no-api-key' });
  });

  it('foundry: the Foundry messages URL with the key in api-key', () => {
    Object.assign(mockEnv, {
      SENSOR_PROVIDER: 'foundry',
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_FOUNDRY_RESOURCE: 'unit-resource',
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-real-key',
    });
    expect(resolveSensorTarget()).toEqual({
      provider: 'foundry',
      url: 'https://unit-resource.services.ai.azure.com/anthropic/v1/messages',
      keyHeader: 'api-key',
      apiKey: 'foundry-real-key',
    });
  });

  it('foundry: honours FOUNDRY_KEY_HEADER and a custom base URL; the process environment also selects it', () => {
    process.env.SENSOR_PROVIDER = 'foundry';
    Object.assign(mockEnv, {
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://gw.example.edu/unit/anthropic/',
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-real-key',
      FOUNDRY_KEY_HEADER: 'x-api-key',
    });
    expect(resolveSensorTarget()).toEqual({
      provider: 'foundry',
      url: 'https://gw.example.edu/unit/anthropic/v1/messages',
      keyHeader: 'x-api-key',
      apiKey: 'foundry-real-key',
    });
  });

  it('foundry without its settings, or an unknown provider, is an error and never falls back', async () => {
    Object.assign(mockEnv, {
      SENSOR_PROVIDER: 'foundry',
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
    });
    expect(resolveSensorTarget()).toEqual({ error: 'no-foundry-settings' });
    const result = await evaluateBehaviourReply(REPLY, stubReader);
    expect(result.annotation).toBe('[sensor: error: no-foundry-settings]');
    mockEnv.SENSOR_PROVIDER = 'bedrock';
    expect(resolveSensorTarget()).toEqual({
      error: 'unknown-sensor-provider',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('the live request goes to the resolved URL with the resolved header (anthropic)', async () => {
    mockEnv.ANTHROPIC_API_KEY = 'sk-ant-real-key';
    mockFetch.mockResolvedValue(modelReply('PASS'));
    await evaluateBehaviourReply(REPLY, stubReader, { refresh: false });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-real-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('the live request goes to the resolved URL with the resolved header (foundry)', async () => {
    Object.assign(mockEnv, {
      SENSOR_PROVIDER: 'foundry',
      ANTHROPIC_API_KEY: 'sk-ant-real-key',
      ANTHROPIC_FOUNDRY_RESOURCE: 'unit-resource',
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-real-key',
    });
    mockFetch.mockResolvedValue(modelReply('PASS'));
    await evaluateBehaviourReply(REPLY, stubReader, { refresh: false });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://unit-resource.services.ai.azure.com/anthropic/v1/messages',
    );
    expect(init.headers).toEqual({
      'content-type': 'application/json',
      'api-key': 'foundry-real-key',
      'anthropic-version': '2023-06-01',
    });
    expect(JSON.stringify(init)).not.toContain('sk-ant-real-key');
  });

  describe('follows the approved endpoint', () => {
    const FOUNDRY = {
      ANTHROPIC_FOUNDRY_RESOURCE: 'unit-resource',
      ANTHROPIC_FOUNDRY_API_KEY: 'foundry-real-key',
    };

    it('ANTHROPIC_BASE_URL without a path: same host, default path', () => {
      Object.assign(mockEnv, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        ANTHROPIC_BASE_URL: 'https://gw.example.edu',
      });
      expect(resolveSensorTarget()).toEqual({
        provider: 'anthropic',
        url: 'https://gw.example.edu/v1/messages',
        keyHeader: 'x-api-key',
        apiKey: 'sk-ant-real-key',
      });
    });

    it('ANTHROPIC_BASE_URL with a path prefix: joined before /v1/messages', () => {
      Object.assign(mockEnv, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        ANTHROPIC_BASE_URL: 'https://gw.example.edu/unit/anthropic/',
      });
      expect(resolveSensorTarget()).toMatchObject({
        url: 'https://gw.example.edu/unit/anthropic/v1/messages',
      });
    });

    it('the live request goes to the base URL host', async () => {
      Object.assign(mockEnv, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        ANTHROPIC_BASE_URL: 'https://gw.example.edu/unit',
      });
      mockFetch.mockResolvedValue(modelReply('PASS'));
      await evaluateBehaviourReply(REPLY, stubReader, { refresh: false });
      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://gw.example.edu/unit/v1/messages',
      );
    });

    it('an invalid ANTHROPIC_BASE_URL is an error, not api.anthropic.com', async () => {
      Object.assign(mockEnv, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        ANTHROPIC_BASE_URL: 'not a url',
      });
      expect(resolveSensorTarget()).toEqual({ error: 'invalid-base-url' });
      mockEnv.ANTHROPIC_BASE_URL = 'ftp://gw.example.edu';
      expect(resolveSensorTarget()).toEqual({ error: 'invalid-base-url' });
      const result = await evaluateBehaviourReply(REPLY, stubReader);
      expect(result.annotation).toBe('[sensor: error: invalid-base-url]');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('MODEL_PROVIDERS starting with anthropic, or unset: anthropic', () => {
      Object.assign(mockEnv, FOUNDRY, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        MODEL_PROVIDERS: 'anthropic,foundry',
      });
      expect(resolveSensorTarget()).toMatchObject({ provider: 'anthropic' });
    });

    it('MODEL_PROVIDERS=foundry,anthropic with SENSOR_PROVIDER unset: Foundry', async () => {
      Object.assign(mockEnv, FOUNDRY, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        MODEL_PROVIDERS: 'foundry,anthropic',
      });
      mockFetch.mockResolvedValue(modelReply('PASS'));
      await evaluateBehaviourReply(REPLY, stubReader, { refresh: false });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(
        'https://unit-resource.services.ai.azure.com/anthropic/v1/messages',
      );
      expect(init.headers['api-key']).toBe('foundry-real-key');
      expect(JSON.stringify(init)).not.toContain('sk-ant-real-key');
    });

    it('an explicit SENSOR_PROVIDER wins, in both directions', () => {
      Object.assign(mockEnv, FOUNDRY, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        MODEL_PROVIDERS: 'foundry,anthropic',
        SENSOR_PROVIDER: 'anthropic',
      });
      expect(resolveSensorTarget()).toMatchObject({
        provider: 'anthropic',
        url: 'https://api.anthropic.com/v1/messages',
      });
      Object.assign(mockEnv, {
        MODEL_PROVIDERS: 'anthropic,foundry',
        SENSOR_PROVIDER: 'foundry',
      });
      expect(resolveSensorTarget()).toMatchObject({ provider: 'foundry' });
    });

    it('foundry first with incomplete Foundry settings: error, no request to any host', async () => {
      Object.assign(mockEnv, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        MODEL_PROVIDERS: 'foundry,anthropic',
      });
      const result = await evaluateBehaviourReply(REPLY, stubReader);
      expect(result.annotation).toBe('[sensor: error: no-foundry-settings]');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('anthropic followed with only a subscription token: no key, no request', async () => {
      Object.assign(mockEnv, {
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real-token',
        ANTHROPIC_BASE_URL: 'https://gw.example.edu',
      });
      expect(resolveSensorTarget()).toEqual({ error: 'no-api-key' });
      const result = await evaluateBehaviourReply(REPLY, stubReader);
      expect(result.annotation).toBe('[sensor: error: no-api-key]');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('an unknown first provider is an error, not a fallback', () => {
      Object.assign(mockEnv, FOUNDRY, {
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        MODEL_PROVIDERS: 'bedrock,anthropic',
      });
      expect(resolveSensorTarget()).toEqual({
        error: 'unknown-sensor-provider',
      });
    });
  });
});
