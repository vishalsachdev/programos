/**
 * Container runner: what the container is given for each model provider.
 * The invariant: no real credential in the container args, and the per-run
 * proxy token in no log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: 'America/Los_Angeles',
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

vi.mock('./host-fs-safety.js', () => ({
  chownTreeNoFollow: vi.fn(),
  copyDirInTree: vi.fn(),
  ensureDirInTree: vi.fn((root: string) => root),
  writeFileInTree: vi.fn(),
}));

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
  registerProxyCaller: vi.fn(),
  revokeProxyCaller: vi.fn(),
}));

// The real module, on a mocked `.env`, so the settings-to-args path is real.
const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) =>
    Object.fromEntries(
      Object.entries(mockEnv).filter(([k]) => keys.includes(k)),
    ),
  ),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { spawn } from 'child_process';
import { logger } from './logger.js';
import { registerProxyCaller, revokeProxyCaller } from './credential-proxy.js';
import { writeFileInTree } from './host-fs-safety.js';
import { runContainerAgent } from './container-runner.js';
import {
  recordProviderResult,
  resetModelProviderState,
} from './model-provider.js';
import type { RegisteredGroup } from './types.js';

const ANTHROPIC_KEY = 'sk-ant-real-key';
const FOUNDRY_KEY = 'foundry-real-key';
const FOUNDRY_ENV = {
  MODEL_PROVIDERS: 'foundry,anthropic',
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  ANTHROPIC_FOUNDRY_RESOURCE: 'unit-resource',
  ANTHROPIC_FOUNDRY_API_KEY: FOUNDRY_KEY,
};

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};
const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function setEnv(env: Record<string, string>) {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  Object.assign(mockEnv, env);
  resetModelProviderState();
}

/** Start a run, end it with a non-zero exit (so the full run log is written). */
async function runOnce(): Promise<{
  args: string[];
  env: Map<string, string>;
}> {
  fakeProc = createFakeProcess();
  const result = runContainerAgent(testGroup, testInput, () => {});
  const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
  fakeProc.emit('close', 1);
  await vi.advanceTimersByTimeAsync(10);
  await result;
  const env = new Map<string, string>();
  args.forEach((arg, i) => {
    if (args[i - 1] !== '-e') return;
    const eq = arg.indexOf('=');
    env.set(arg.slice(0, eq), arg.slice(eq + 1));
  });
  return { args, env };
}

function allLogged(): string {
  return JSON.stringify([
    vi.mocked(logger.debug).mock.calls,
    vi.mocked(logger.info).mock.calls,
    vi.mocked(logger.warn).mock.calls,
    vi.mocked(logger.error).mock.calls,
    vi.mocked(writeFileInTree).mock.calls,
  ]);
}

