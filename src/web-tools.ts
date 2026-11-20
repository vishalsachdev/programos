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
 * refuses a request that would make the provider contact an outside host
 * (checkProxyRequest below). The second check is the boundary: it holds even
 * if the agent rewrites its own runner or calls the proxy directly.
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
 * The proxy's check of one request while web tools are off.
 *
 * The container holds its run's proxy token and can write any request it
 * likes, so the check trusts nothing the caller controls:
 *
 * - The body is always parsed. There is no search of the raw bytes: JSON
 *   allows escapes, so a tool type can be written without its plain text.
 * - A body that parsed is sent on re-serialised from the parsed value, never
 *   as the caller's bytes. What was checked is what the provider reads
 *   (duplicate keys, escapes and a byte order mark are gone).
 * - On a model path a body that is not one UTF-8 JSON object is refused.
 * - A body with a content encoding is refused: the proxy does not decode it.
 * - The path must be in plain form, so that the path the proxy classified is
 *   the path the provider routes.
 *
 * Refused, each because the provider would contact an outside host for the
 * caller (read from the type definitions of @anthropic-ai/sdk 0.93.0, the
 * version container/agent-runner pins; no live endpoint was called):
 *
 * - a web search or web fetch tool, in a `tools` list at any depth (a batch
 *   request nests whole message requests);
 * - the remote MCP connector: a non-empty `mcp_servers` list at any depth,
 *   and an `mcp_toolset` tool;
 * - an image or document the provider is asked to download
 *   (`source: {type: "url"}`);
 * - the managed agents API (`/v1/agents`, `/v1/sessions`,
 *   `/v1/environments`): the provider runs an agent in its own container
 *   with its own network and web tools, and its `agent_toolset` tool.
 *
 * Paths are an allowlist. The provider's host serves far more than model
 * requests (the CLI in the agent image names well over a hundred paths), and
 * the proxy adds the host's credential to whatever it forwards. Real agent
 * containers run against a local fake provider on 2026-11-20, in API-key
 * mode and in OAuth mode, sent only `POST /v1/messages`. Forwarded: the model
 * paths, the model list, and the OAuth key exchange. Everything else is
 * refused and logged once per path.
 *
 * Tool types are not an allowlist. A tool type that is not known here is
 * allowed and reported once, so an operator can see it. An allowlist would
 * be stronger; it is not used because a wrong entry would refuse every agent
 * turn, and no turn against a live provider has been run to draw it from.
 */
export interface ProxyRequestInput {
  /** Path and query as the proxy will send them (no token prefix). */
  path: string;
  /** The content-encoding request header, if any. */
  contentEncoding?: string | string[];
  body: Buffer;
}

export type ProxyRequestVerdict =
  | {
      allow: true;
      /** The bytes to send upstream. */
      body: Buffer;
      /** Tool types that are not known to this check. */
      unknownToolTypes: string[];
    }
  | {
      allow: false;
      reason: string;
      /** Set when the path is not on the list: its first segments. */
      pathClass?: string;
    };

const WEB_TOOL_TYPE = /^web_(search|fetch)/;
/** Tools the caller runs itself, or that stay inside the provider. */
const KNOWN_TOOL_TYPE =
  /^(custom$|bash_|text_editor_|computer_|memory_|tool_search_tool_|advisor_)/;
const MANAGED_AGENT_PATHS = new Set(['agents', 'sessions', 'environments']);
const MODEL_PATHS = new Set(['messages', 'complete']);
const PLAIN_SEGMENT = /^[A-Za-z0-9._~:@-]+$/;
const MAX_DEPTH = 256;

type PathKind =
  | 'model'
  | 'listed'
  | 'managed-agents'
  | 'unlisted'
  | 'malformed';

