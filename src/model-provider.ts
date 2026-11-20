/**
 * Model providers for the agent, in a configured order, with a circuit
 * breaker per provider.
 *
 * The credential proxy reports each upstream result here. The container
 * runner asks `selectProvider()` once per run. With no settings there is one
 * provider (`anthropic`) and nothing ever switches.
 *
 * Settings are read from `.env` (they are secrets or sit beside secrets).
 * Breaker state is in memory only: a restart forgets it.
 */
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type ModelProvider = 'anthropic' | 'foundry';

const PROVIDERS: readonly ModelProvider[] = ['anthropic', 'foundry'];
export const DEFAULT_FAILOVER_THRESHOLD = 3;
export const DEFAULT_FAILOVER_COOLDOWN_MS = 30 * 60 * 1000;
export const DEFAULT_FOUNDRY_KEY_HEADER = 'api-key';
const FOUNDRY_KEY_HEADERS = ['api-key', 'x-api-key'];

export interface FoundrySettings {
  /** Real base URL, e.g. https://name.services.ai.azure.com/anthropic */
  baseUrl: URL;
  apiKey: string;
  /** Header that carries the key when the caller sent no key header. */
  keyHeader: string;
  /** Deployment names. Each is optional. */
  agentModel?: string;
  gateModel?: string;
  opusModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
}

export interface ModelProviderConfig {
  order: ModelProvider[];
  foundry?: FoundrySettings;
  threshold: number;
  cooldownMs: number;
}

const FOUNDRY_KEYS = [
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'FOUNDRY_KEY_HEADER',
  'FOUNDRY_AGENT_MODEL',
  'FOUNDRY_GATE_MODEL',
  'FOUNDRY_OPUS_MODEL',
  'FOUNDRY_SONNET_MODEL',
  'FOUNDRY_HAIKU_MODEL',
];

function parseFoundry(env: Record<string, string>): FoundrySettings {
  const resource = env.ANTHROPIC_FOUNDRY_RESOURCE;
  const rawBase = env.ANTHROPIC_FOUNDRY_BASE_URL;
  if (!resource && !rawBase)
    throw new Error(
      'Foundry needs ANTHROPIC_FOUNDRY_RESOURCE or ANTHROPIC_FOUNDRY_BASE_URL in .env',
    );
  if (!env.ANTHROPIC_FOUNDRY_API_KEY)
    throw new Error('Foundry needs ANTHROPIC_FOUNDRY_API_KEY in .env');
  if (!rawBase && !/^[a-z0-9][a-z0-9-]*$/i.test(resource))
    throw new Error(
      'ANTHROPIC_FOUNDRY_RESOURCE must be the resource name only (letters, digits, hyphens)',
    );
  let baseUrl: URL;
  try {
    baseUrl = new URL(
      rawBase || `https://${resource}.services.ai.azure.com/anthropic`,
    );
  } catch {
    throw new Error('ANTHROPIC_FOUNDRY_BASE_URL is not a valid URL');
  }
  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:')
    throw new Error('ANTHROPIC_FOUNDRY_BASE_URL must be an http(s) URL');
  const keyHeader = (
    env.FOUNDRY_KEY_HEADER || DEFAULT_FOUNDRY_KEY_HEADER
  ).toLowerCase();
  if (!FOUNDRY_KEY_HEADERS.includes(keyHeader))
    throw new Error('FOUNDRY_KEY_HEADER must be api-key or x-api-key');
  return {
    baseUrl,
    apiKey: env.ANTHROPIC_FOUNDRY_API_KEY,
    keyHeader,
    agentModel: env.FOUNDRY_AGENT_MODEL,
    gateModel: env.FOUNDRY_GATE_MODEL,
    opusModel: env.FOUNDRY_OPUS_MODEL,
    sonnetModel: env.FOUNDRY_SONNET_MODEL,
    haikuModel: env.FOUNDRY_HAIKU_MODEL,
  };
}

/**
 * Foundry settings alone, for a caller that uses Foundry without the
 * provider order (the reply sensor). Throws when they are incomplete.
 */
export function readFoundrySettings(): FoundrySettings {
  return parseFoundry(readEnvFile(FOUNDRY_KEYS));
}

