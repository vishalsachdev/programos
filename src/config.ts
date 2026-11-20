import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { BOT_MAIL_DOMAIN } from './instance-identity.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'TZ',
  'SEND_FROM_EMAIL',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
// Wait this long after the first fresh message before starting a container, so
// a quick burst of messages becomes one turn (one container per turn; see
// CLAUDE.md "Message turns"). 0 disables.
export const MESSAGE_DEBOUNCE_MS = parseInt(
  process.env.MESSAGE_DEBOUNCE_MS || '15000',
  10,
);
export const SCHEDULER_POLL_INTERVAL = 60000;

// --- Identity constants (single source for literals previously scattered
// per-file — an address change must land in exactly one place) ---

/**
 * Default bot mailbox. SEND_FROM_EMAIL (host .env) overrides at the call
 * sites that resolve it dynamically; this is only the fallback/default.
 * A mailbox migration can change this address — every consumer must read
 * it from here (a missed literal in cc-context would silently disable G56
 * suppression).
 */
export const DEFAULT_BOT_EMAIL = `program@${BOT_MAIL_DOMAIN}`;

/**
 * The bot mailbox actually in effect: SEND_FROM_EMAIL from .env or the
 * process environment, else the default. SEND_FROM_EMAIL is documented in
 * the VPS .env, and readEnvFile deliberately never populates process.env —
 * so any consumer reading only process.env (cc-context originally did)
 * silently stays on the old address after a mailbox migration.
 * Identity detection and sending must resolve through the same value.
 */
// Trim BEFORE the fallback chain: a whitespace-only SEND_FROM_EMAIL is
// truthy, so trimming after selection would yield an empty BOT_EMAIL —
// and an empty alternative in cc-context's direct-request regex matches
// everything.
const configuredBotEmail = (
  process.env.SEND_FROM_EMAIL ||
  envConfig.SEND_FROM_EMAIL ||
  ''
).trim();
export const BOT_EMAIL = (
  configuredBotEmail || DEFAULT_BOT_EMAIL
).toLowerCase();

/**
 * Peer-agent inbox addresses (PeerAgent). Drives BOTH policies that key on
 * agent-to-agent mail: the webhook reply-suppression guard and the
 * outbound auto-CC of Avery — one list, lowercased.
 */
export const AGENT_INBOX_ADDRESSES = ['averybot@gmail.com'];

/**
 * Deterministic owner-DM JID (Avery's private Telegram chat, resolved to
 * TELEGRAM_ADMIN_CHAT_ID by the telegram channel). Default target for
 * dead-letter alerts and outreach summaries.
 */
export const TELEGRAM_OWNER_JID = 'tg-avery@program';

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
/**
 * The host's own folder for files no container may see: the two allowlists
 * above and the delivery-state key below. It is outside the project root
 * (which the main group's container gets read-only), and an additional
 * mount that would reach it is refused (`src/mount-security.ts`).
 */
export const HOST_CONFIG_DIR = path.join(HOME_DIR, '.config', 'nanoclaw');
/**
 * The key the host creates at its first start when no signing key is
 * configured (`src/delivery-state.ts`). One line of 64 hex characters,
 * readable by the host user only.
 */
export const DELIVERY_STATE_KEY_PATH = path.join(
  HOST_CONFIG_DIR,
  'delivery-state.key',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
if (envConfig.TZ && !process.env.TZ && isValidTimezone(envConfig.TZ)) {
  process.env.TZ = envConfig.TZ;
}
export const TIMEZONE = resolveConfigTimezone();