/** Classify the path part of a request URL. The query is ignored. */
export function classifyProxyPath(url: string): PathKind {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  if (!path.startsWith('/')) return 'malformed';
  const segments = path.slice(1).split('/');
  // One trailing slash is plain; an empty or dot segment anywhere else, or
  // a percent escape, is not: the provider may route it differently.
  if (segments.length > 1 && segments[segments.length - 1] === '')
    segments.pop();
  if (segments.length === 1 && segments[0] === '') return 'unlisted';
  for (const s of segments) {
    if (!PLAIN_SEGMENT.test(s) || s === '.' || s === '..') return 'malformed';
  }
  const lower = segments.map((s) => s.toLowerCase());
  // The OAuth key exchange (see the header of src/credential-proxy.ts) and
  // the connectivity check, at the root of the Anthropic host only.
  const head = lower.slice(0, 3).join('/');
  let kind: PathKind =
    head === 'api/oauth/claude_cli' || lower.join('/') === 'api/hello'
      ? 'listed'
      : 'unlisted';
  // A base path may come first (ANTHROPIC_BASE_URL, Foundry), so `v1` is
  // looked for at any position.
  for (let i = 0; i + 1 < lower.length; i++) {
    if (lower[i] !== 'v1') continue;
    if (MANAGED_AGENT_PATHS.has(lower[i + 1])) return 'managed-agents';
    if (MODEL_PATHS.has(lower[i + 1])) kind = 'model';
    else if (lower[i + 1] === 'models' && kind !== 'model') kind = 'listed';
  }
  return kind;
}

/** The first segments of a plain path, for the log. */
function pathClassOf(url: string): string {
  return url.split('?')[0].split('/').slice(0, 4).join('/').slice(0, 120);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Walk a parsed body. Returns a refusal reason, or null. */
function findOutsideReach(root: unknown, unknown: Set<string>): string | null {
  const stack: { value: unknown; depth: number }[] = [
    { value: root, depth: 0 },
  ];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) return 'the body is nested too deeply to check';
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    if (!isObject(value)) continue;
    const blockType = value.type;
    const isToolUse =
      typeof blockType === 'string' && /(^|_)tool_use$/.test(blockType);
    for (const [key, child] of Object.entries(value)) {
      if (key === 'mcp_servers' && Array.isArray(child) && child.length)
        return 'it names a remote MCP server (mcp_servers)';
      if (key === 'source' && isObject(child) && child.type === 'url')
        return 'it asks the provider to download a URL (source type url)';
      if (key === 'tools' && Array.isArray(child)) {
        for (const tool of child) {
          const type = isObject(tool) ? tool.type : undefined;
          if (typeof type !== 'string') continue;
          if (WEB_TOOL_TYPE.test(type))
            return 'it declares a web search or web fetch tool';
          if (type === 'mcp_toolset')
            return 'it declares a remote MCP tool set (mcp_toolset)';
          if (type.startsWith('agent_toolset'))
            return 'it declares a managed agent tool set';
          if (!KNOWN_TOOL_TYPE.test(type)) unknown.add(type.slice(0, 80));
        }
      }
      // Data the provider does not read as a request: a tool's JSON schema,
      // and the arguments of a tool call in the conversation history.
      if (key === 'input_schema') continue;
      if (key === 'input' && isToolUse) continue;
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

function parseJson(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Decide one request for the credential proxy while web tools are off. */
export function checkProxyRequest(
  input: ProxyRequestInput,
): ProxyRequestVerdict {
  const kind = classifyProxyPath(input.path);
  if (kind === 'malformed')
    return { allow: false, reason: 'the request path is not in plain form' };
  if (kind === 'managed-agents')
    return {
      allow: false,
      reason: 'the managed agents API runs tools with their own network',
    };
  if (kind === 'unlisted')
    return {
      allow: false,
      reason: 'the path is not one an agent turn uses',
      pathClass: pathClassOf(input.path),
    };
  const encoding = ([] as string[])
    .concat(input.contentEncoding ?? [])
    .join(',')
    .trim()
    .toLowerCase();
  if (encoding && encoding !== 'identity')
    return {
      allow: false,
      reason: 'the body has a content encoding the proxy does not read',
    };
  if (input.body.length === 0)
    return { allow: true, body: input.body, unknownToolTypes: [] };
  const parsed = parseJson(input.body);
  if (!parsed.ok) {
    if (kind === 'model')
      return { allow: false, reason: 'the body is not UTF-8 JSON' };
    // A listed path that is not a model path. Sent on as it came.
    return { allow: true, body: input.body, unknownToolTypes: [] };
  }
  if (kind === 'model' && !isObject(parsed.value))
    return { allow: false, reason: 'the body is not a JSON object' };
  const unknown = new Set<string>();
  const reason = findOutsideReach(parsed.value, unknown);
  if (reason) return { allow: false, reason };
  return {
    allow: true,
    body: Buffer.from(JSON.stringify(parsed.value), 'utf8'),
    unknownToolTypes: [...unknown],
  };
}
