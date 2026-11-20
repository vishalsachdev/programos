/**
 * The agent's tool list. WebSearch and WebFetch send text chosen by the
 * agent to outside services, so they are off unless the host sets
 * AGENT_WEB_TOOLS, which reaches the container as NANOCLAW_WEB_TOOLS=1.
 *
 * This is a default, not a boundary: the runner source is writable by the
 * agent. The boundaries are on the host: the container's network
 * (CONTAINER_NETWORK) and the credential proxy, which refuses model requests
 * that carry a web tool while the setting is off.
 */

export const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;

const BASE_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
];

type Env = Record<string, string | undefined>;

export function webToolsEnabled(env: Env): boolean {
  return env.NANOCLAW_WEB_TOOLS === '1';
}

/** Tools pre-approved in a normal run. */
export function normalAllowedTools(env: Env): string[] {
  return webToolsEnabled(env) ? [...BASE_TOOLS, ...WEB_TOOLS] : [...BASE_TOOLS];
}

/**
 * Tools removed from the session. Needed because the run uses
 * bypassPermissions, under which a tool that is merely absent from the
 * allowed list still runs.
 */
export function disallowedTools(env: Env): string[] {
  return webToolsEnabled(env) ? [] : [...WEB_TOOLS];
}
