/**
 * The container's network setting (CONTAINER_NETWORK): the arguments the
 * host passes to `docker run` for both values, and the address the
 * credential proxy binds to. Real container-runtime.ts and
 * container-runner.ts; only the docker binary is faked.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dockerCalls, state } = vi.hoisted(() => ({
  dockerCalls: [] as string[][],
  state: {
    network: null as null | { internal: boolean; gateway: string },
    platform: 'linux',
    wsl: false,
  },
}));

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
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    platform: () => state.platform,
    networkInterfaces: () => ({
      docker0: [{ family: 'IPv4', address: '172.17.0.1' }],
    }),
  };
  return { ...mocked, default: mocked };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn((p: unknown) =>
        String(p).includes('WSLInterop') ? state.wsl : false,
      ),
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
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
  registerProxyCaller: vi.fn(),
  revokeProxyCaller: vi.fn(),
}));

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}
let proc: ReturnType<typeof fakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => proc),
    // A fake docker: `network inspect` and `network create` only.
    execFileSync: vi.fn((bin: string, args: string[]) => {
      if (bin !== 'docker') throw new Error(`unexpected command ${bin}`);
      dockerCalls.push(args);
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (!state.network) throw new Error('No such network');
        return `${state.network.internal} ${state.network.gateway}\n`;
      }
      if (args[0] === 'network' && args[1] === 'create') {
        state.network = {
          internal: args.includes('--internal'),
          gateway: '172.20.0.1',
        };
        return 'id\n';
      }
      throw new Error(`unexpected docker ${args.join(' ')}`);
    }),
  };
});

import { spawn } from 'child_process';

import { runContainerAgent } from './container-runner.js';
import {
  _resetRestrictedNetworkForTests,
  hostGatewayArgs,
  PROXY_BIND_HOST,
  resolveContainerNetworkMode,
  resolveProxyBindHost,
} from './container-runtime.js';
import { logger } from './logger.js';
import type { RegisteredGroup } from './types.js';

const group: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};
const input = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

/** The argv the host would pass to `docker run` for one agent turn. */
async function runArgs(): Promise<string[]> {
  const result = runContainerAgent(group, input, () => {});
  const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
  proc.emit('close', 0);
  await result;
  return args;
}

beforeEach(() => {
  vi.clearAllMocks();
  dockerCalls.length = 0;
  state.network = null;
  state.platform = 'linux';
  state.wsl = false;
  proc = fakeProcess();
  _resetRestrictedNetworkForTests();
  delete process.env.CONTAINER_NETWORK;
  delete process.env.AGENT_WEB_TOOLS;
  delete process.env.CREDENTIAL_PROXY_HOST;
  // The deployment recipe's value. The tests of the warning change it.
  process.env.WEBHOOK_HOST = '127.0.0.1';
});
afterEach(() => {
  delete process.env.WEBHOOK_HOST;
  delete process.env.CONTAINER_NETWORK;
  delete process.env.AGENT_WEB_TOOLS;
});

describe('CONTAINER_NETWORK value', () => {
  it('defaults to restricted on Linux and to open on Docker Desktop', () => {
    expect(resolveContainerNetworkMode(undefined, false)).toBe('restricted');
    expect(resolveContainerNetworkMode('', false)).toBe('restricted');
    expect(resolveContainerNetworkMode(undefined, true)).toBe('open');
  });

  it('accepts the two values on any platform', () => {
    expect(resolveContainerNetworkMode('open', false)).toBe('open');
    expect(resolveContainerNetworkMode(' Restricted ', true)).toBe(
      'restricted',
    );
  });

  it('refuses any other value instead of guessing', () => {
    expect(() => resolveContainerNetworkMode('none', false)).toThrow(
      /restricted.*open/,
    );
  });
});

