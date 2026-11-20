import { gzipSync } from 'zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

import {
  checkProxyRequest,
  classifyProxyPath,
  type ProxyRequestVerdict,
  webToolsEnabled,
} from './web-tools.js';

const runnerTools = (await import(
  new URL('../container/agent-runner/src/allowed-tools.ts', import.meta.url)
    .href
)) as {
  normalAllowedTools: (env: Record<string, string | undefined>) => string[];
  disallowedTools: (env: Record<string, string | undefined>) => string[];
};

afterEach(() => {
  delete process.env.AGENT_WEB_TOOLS;
  delete mockEnv.AGENT_WEB_TOOLS;
});

describe('AGENT_WEB_TOOLS on the host', () => {
  it('is off when unset', () => {
    expect(webToolsEnabled()).toBe(false);
  });

  it('is on for 1, true and on, from the process environment or .env', () => {
    for (const v of ['1', 'true', 'ON']) {
      process.env.AGENT_WEB_TOOLS = v;
      expect(webToolsEnabled()).toBe(true);
    }
    delete process.env.AGENT_WEB_TOOLS;
    mockEnv.AGENT_WEB_TOOLS = '1';
    expect(webToolsEnabled()).toBe(true);
  });

  it('stays off for any other value', () => {
    for (const v of ['0', 'false', 'off', 'yes please']) {
      process.env.AGENT_WEB_TOOLS = v;
      expect(webToolsEnabled()).toBe(false);
    }
  });
});

describe('the tool list in the container', () => {
  it('leaves the web tools out, and removes them, by default', () => {
    const allowed = runnerTools.normalAllowedTools({});
    expect(allowed).not.toContain('WebSearch');
    expect(allowed).not.toContain('WebFetch');
    expect(allowed).toContain('Bash');
    expect(allowed).toContain('mcp__nanoclaw__*');
    expect(runnerTools.disallowedTools({})).toEqual(['WebSearch', 'WebFetch']);
  });

  it('includes them only when NANOCLAW_WEB_TOOLS is exactly 1', () => {
    const on = { NANOCLAW_WEB_TOOLS: '1' };
    expect(runnerTools.normalAllowedTools(on)).toEqual(
      expect.arrayContaining(['WebSearch', 'WebFetch', 'Bash']),
    );
    expect(runnerTools.disallowedTools(on)).toEqual([]);
    expect(
      runnerTools.normalAllowedTools({ NANOCLAW_WEB_TOOLS: 'true' }),
    ).not.toContain('WebSearch');
  });

  it('does not change the other tools', () => {
    const off = runnerTools.normalAllowedTools({});
    const on = runnerTools.normalAllowedTools({ NANOCLAW_WEB_TOOLS: '1' });
    expect(on.filter((t) => !t.startsWith('Web'))).toEqual(off);
  });
});

