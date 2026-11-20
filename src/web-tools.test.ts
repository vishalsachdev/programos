import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

import { declaresWebTool, webToolsEnabled } from './web-tools.js';

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

describe('declaresWebTool', () => {
  const body = (o: unknown) => Buffer.from(JSON.stringify(o));

  it('finds a provider-side web search or web fetch tool', () => {
    expect(
      declaresWebTool(
        body({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }),
      ),
    ).toBe(true);
    expect(
      declaresWebTool(
        body({ tools: [{ name: 'Bash' }, { type: 'web_fetch_20250910' }] }),
      ),
    ).toBe(true);
  });

  it('ignores the words in message text and in client tool names', () => {
    expect(
      declaresWebTool(
        body({
          messages: [{ role: 'user', content: 'what is web_search?' }],
          tools: [{ name: 'web_search_notes', input_schema: {} }],
        }),
      ),
    ).toBe(false);
  });

  it('is false for bodies with no tools or that are not JSON', () => {
    expect(declaresWebTool(body({ messages: [] }))).toBe(false);
    expect(declaresWebTool(Buffer.from('web_search not json'))).toBe(false);
    expect(declaresWebTool(Buffer.alloc(0))).toBe(false);
  });
});