describe('container-runner model provider', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    delete process.env.NANOCLAW_AGENT_MODEL;
    delete process.env.NANOCLAW_GATE_MODEL;
    setEnv({});
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...savedEnv };
    setEnv({});
  });

  it('with no settings, the container env is exactly the Anthropic set', async () => {
    const { env } = await runOnce();
    expect([...env.keys()].sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'TZ',
    ]);
    expect(env.get('ANTHROPIC_BASE_URL')).toBe(
      'http://host.docker.internal:3001',
    );
    expect(env.get('ANTHROPIC_API_KEY')).toBe('placeholder');
    const token = env.get('ANTHROPIC_CUSTOM_HEADERS')!.split(': ')[1];
    // One argument, as before the provider setting existed.
    expect(registerProxyCaller).toHaveBeenCalledWith(token);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic' }),
      'Spawning container agent',
    );
  });

  it('Foundry selected: Foundry env set, Anthropic env absent', async () => {
    setEnv({
      ...FOUNDRY_ENV,
      FOUNDRY_OPUS_MODEL: 'claude-opus-5-5',
      FOUNDRY_SONNET_MODEL: 'claude-sonnet-5-5',
      FOUNDRY_HAIKU_MODEL: 'claude-haiku-5-5',
    });
    const { env } = await runOnce();
    expect(env.get('CLAUDE_CODE_USE_FOUNDRY')).toBe('1');
    expect(env.get('ANTHROPIC_FOUNDRY_API_KEY')).toBe('placeholder');
    expect(env.get('ANTHROPIC_FOUNDRY_BASE_URL')).toMatch(
      /^http:\/\/host\.docker\.internal:3001\/_t\/[0-9a-f]{64}\/anthropic$/,
    );
    expect(env.get('ANTHROPIC_CUSTOM_HEADERS')).toMatch(
      /^X-NanoClaw-Proxy-Token: [0-9a-f]{64}$/,
    );
    expect(env.get('ANTHROPIC_DEFAULT_OPUS_MODEL')).toBe('claude-opus-5-5');
    expect(env.get('ANTHROPIC_DEFAULT_SONNET_MODEL')).toBe('claude-sonnet-5-5');
    expect(env.get('ANTHROPIC_DEFAULT_HAIKU_MODEL')).toBe('claude-haiku-5-5');
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_FOUNDRY_RESOURCE',
    ])
      expect(env.has(key)).toBe(false);

    // The same token in the header, the URL and the registration.
    const token = env.get('ANTHROPIC_CUSTOM_HEADERS')!.split(': ')[1];
    expect(env.get('ANTHROPIC_FOUNDRY_BASE_URL')).toContain(`/_t/${token}/`);
    expect(registerProxyCaller).toHaveBeenCalledWith(token, 'foundry');
    expect(revokeProxyCaller).toHaveBeenCalledWith(token);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'foundry' }),
      'Spawning container agent',
    );
  });

  it('Foundry selected: the base URL carries the path of a custom Foundry URL', async () => {
    setEnv({
      ...FOUNDRY_ENV,
      ANTHROPIC_FOUNDRY_BASE_URL: 'https://gw.example.edu/unit/anthropic/',
    });
    const { env } = await runOnce();
    expect(env.get('ANTHROPIC_FOUNDRY_BASE_URL')).toMatch(
      /^http:\/\/host\.docker\.internal:3001\/_t\/[0-9a-f]{64}\/unit\/anthropic$/,
    );
    expect(env.get('ANTHROPIC_FOUNDRY_BASE_URL')).not.toContain('gw.example');
  });

  it('Foundry selected: no model pins unless set', async () => {
    setEnv(FOUNDRY_ENV);
    const { env } = await runOnce();
    for (const key of [...env.keys()])
      expect(key.startsWith('ANTHROPIC_DEFAULT_')).toBe(false);
    expect(env.has('NANOCLAW_AGENT_MODEL')).toBe(false);
  });

  it('FOUNDRY_AGENT_MODEL and FOUNDRY_GATE_MODEL override the model settings on a Foundry run only', async () => {
    process.env.NANOCLAW_AGENT_MODEL = 'claude-opus-5-5';
    process.env.NANOCLAW_GATE_MODEL = 'opus';
    setEnv({
      ...FOUNDRY_ENV,
      FOUNDRY_AGENT_MODEL: 'agent-deployment',
      FOUNDRY_GATE_MODEL: 'gate-deployment',
    });
    let { env } = await runOnce();
    expect(env.get('NANOCLAW_AGENT_MODEL')).toBe('agent-deployment');
    expect(env.get('NANOCLAW_GATE_MODEL')).toBe('gate-deployment');

    setEnv({
      ...FOUNDRY_ENV,
      MODEL_PROVIDERS: 'anthropic,foundry',
      FOUNDRY_AGENT_MODEL: 'agent-deployment',
      FOUNDRY_GATE_MODEL: 'gate-deployment',
    });
    ({ env } = await runOnce());
    expect(env.get('NANOCLAW_AGENT_MODEL')).toBe('claude-opus-5-5');
    expect(env.get('NANOCLAW_GATE_MODEL')).toBe('opus');
    expect(env.has('CLAUDE_CODE_USE_FOUNDRY')).toBe(false);
  });

  it.each([
    ['anthropic first', 'anthropic,foundry'],
    ['foundry first', 'foundry,anthropic'],
  ])('no real key anywhere in the container args (%s)', async (_n, order) => {
    setEnv({ ...FOUNDRY_ENV, MODEL_PROVIDERS: order });
    const { args } = await runOnce();
    const joined = args.join('\n');
    expect(joined).not.toContain(ANTHROPIC_KEY);
    expect(joined).not.toContain(FOUNDRY_KEY);
    expect(joined).not.toContain('unit-resource');
    expect(allLogged()).not.toContain(ANTHROPIC_KEY);
    expect(allLogged()).not.toContain(FOUNDRY_KEY);
  });

  it('the token is redacted in every log and in the run log, on both routes', async () => {
    for (const order of ['foundry,anthropic', 'anthropic,foundry']) {
      vi.clearAllMocks();
      setEnv({ ...FOUNDRY_ENV, MODEL_PROVIDERS: order });
      const { env } = await runOnce();
      const token = env.get('ANTHROPIC_CUSTOM_HEADERS')!.split(': ')[1];
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const logged = allLogged();
      expect(logged).not.toContain(token);
      expect(logged).not.toContain('/_t/');
      // The args were logged, with the token-bearing values replaced.
      expect(logged).toContain('ANTHROPIC_CUSTOM_HEADERS=[REDACTED]');
      if (order.startsWith('foundry'))
        expect(logged).toContain('ANTHROPIC_FOUNDRY_BASE_URL=[REDACTED]');
    }
  });

  it('records the provider in the run log', async () => {
    setEnv(FOUNDRY_ENV);
    await runOnce();
    const runLog = vi.mocked(writeFileInTree).mock.calls.at(-1)!;
    expect(JSON.stringify(runLog)).toContain('Provider: foundry');
  });

  it('selects once per run: after the primary trips, the next run is on the backup', async () => {
    setEnv({ ...FOUNDRY_ENV, MODEL_PROVIDERS: 'anthropic,foundry' });
    let { env } = await runOnce();
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(true);
    for (let i = 0; i < 3; i++)
      recordProviderResult('anthropic', { status: 529 });
    ({ env } = await runOnce());
    expect(env.get('CLAUDE_CODE_USE_FOUNDRY')).toBe('1');
    expect(env.has('ANTHROPIC_BASE_URL')).toBe(false);
  });
});