describe('checkProxyRequest (the proxy check while web tools are off)', () => {
  const json = (o: unknown) => Buffer.from(JSON.stringify(o));
  const web = { type: 'web_search_20250305', name: 'web_search' };
  const check = (
    body: Buffer,
    path = '/v1/messages?beta=true',
    contentEncoding?: string,
  ) => checkProxyRequest({ path, body, contentEncoding });
  const refused = (v: ProxyRequestVerdict) =>
    v.allow ? 'allowed' : `refused: ${v.reason}`;

  it('refuses a provider-side web search or web fetch tool', () => {
    expect(refused(check(json({ tools: [web] })))).toMatch(/web search/);
    expect(
      refused(
        check(
          json({ tools: [{ name: 'Bash' }, { type: 'web_fetch_20260309' }] }),
        ),
      ),
    ).toMatch(/web search or web fetch/);
    // A version this code has never seen.
    expect(
      refused(check(json({ tools: [{ type: 'web_search_20990101' }] }))),
    ).toMatch(/^refused/);
  });

  it('refuses a tool type written with a JSON escape', () => {
    const body = Buffer.from(
      '{"tools":[{"type":"web\\u005fsearch_20250305","name":"w"}]}',
    );
    expect(body.includes('web_search')).toBe(false);
    expect(refused(check(body))).toMatch(/web search/);
  });

  it('refuses a model request whose body is not UTF-8 JSON', () => {
    for (const body of [
      Buffer.from('{"tools":[{"type":"web_search_20250305"}'),
      Buffer.from('web_search not json'),
      Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]),
      json([{ tools: [web] }]),
      json('text'),
    ]) {
      expect(refused(check(body))).toMatch(/not UTF-8 JSON|not a JSON object/);
      expect(refused(check(body, '/v1/messages/count_tokens'))).toMatch(
        /^refused/,
      );
      expect(refused(check(body, '/anthropic/v1/messages'))).toMatch(
        /^refused/,
      );
    }
  });

  it('refuses a web tool nested in a batch, or deeper', () => {
    const batch = json({
      requests: [{ custom_id: 'a', params: { messages: [], tools: [web] } }],
    });
    expect(refused(check(batch, '/v1/messages/batches'))).toMatch(/web search/);
    expect(
      refused(check(json({ a: [{ b: { c: { tools: [web] } } }] }))),
    ).toMatch(/web search/);
  });

  it('refuses a body with a content encoding, on any path', () => {
    const gz = gzipSync(json({ tools: [web] }));
    for (const path of ['/v1/messages', '/api/hello', '/v1/files']) {
      expect(refused(check(gz, path, 'gzip'))).toMatch(/content encoding/);
      expect(refused(check(json({}), path, 'br'))).toMatch(/content encoding/);
    }
    // Compressed bytes with no header are not JSON.
    expect(refused(check(gz))).toMatch(/not UTF-8 JSON/);
    expect(refused(check(json({}), '/v1/messages', 'identity'))).toBe(
      'allowed',
    );
  });

  it('sends on what it checked: a duplicate key cannot hide a tool', () => {
    const first = check(
      Buffer.from('{"tools":[{"type":"web_search_20250305"}],"tools":[]}'),
    );
    // The parser keeps the last value, and only that value is sent on.
    expect(first.allow && first.body.toString()).toBe('{"tools":[]}');
    const last = check(
      Buffer.from('{"tools":[],"tools":[{"type":"web_search_20250305"}]}'),
    );
    expect(refused(last)).toMatch(/web search/);
    const bom = check(Buffer.from('﻿{"max_tokens": 1}'));
    expect(bom.allow && bom.body.toString()).toBe('{"max_tokens":1}');
  });

  it('refuses the remote MCP connector', () => {
    const server = { type: 'url', name: 'x', url: 'https://example.org/mcp' };
    expect(refused(check(json({ mcp_servers: [server] })))).toMatch(
      /mcp_servers/,
    );
    expect(
      refused(
        check(
          json({ requests: [{ params: { mcp_servers: [server] } }] }),
          '/v1/messages/batches',
        ),
      ),
    ).toMatch(/mcp_servers/);
    expect(
      refused(
        check(json({ tools: [{ type: 'mcp_toolset', mcp_server_name: 'x' }] })),
      ),
    ).toMatch(/mcp_toolset/);
    expect(refused(check(json({ mcp_servers: [] })))).toBe('allowed');
  });

  it('refuses an image or document the provider would download', () => {
    for (const type of ['image', 'document']) {
      const body = json({
        messages: [
          {
            role: 'user',
            content: [
              { type, source: { type: 'url', url: 'https://example.org/a' } },
            ],
          },
        ],
      });
      expect(refused(check(body))).toMatch(/download a URL/);
    }
    const inline = json({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
            },
          ],
        },
      ],
    });
    expect(refused(check(inline))).toBe('allowed');
  });

  it('refuses the managed agents API by path, in any letter case', () => {
    for (const path of [
      '/v1/agents',
      '/v1/sessions/abc/events?beta=true',
      '/v1/environments',
      '/V1/Sessions',
      '/anthropic/v1/agents/',
    ]) {
      expect(refused(check(json({}), path))).toMatch(/managed agents/);
      expect(refused(check(Buffer.alloc(0), path))).toMatch(/managed agents/);
    }
    expect(
      refused(check(json({ tools: [{ type: 'agent_toolset_20260401' }] }))),
    ).toMatch(/managed agent tool set/);
  });

  it('refuses a path that is not in plain form', () => {
    for (const path of [
      '/api/../v1/messages',
      '/v1//messages',
      '/v1/%6dessages',
      '/v1/./messages',
      '/v1/messages;x=1',
      '/v1\\messages',
      'http://example.org/v1/messages',
      '',
    ]) {
      expect(refused(check(json({}), path))).toMatch(/plain form/);
    }
  });

  it('allows an ordinary agent request and sends the same JSON on', () => {
    const request = {
      model: 'claude-x',
      max_tokens: 1024,
      stream: true,
      system: [{ type: 'text', text: 'web_search mcp_servers' }],
      messages: [
        { role: 'user', content: 'what is web_search? 😀' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'mcp__nanoclaw__send_message',
              // Arguments are data: none of this is read by the provider.
              input: {
                tools: [web],
                mcp_servers: [{ url: 'https://example.org' }],
                source: { type: 'url', url: 'https://example.org' },
              },
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
      ],
      tools: [
        {
          name: 'web_search_notes',
          description: 'a client tool',
          input_schema: {
            type: 'object',
            properties: {
              mcp_servers: { type: 'array', default: [{ type: 'url' }] },
              source: { type: 'object', default: { type: 'url' } },
            },
          },
        },
        { type: 'bash_20250124', name: 'bash' },
        { type: 'custom', name: 'x', input_schema: { type: 'object' } },
      ],
    };
    const verdict = check(json(request));
    expect(verdict.allow).toBe(true);
    if (!verdict.allow) return;
    expect(JSON.parse(verdict.body.toString())).toEqual(request);
    expect(verdict.unknownToolTypes).toEqual([]);
    expect(verdict.otherPath).toBe(false);
  });

  it('keeps web search results in the history of a session that had web tools on', () => {
    const body = json({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 's1',
              name: 'web_search',
              input: {},
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 's1',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://example.org',
                  title: 't',
                  encrypted_content: 'x',
                },
              ],
            },
          ],
        },
      ],
      tools: [],
    });
    expect(refused(check(body))).toBe('allowed');
  });

  it('allows a tool type it does not know, and names it', () => {
    const verdict = check(
      json({
        tools: [
          { type: 'code_execution_20260120', name: 'code_execution' },
          { type: 'something_new_20990101', name: 'n' },
          { type: 'bash_20250124', name: 'bash' },
        ],
      }),
    );
    expect(verdict.allow && verdict.unknownToolTypes).toEqual([
      'code_execution_20260120',
      'something_new_20990101',
    ]);
  });

  it('lets other paths through: empty bodies, the key exchange, an upload', () => {
    const empty = check(Buffer.alloc(0), '/v1/models');
    expect(empty.allow && empty.otherPath).toBe(true);
    expect(
      refused(
        check(json({ raw: 'x' }), '/api/oauth/claude_cli/create_api_key'),
      ),
    ).toBe('allowed');
    const upload = Buffer.from('--b\r\ncontent-disposition: form-data\r\n');
    const sent = check(upload, '/v1/files');
    expect(sent.allow && sent.body.equals(upload)).toBe(true);
    // A JSON body on another path is still checked.
    expect(refused(check(json({ tools: [web] }), '/v1/unknown'))).toMatch(
      /web search/,
    );
  });

  it('refuses a body nested too deeply to check', () => {
    let deep = '{"tools":[{"type":"web_search_20250305"}]}';
    for (let i = 0; i < 400; i++) deep = `{"a":${deep}}`;
    expect(refused(check(Buffer.from(deep)))).toMatch(/^refused/);
  });
});

describe('classifyProxyPath', () => {
  it('names model paths with or without a base path', () => {
    expect(classifyProxyPath('/v1/messages')).toBe('model');
    expect(classifyProxyPath('/v1/messages?beta=true')).toBe('model');
    expect(classifyProxyPath('/v1/messages/batches/b1/cancel')).toBe('model');
    expect(classifyProxyPath('/anthropic/v1/messages/count_tokens')).toBe(
      'model',
    );
    expect(classifyProxyPath('/v1/complete')).toBe('model');
    expect(classifyProxyPath('/api/hello')).toBe('other');
    expect(classifyProxyPath('/')).toBe('other');
    expect(classifyProxyPath('/v1/models/claude-x:latest')).toBe('other');
  });
});