describe('docker run arguments', () => {
  it('restricted (the default): joins the internal network and names its gateway', async () => {
    const args = await runArgs();
    const at = args.indexOf('--network');
    expect(args[at + 1]).toBe('nanoclaw-agents');
    expect(args).toContain('--add-host=host.docker.internal:172.20.0.1');
    expect(args).not.toContain('--add-host=host.docker.internal:host-gateway');
    // The model endpoint is still the host credential proxy.
    expect(args).toContain(
      'ANTHROPIC_BASE_URL=http://host.docker.internal:3001',
    );
    // The network was created internal, with container-to-container traffic off.
    expect(dockerCalls).toContainEqual([
      'network',
      'create',
      '--internal',
      '-o',
      'com.docker.network.bridge.enable_icc=false',
      'nanoclaw-agents',
    ]);
  });

  it('open: no --network argument, the default bridge and host-gateway', async () => {
    process.env.CONTAINER_NETWORK = 'open';
    const args = await runArgs();
    expect(args).not.toContain('--network');
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    expect(dockerCalls).toEqual([]);
  });

  it('restricted reuses an existing internal network without creating one', () => {
    state.network = { internal: true, gateway: '10.99.0.1' };
    expect(hostGatewayArgs()).toEqual([
      '--network',
      'nanoclaw-agents',
      '--add-host=host.docker.internal:10.99.0.1',
    ]);
    expect(dockerCalls.some((c) => c[1] === 'create')).toBe(false);
  });

  it('restricted refuses a network of that name that is not internal', () => {
    state.network = { internal: false, gateway: '10.99.0.1' };
    expect(() => hostGatewayArgs()).toThrow(/not internal/);
  });

  it('restricted on Docker Desktop leaves host.docker.internal to the runtime', () => {
    state.platform = 'darwin';
    process.env.CONTAINER_NETWORK = 'restricted';
    expect(hostGatewayArgs()).toEqual(['--network', 'nanoclaw-agents']);
  });

  it('open on Docker Desktop passes no network arguments', () => {
    state.platform = 'darwin';
    expect(hostGatewayArgs()).toEqual([]);
  });

  it('web tools: NANOCLAW_WEB_TOOLS reaches the container only when AGENT_WEB_TOOLS is on', async () => {
    expect(await runArgs()).not.toContain('NANOCLAW_WEB_TOOLS=1');
    proc = fakeProcess();
    process.env.AGENT_WEB_TOOLS = '1';
    expect(await runArgs()).toContain('NANOCLAW_WEB_TOOLS=1');
  });
});

describe('credential proxy bind address', () => {
  it('restricted: the internal network gateway, so those containers reach it', () => {
    expect(resolveProxyBindHost()).toBe('172.20.0.1');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('open: the address used before this setting existed, with a loud warning', () => {
    process.env.CONTAINER_NETWORK = 'open';
    // docker0's address, or CREDENTIAL_PROXY_HOST when the runner sets it.
    expect(resolveProxyBindHost()).toBe(PROXY_BIND_HOST);
    expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatch(
      /CONTAINER_NETWORK is open/,
    );
    expect(dockerCalls).toEqual([]);
  });

  it('restricted ignores a CREDENTIAL_PROXY_HOST the containers could not reach, and says so', () => {
    process.env.CREDENTIAL_PROXY_HOST = '127.0.0.1';
    expect(resolveProxyBindHost()).toBe('172.20.0.1');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toMatch(
      /CREDENTIAL_PROXY_HOST is ignored/,
    );
    process.env.CREDENTIAL_PROXY_HOST = '0.0.0.0';
    expect(resolveProxyBindHost()).toBe('0.0.0.0');
  });

  it('restricted warns at start when the webhook listener is not on loopback', () => {
    const warned = () =>
      JSON.stringify(vi.mocked(logger.warn).mock.calls).includes(
        'WEBHOOK_HOST',
      );
    // Unset: the listener's default is all interfaces.
    for (const host of [undefined, '0.0.0.0', '::', '192.0.2.10']) {
      vi.clearAllMocks();
      if (host === undefined) delete process.env.WEBHOOK_HOST;
      else process.env.WEBHOOK_HOST = host;
      resolveProxyBindHost();
      expect(warned()).toBe(true);
    }
    for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1']) {
      vi.clearAllMocks();
      process.env.WEBHOOK_HOST = host;
      resolveProxyBindHost();
      expect(warned()).toBe(false);
    }
  });

  it('restricted on Docker Desktop gives the same webhook warning', () => {
    state.platform = 'darwin';
    process.env.CONTAINER_NETWORK = 'restricted';
    delete process.env.WEBHOOK_HOST;
    resolveProxyBindHost();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).toMatch(
      /WEBHOOK_HOST/,
    );
  });

  it('open does not give the webhook warning: the open warning covers it', () => {
    process.env.CONTAINER_NETWORK = 'open';
    delete process.env.WEBHOOK_HOST;
    resolveProxyBindHost();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(
      /WEBHOOK_HOST/,
    );
  });
});
