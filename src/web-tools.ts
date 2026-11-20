/**
 * The web tools setting (AGENT_WEB_TOOLS), off by default.
 *
 * WebSearch runs at the model provider: the agent's query leaves through the
 * credential proxy even when the container's network is restricted. WebFetch
 * needs the container's own network. Both carry text the agent chose, and
 * neither passes the delivery gate or the audit log.
 *
 * Off means two things: the container is not told to offer the tools
 * (container/agent-runner/src/allowed-tools.ts), and the credential proxy
 * refuses a model request that declares a web search or web fetch tool. The
 * second check holds even if the agent rewrites its own runner.
 */
import { readEnvFile } from './env.js';

/** Process environment first, then `.env`. Read on each call. */
export function webToolsEnabled(): boolean {
  const value = (
    process.env.AGENT_WEB_TOOLS ||
    readEnvFile(['AGENT_WEB_TOOLS']).AGENT_WEB_TOOLS ||
    ''
  )
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

/**
 * True if a Messages API request body declares a provider-side web tool
 * (tool `type` starting with web_search or web_fetch). Bodies that are not
 * JSON, or have no tools, are not web tool requests.
 */
export function declaresWebTool(body: Buffer): boolean {
  // Cheap pre-check: most requests carry no such tool.
  if (!body.includes('web_search') && !body.includes('web_fetch')) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return false;
  }
  const tools = (parsed as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => {
    const type = (t as { type?: unknown })?.type;
    return typeof type === 'string' && /^web_(search|fetch)/.test(type);
  });
}
