/**
 * Credential proxy: routing by provider, the Foundry credential, the
 * path-prefix token, and the base URL path prefix. Uses local fake upstreams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import {
  startCredentialProxy,
  registerProxyCaller,
  revokeProxyCaller,
} from './credential-proxy.js';
import { logger } from './logger.js';
import {
  resetModelProviderState,
  selectProvider,
  setProviderChangeNotifier,
} from './model-provider.js';

const anthropicToken = 'a'.repeat(64);
const foundryToken = 'f'.repeat(64);
const ANTHROPIC_KEY = 'sk-ant-real-key';
const FOUNDRY_KEY = 'foundry-real-key';

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
}

function fakeUpstream(seen: Seen[], status: () => number) {
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url!, headers: { ...req.headers } });
    res.writeHead(status(), { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise<http.Server>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

function send(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'POST', path, headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      },
    );
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

describe('credential-proxy providers', () => {
  let proxy: http.Server;
  let anthropicUpstream: http.Server;
  let foundryUpstream: http.Server;
  let proxyPort: number;
  let anthropicSeen: Seen[];
  let foundrySeen: Seen[];
  let anthropicStatus: number;
  let foundryStatus: number;

  async function start(env: Record<string, string> = {}) {
    Object.assign(
      mockEnv,
      {
        MODEL_PROVIDERS: 'anthropic,foundry',
        ANTHROPIC_API_KEY: ANTHROPIC_KEY,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${(anthropicUpstream.address() as AddressInfo).port}`,
        ANTHROPIC_FOUNDRY_BASE_URL: `http://127.0.0.1:${(foundryUpstream.address() as AddressInfo).port}/anthropic`,
        ANTHROPIC_FOUNDRY_API_KEY: FOUNDRY_KEY,
      },
      env,
    );
    registerProxyCaller(anthropicToken);
    registerProxyCaller(foundryToken, 'foundry');
    proxy = await startCredentialProxy(0);
    proxyPort = (proxy.address() as AddressInfo).port;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetModelProviderState();
    anthropicSeen = [];
    foundrySeen = [];
    anthropicStatus = 200;
    foundryStatus = 200;
    anthropicUpstream = await fakeUpstream(
      anthropicSeen,
      () => anthropicStatus,
    );
    foundryUpstream = await fakeUpstream(foundrySeen, () => foundryStatus);
  });

  afterEach(async () => {
    revokeProxyCaller(anthropicToken);
    revokeProxyCaller(foundryToken);
    await new Promise<void>((r) => (proxy ? proxy.close(() => r()) : r()));
    await new Promise<void>((r) => anthropicUpstream.close(() => r()));
    await new Promise<void>((r) => foundryUpstream.close(() => r()));
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    resetModelProviderState();
  });

  it('routes each token to its own upstream with its own credential', async () => {
    await start();
    await send(proxyPort, '/v1/messages', {
      'x-nanoclaw-proxy-token': anthropicToken,
      'x-api-key': 'placeholder',
    });
    await send(proxyPort, '/anthropic/v1/messages', {
      'x-nanoclaw-proxy-token': foundryToken,
      'api-key': 'placeholder',
    });
    expect(anthropicSeen).toHaveLength(1);
    expect(anthropicSeen[0].url).toBe('/v1/messages');
    expect(anthropicSeen[0].headers['x-api-key']).toBe(ANTHROPIC_KEY);
    expect(foundrySeen).toHaveLength(1);
    expect(foundrySeen[0].url).toBe('/anthropic/v1/messages');
    expect(foundrySeen[0].headers['api-key']).toBe(FOUNDRY_KEY);
    // Neither upstream ever sees the other's key or the caller token.
    expect(JSON.stringify(anthropicSeen)).not.toContain(FOUNDRY_KEY);
    expect(JSON.stringify(foundrySeen)).not.toContain(ANTHROPIC_KEY);
    expect(JSON.stringify(foundrySeen)).not.toContain(foundryToken);
    expect(JSON.stringify(anthropicSeen)).not.toContain(anthropicToken);
  });

  it('Foundry: the real key replaces the placeholder in the header the caller used', async () => {
    await start();
    await send(proxyPort, '/anthropic/v1/messages', {
      'x-nanoclaw-proxy-token': foundryToken,
      'x-api-key': 'placeholder',
    });
    expect(foundrySeen[0].headers['x-api-key']).toBe(FOUNDRY_KEY);
    expect(foundrySeen[0].headers['api-key']).toBeUndefined();

    await send(proxyPort, '/anthropic/v1/messages', {
      'x-nanoclaw-proxy-token': foundryToken,
      'api-key': 'placeholder',
    });
    expect(foundrySeen[1].headers['api-key']).toBe(FOUNDRY_KEY);
    expect(foundrySeen[1].headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(foundrySeen)).not.toContain('placeholder');
  });

  it('Foundry: with no key header from the caller, sets FOUNDRY_KEY_HEADER (default api-key)', async () => {
    await start();
    await send(proxyPort, '/anthropic/v1/messages', {
      'x-nanoclaw-proxy-token': foundryToken,
    });
    expect(foundrySeen[0].headers['api-key']).toBe(FOUNDRY_KEY);
    expect(foundrySeen[0].headers['x-api-key']).toBeUndefined();
  });

  it('Foundry: FOUNDRY_KEY_HEADER=x-api-key is used when the caller sent no key header', async () => {
    await start({ FOUNDRY_KEY_HEADER: 'x-api-key' });
    await send(proxyPort, '/anthropic/v1/messages', {
      'x-nanoclaw-proxy-token': foundryToken,
    });
    expect(foundrySeen[0].headers['x-api-key']).toBe(FOUNDRY_KEY);
    expect(foundrySeen[0].headers['api-key']).toBeUndefined();
  });

  it('Foundry: an authorization header from the container is dropped', async () => {
    await start();
    await send(proxyPort, '/anthropic/v1/messages', {
      'x-nanoclaw-proxy-token': foundryToken,
      authorization: 'Bearer placeholder',
    });
    expect(foundrySeen[0].headers['authorization']).toBeUndefined();
    expect(foundrySeen[0].headers['api-key']).toBe(FOUNDRY_KEY);
  });

  it('accepts the token as a path prefix, strips it, and keeps it out of the logs', async () => {
    await start();
    const status = await send(
      proxyPort,
      `/_t/${foundryToken}/anthropic/v1/messages?beta=true`,
      { 'api-key': 'placeholder' },
    );
    expect(status).toBe(200);
    expect(foundrySeen[0].url).toBe('/anthropic/v1/messages?beta=true');
    expect(foundrySeen[0].headers['api-key']).toBe(FOUNDRY_KEY);

    // The Anthropic route takes a path token too.
    expect(await send(proxyPort, `/_t/${anthropicToken}/v1/messages`)).toBe(
      200,
    );
    expect(anthropicSeen[0].url).toBe('/v1/messages');

    for (const fn of [logger.info, logger.warn, logger.error, logger.debug]) {
      const logged = JSON.stringify(vi.mocked(fn).mock.calls);
      expect(logged).not.toContain(foundryToken);
      expect(logged).not.toContain(anthropicToken);
    }
  });

  it('logs the stripped path, never the token, when the upstream is unreachable', async () => {
    await start({
      ANTHROPIC_FOUNDRY_BASE_URL: 'http://127.0.0.1:59998/anthropic',
    });
    const status = await send(
      proxyPort,
      `/_t/${foundryToken}/anthropic/v1/messages`,
    );
    expect(status).toBe(502);
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).toContain('/anthropic/v1/messages');
    expect(logged).not.toContain(foundryToken);
    expect(logged).not.toContain('/_t/');
  });

  it('an unknown or revoked token still gets 401, in the header or the path', async () => {
    await start();
    const unknown = 'b'.repeat(64);
    expect(
      await send(proxyPort, '/v1/messages', {
        'x-nanoclaw-proxy-token': unknown,
      }),
    ).toBe(401);
    expect(await send(proxyPort, `/_t/${unknown}/anthropic/v1/messages`)).toBe(
      401,
    );
    expect(await send(proxyPort, '/_t/short/anthropic/v1/messages')).toBe(401);
    revokeProxyCaller(foundryToken);
    expect(
      await send(proxyPort, `/_t/${foundryToken}/anthropic/v1/messages`),
    ).toBe(401);
    expect(anthropicSeen).toHaveLength(0);
    expect(foundrySeen).toHaveLength(0);
  });

  it('Anthropic route: joins a path prefix in ANTHROPIC_BASE_URL to the request path', async () => {
    const port = (anthropicUpstream.address() as AddressInfo).port;
    await start({
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/gateway/claude/`,
    });
    await send(proxyPort, '/v1/messages?beta=true', {
      'x-nanoclaw-proxy-token': anthropicToken,
    });
    expect(anthropicSeen[0].url).toBe('/gateway/claude/v1/messages?beta=true');
    expect(anthropicSeen[0].headers['x-api-key']).toBe(ANTHROPIC_KEY);
  });

  it('a Foundry token is refused when Foundry is not configured', async () => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
    Object.assign(mockEnv, {
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(anthropicUpstream.address() as AddressInfo).port}`,
    });
    registerProxyCaller(foundryToken, 'foundry');
    proxy = await startCredentialProxy(0);
    proxyPort = (proxy.address() as AddressInfo).port;
    expect(
      await send(proxyPort, '/anthropic/v1/messages', {
        'x-nanoclaw-proxy-token': foundryToken,
      }),
    ).toBe(502);
    expect(anthropicSeen).toHaveLength(0);
  });

  it('a listed provider with missing settings stops the proxy from starting', () => {
    Object.assign(mockEnv, {
      MODEL_PROVIDERS: 'anthropic,foundry',
      ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    });
    expect(() => startCredentialProxy(0)).toThrow(/lists foundry/);
  });

  it('feeds the breaker: three 5xx answers move the next run to Foundry, with one notice', async () => {
    await start();
    const notify = vi.fn();
    setProviderChangeNotifier(notify);
    expect(selectProvider()).toBe('anthropic');
    anthropicStatus = 529;
    for (let i = 0; i < 3; i++)
      await send(proxyPort, '/v1/messages', {
        'x-nanoclaw-proxy-token': anthropicToken,
      });
    expect(selectProvider()).toBe('foundry');
    expect(selectProvider()).toBe('foundry');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('anthropic → foundry');
  });

  it('feeds the breaker: a 2xx between failures keeps the provider', async () => {
    await start();
    for (const status of [401, 429, 200, 500, 503]) {
      anthropicStatus = status;
      await send(proxyPort, '/v1/messages', {
        'x-nanoclaw-proxy-token': anthropicToken,
      });
    }
    expect(selectProvider()).toBe('anthropic');
  });

  it('feeds the breaker: an unreachable upstream counts as a failure', async () => {
    await start({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:59997' });
    for (let i = 0; i < 3; i++)
      expect(
        await send(proxyPort, '/v1/messages', {
          'x-nanoclaw-proxy-token': anthropicToken,
        }),
      ).toBe(502);
    expect(selectProvider()).toBe('foundry');
  });
});
