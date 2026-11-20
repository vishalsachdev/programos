/**
 * Review finding on PR 40 (Bugbot): a Linux host with no docker0 address
 * (rootless Docker, a missing `ip` command) could not start with the
 * restricted network, although that mode binds the credential proxy to the
 * restricted network's own gateway and never uses docker0. The address was
 * worked out when src/container-runtime.ts was loaded, and that threw.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => {
  delete process.env.CREDENTIAL_PROXY_HOST;
  delete process.env.CONTAINER_NETWORK;
  process.env.WEBHOOK_HOST = '127.0.0.1';
  return {
    state: { network: null as null | { internal: boolean; gateway: string } },
  };
});

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    platform: () => 'linux',
    networkInterfaces: () => ({}), // no docker0
  };
  return { ...mocked, default: mocked };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const mocked = {
    ...actual,
    existsSync: vi.fn((p: unknown) =>
      String(p).includes('WSLInterop') ? false : actual.existsSync(String(p)),
    ),
  };
  return { ...mocked, default: mocked };
});
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: vi.fn((bin: string, args: string[]) => {
      // No `ip` command, and a docker that knows networks only.
      if (bin !== 'docker') throw new Error(`spawnSync ${bin} ENOENT`);
      if (args[0] === 'network' && args[1] === 'inspect') {
        if (!state.network) throw new Error('No such network');
        return `${state.network.internal} ${state.network.gateway}\n`;
      }
      if (args[0] === 'network' && args[1] === 'create') {
        state.network = { internal: true, gateway: '172.20.0.1' };
        return 'id\n';
      }
      throw new Error(`unexpected docker ${args.join(' ')}`);
    }),
  };
});

import {
  _resetRestrictedNetworkForTests,
  detectProxyBindHost,
  resolveProxyBindHost,
} from './container-runtime.js';

describe('a Linux host with no docker0 address', () => {
  beforeEach(() => {
    state.network = null;
    _resetRestrictedNetworkForTests();
    delete process.env.CONTAINER_NETWORK;
    delete process.env.CREDENTIAL_PROXY_HOST;
  });

  it('has no docker0 address to find (the premise of this file)', () => {
    expect(() => detectProxyBindHost()).toThrow(/docker0 IPv4/);
  });

  it('restricted (the default on Linux): binds to the restricted network gateway', () => {
    expect(resolveProxyBindHost()).toBe('172.20.0.1');
  });

  it('open: still refuses to start without an address, and never widens the bind', () => {
    process.env.CONTAINER_NETWORK = 'open';
    expect(() => resolveProxyBindHost()).toThrow(/docker0 IPv4/);
  });
});