/** Base URL path without a trailing slash: '' or e.g. '/anthropic'. */
export function basePath(url: URL): string {
  return url.pathname.replace(/\/+$/, '');
}

/**
 * The Messages API URL under a base URL: its origin, its path prefix (if
 * any), then /v1/messages. The credential proxy joins request paths with the
 * same prefix rule, so the sensor and the agent reach the same place.
 */
export function messagesUrl(base: URL): string {
  return `${base.origin}${basePath(base)}/v1/messages`;
}

/**
 * The first provider named in MODEL_PROVIDERS, or null when it is unset. This
 * reads the list only: it does not check credentials or throw on an
 * incomplete provider, which `loadModelProviderConfig()` does. An unknown
 * name comes back as written, so the caller can refuse it.
 */
export function readPrimaryProviderName(): string | null {
  const raw = readEnvFile(['MODEL_PROVIDERS']).MODEL_PROVIDERS;
  if (raw === undefined) return null;
  const first = raw
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .find((n) => n);
  return first ?? null;
}

function positiveInt(raw: string | undefined, name: string, fallback: number) {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1)
    throw new Error(`${name} must be a positive whole number`);
  return Number(raw);
}

/**
 * Read and check the provider settings. Throws with a clear message when a
 * listed provider lacks its settings: a silent skip would leave the unit
 * believing it has a backup.
 */
export function loadModelProviderConfig(): ModelProviderConfig {
  const env = readEnvFile([
    'MODEL_PROVIDERS',
    'MODEL_FAILOVER_THRESHOLD',
    'MODEL_FAILOVER_COOLDOWN_MS',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    ...FOUNDRY_KEYS,
  ]);
  const threshold = positiveInt(
    env.MODEL_FAILOVER_THRESHOLD,
    'MODEL_FAILOVER_THRESHOLD',
    DEFAULT_FAILOVER_THRESHOLD,
  );
  const cooldownMs = positiveInt(
    env.MODEL_FAILOVER_COOLDOWN_MS,
    'MODEL_FAILOVER_COOLDOWN_MS',
    DEFAULT_FAILOVER_COOLDOWN_MS,
  );

  // Unset: exactly the behaviour before this module existed. One provider,
  // and no new check on its credentials.
  if (env.MODEL_PROVIDERS === undefined)
    return { order: ['anthropic'], threshold, cooldownMs };

  const order: ModelProvider[] = [];
  for (const raw of env.MODEL_PROVIDERS.split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (!PROVIDERS.includes(name as ModelProvider))
      throw new Error(
        `MODEL_PROVIDERS: unknown provider "${name}" (use anthropic, foundry)`,
      );
    if (order.includes(name as ModelProvider))
      throw new Error(`MODEL_PROVIDERS: "${name}" is listed twice`);
    order.push(name as ModelProvider);
  }
  if (order.length === 0)
    throw new Error('MODEL_PROVIDERS is set but names no provider');

  if (
    order.includes('anthropic') &&
    !env.ANTHROPIC_API_KEY &&
    !env.CLAUDE_CODE_OAUTH_TOKEN &&
    !env.ANTHROPIC_AUTH_TOKEN
  )
    throw new Error(
      'MODEL_PROVIDERS lists anthropic, but .env has no ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_AUTH_TOKEN',
    );

  let foundry: FoundrySettings | undefined;
  if (order.includes('foundry')) {
    try {
      foundry = parseFoundry(env);
    } catch (err) {
      throw new Error(
        `MODEL_PROVIDERS lists foundry, but its settings are incomplete: ${(err as Error).message}`,
      );
    }
  }
  return { order, foundry, threshold, cooldownMs };
}

// --- State -----------------------------------------------------------------

interface BreakerState {
  failures: number;
  /** Unhealthy until this time (ms). 0 = never tripped, or reset by a 2xx. */
  openUntil: number;
  /** Tripped and not yet proven healthy: one failure trips it again. */
  tripped: boolean;
  lastReason: string;
}

let config: ModelProviderConfig | null = null;
const breakers = new Map<ModelProvider, BreakerState>();
let lastSelected: ModelProvider | null = null;
let notifier: ((text: string) => void) | null = null;

