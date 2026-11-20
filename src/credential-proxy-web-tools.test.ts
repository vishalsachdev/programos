/**
 * Credential proxy with web tools off: the check in src/web-tools.ts applied
 * to real requests, on the Anthropic route and on the Foundry route. Uses
 * local fake upstreams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { gzipSync } from 'zlib';

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
import { resetModelProviderState } from './model-provider.js';

const anthropicToken = 'a'.repeat(64);
const foundryToken = 'f'.repeat(64);

interface Seen {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function fakeUpstream(seen: Seen[]) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        url: req.url!,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return new Promise<http.Server>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server)),
  );
}

function send(
  port: number,
  path: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
  method = 'POST',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const WEB = { type: 'web_search_20250305', name: 'web_search' };
const ESCAPED = '{"tools":[{"type":"web\\u005fsearch_20250305","name":"w"}]}';

describe('credential proxy, web tools off', () => {
  let proxy: http.Server;
  let anthropicUpstream: http.Server;
  let foundryUpstream: http.Server;
  let port: number;
  let anthropicSeen: Seen[];
  let foundrySeen: Seen[];

  async function start(env: Record<string, string> = {}) {
    Object.assign(
      mockEnv,
      {
        MODEL_PROVIDERS: 'anthropic,foundry',
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${(anthropicUpstream.address() as AddressInfo).port}`,
        ANTHROPIC_FOUNDRY_BASE_URL: `http://127.0.0.1:${(foundryUpstream.address() as AddressInfo).port}/anthropic`,
        ANTHROPIC_FOUNDRY_API_KEY: 'foundry-real-key',
      },
      env,
    );
    registerProxyCaller(anthropicToken);
    registerProxyCaller(foundryToken, 'foundry');
    proxy = await startCredentialProxy(0);
    port = (proxy.address() as AddressInfo).port;
  }

  /** The same request on each route: header token, and Foundry path token. */
  const routes = [
    {
      name: 'anthropic',
      path: (p: string) => p,
      headers: { 'x-nanoclaw-proxy-token': anthropicToken },
      seen: () => anthropicSeen,
    },
    {
      name: 'foundry (path token)',
      path: (p: string) => `/_t/${foundryToken}/anthropic${p}`,
      headers: {} as Record<string, string>,
      seen: () => foundrySeen,
    },
  ];

  beforeEach(async () => {
    vi.clearAllMocks();
    resetModelProviderState();
    anthropicSeen = [];
    foundrySeen = [];
    anthropicUpstream = await fakeUpstream(anthropicSeen);
    foundryUpstream = await fakeUpstream(foundrySeen);
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

  for (const route of routes) {
    describe(route.name, () => {
      const refusedCases: [string, string, string | Buffer, object?][] = [
        ['a web search tool', '/v1/messages', JSON.stringify({ tools: [WEB] })],
        ['a tool type written with an escape', '/v1/messages', ESCAPED],
        ['a body that is not JSON', '/v1/messages', '{"tools":[{"type":"web'],
        [
          'a web tool inside a batch',
          '/v1/messages/batches',
          JSON.stringify({ requests: [{ params: { tools: [WEB] } }] }),
        ],
        [
          'a gzip body',
          '/v1/messages',
          gzipSync(JSON.stringify({ tools: [WEB] })),
          { 'content-encoding': 'gzip' },
        ],
        [
          'a remote MCP server',
          '/v1/messages',
          JSON.stringify({
            mcp_servers: [
              { type: 'url', name: 'x', url: 'https://example.org/mcp' },
            ],
          }),
        ],
        [
          'a URL the provider would download',
          '/v1/messages',
          JSON.stringify({
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: { type: 'url', url: 'https://example.org/a' },
                  },
                ],
              },
            ],
          }),
        ],
        ['the managed agents API', '/v1/sessions', '{}'],
        ['a path with dot segments', '/api/../v1/messages', '{}'],
      ];

      for (const [what, path, body, extra] of refusedCases) {
        it(`refuses ${what} and does not contact the provider`, async () => {
          await start();
          const res = await send(port, route.path(path), body, {
            ...route.headers,
            ...(extra as Record<string, string>),
          });
          expect(res.status).toBe(403);
          expect(res.body).toContain('web tools are off');
          expect(anthropicSeen).toEqual([]);
          expect(foundrySeen).toEqual([]);
          // The token prefix of a path is never logged.
          expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(
            /[af]{64}/,
          );
        });
      }

      it('forwards an ordinary request as the JSON it checked', async () => {
        await start();
        const res = await send(
          port,
          route.path('/v1/messages?beta=true'),
          '{"max_tokens": 5, "messages": [], "max_tokens": 7}',
          route.headers,
        );
        expect(res.status).toBe(200);
        const seen = route.seen();
        expect(seen).toHaveLength(1);
        expect(seen[0].body).toBe('{"max_tokens":7,"messages":[]}');
        expect(seen[0].headers['content-length']).toBe(
          String(seen[0].body.length),
        );
      });

      it('forwards every one of these when AGENT_WEB_TOOLS is on, byte for byte', async () => {
        await start({ AGENT_WEB_TOOLS: '1' });
        const res = await send(
          port,
          route.path('/v1/messages'),
          ESCAPED,
          route.headers,
        );
        expect(res.status).toBe(200);
        expect(route.seen()[0].body).toBe(ESCAPED);
      });
    });
  }

  it('reports a tool type it does not know once, and still forwards', async () => {
    await start();
    const body = JSON.stringify({
      tools: [{ type: 'unit_test_new_tool_20990101', name: 'n' }],
    });
    const headers = { 'x-nanoclaw-proxy-token': anthropicToken };
    expect((await send(port, '/v1/messages', body, headers)).status).toBe(200);
    expect((await send(port, '/v1/messages', body, headers)).status).toBe(200);
    const calls = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) =>
        JSON.stringify(c[0]).includes('unit_test_new_tool_20990101'),
      );
    expect(calls).toHaveLength(1);
    expect(anthropicSeen).toHaveLength(2);
  });

  it('refuses a path that is not on the list, and logs it once without the token', async () => {
    await start();
    for (let i = 0; i < 2; i++) {
      const byHeader = await send(port, '/v1/code/sessions', '{}', {
        'x-nanoclaw-proxy-token': anthropicToken,
        authorization: 'Bearer placeholder',
      });
      expect(byHeader.status).toBe(403);
      const byPath = await send(
        port,
        `/_t/${foundryToken}/anthropic/v1/files`,
        '--b\r\n',
      );
      expect(byPath.status).toBe(403);
    }
    expect(anthropicSeen).toEqual([]);
    expect(foundrySeen).toEqual([]);
    const logged = vi
      .mocked(logger.warn)
      .mock.calls.map((c) => (c[0] as { pathClass?: string }).pathClass);
    expect(logged).toEqual(['/v1/code/sessions', '/anthropic/v1/files']);
  });

  it('keeps the OAuth key exchange and requests with no body working', async () => {
    await start({
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: 'real-oauth-token',
    });
    const headers = {
      'x-nanoclaw-proxy-token': anthropicToken,
      authorization: 'Bearer placeholder',
    };
    const exchange = await send(
      port,
      '/api/oauth/claude_cli/create_api_key',
      '',
      headers,
    );
    expect(exchange.status).toBe(200);
    expect(anthropicSeen[0].headers.authorization).toBe(
      'Bearer real-oauth-token',
    );
    const models = await send(port, '/v1/models', '', headers, 'GET');
    expect(models.status).toBe(200);
    expect(anthropicSeen).toHaveLength(2);
  });
});