/** The checked settings, read once per process. Throws as the loader does. */
export function getModelProviderConfig(): ModelProviderConfig {
  if (!config) config = loadModelProviderConfig();
  return config;
}

/** Called on a provider change with a short text. It must not throw. */
export function setProviderChangeNotifier(
  fn: ((text: string) => void) | null,
): void {
  notifier = fn;
}

/** Tests only: forget settings, breaker state and the notifier. */
export function resetModelProviderState(): void {
  config = null;
  breakers.clear();
  lastSelected = null;
  notifier = null;
}

function breaker(provider: ModelProvider): BreakerState {
  let state = breakers.get(provider);
  if (!state) {
    state = { failures: 0, openUntil: 0, tripped: false, lastReason: '' };
    breakers.set(provider, state);
  }
  return state;
}

export interface UpstreamResult {
  /** HTTP status from the upstream, when it answered. */
  status?: number;
  /** True when the upstream could not be reached. */
  networkError?: boolean;
}

/**
 * Why a result counts as a failure, as a status class only. Null when it
 * does not count. Never includes request or response content.
 */
export function failureReason(result: UpstreamResult): string | null {
  if (result.networkError) return 'network error';
  const s = result.status;
  if (s === 401 || s === 403) return `auth error (${s})`;
  if (s === 429) return 'rate limited (429)';
  if (s !== undefined && s >= 500 && s <= 599) return 'server error (5xx)';
  return null;
}

/**
 * The proxy reports each upstream result for the provider it used.
 *
 * `modelCall: false` marks a request that is not a model call (the OAuth key
 * exchange, the model list, a connectivity check). Its failure counts like
 * any other, but its 2xx proves nothing about model calls and resets nothing:
 * in OAuth mode every new container makes a successful key exchange before
 * its first model request, and that success must not wipe the failures of
 * the model requests around it.
 */
export function recordProviderResult(
  provider: ModelProvider,
  result: UpstreamResult,
  opts: { modelCall?: boolean } = {},
): void {
  const state = breaker(provider);
  const reason = failureReason(result);
  const now = Date.now();
  // In cooldown: results from runs that began before the trip. A failure
  // neither extends the cooldown nor counts toward the next one, and a
  // success does not end it: new runs stay on the other provider until the
  // cooldown is over.
  if (now < state.openUntil) return;
  if (reason === null) {
    const s = result.status;
    if (opts.modelCall !== false && s !== undefined && s >= 200 && s <= 299) {
      state.failures = 0;
      state.openUntil = 0;
      state.tripped = false;
    }
    return;
  }
  const { threshold, cooldownMs } = getModelProviderConfig();
  state.failures += 1;
  state.lastReason = reason;
  if (state.tripped || state.failures >= threshold) {
    state.tripped = true;
    state.failures = 0;
    state.openUntil = now + cooldownMs;
    logger.warn(
      { provider, reason, cooldownMs },
      'Model provider marked unhealthy',
    );
  }
}

export function isProviderInCooldown(provider: ModelProvider): boolean {
  return Date.now() < breaker(provider).openUntil;
}

/**
 * The provider for the next run: the first in the configured order that is
 * not in cooldown; when all are, the first. Logs and notifies on a change.
 */
export function selectProvider(): ModelProvider {
  const { order } = getModelProviderConfig();
  const chosen = order.find((p) => !isProviderInCooldown(p)) ?? order[0];
  const previous = lastSelected ?? order[0];
  lastSelected = chosen;
  if (chosen !== previous) {
    const reason = isProviderInCooldown(previous)
      ? `${previous}: ${breaker(previous).lastReason || 'unhealthy'}`
      : `${chosen}: cooldown ended`;
    logger.warn(
      { from: previous, to: chosen, reason },
      'Model provider changed',
    );
    const text = `⚠️ Model provider changed: ${previous} → ${chosen} (${reason}). New agent runs use ${chosen}.`;
    try {
      notifier?.(text);
    } catch (err) {
      logger.error({ err }, 'Model provider change notifier failed');
    }
  }
  return chosen;
}
