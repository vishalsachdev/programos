// Where the host gets the EMAIL_AUTH_* settings from, and when.
//
// They are read like the host's other plain settings (AGENT_WEB_TOOLS,
// CONTAINER_NETWORK, REQUIRE_PRIVATE_ENV_FILE): the process environment
// first, then `.env`. None of them is a secret, so either place is fine;
// what is not fine is one place only, because `.env` is where an operator
// writes settings and a value there that the host never reads looks set and
// is not.
//
// They are read once, at start, and the host does not start on a value it
// does not know. An edit takes effect at the next restart, as for the
// listeners' secrets.

import { readEnvFile } from './env.js';
import {
  EMAIL_AUTH_SETTING_KEYS,
  readEmailAuthSettings,
  type EmailAuthSettings,
} from './email-auth.js';
import { logger } from './logger.js';

/** Process environment first, then `.env`, for each key. */
export function loadEmailAuthSettings(): EmailAuthSettings {
  const file = readEnvFile([...EMAIL_AUTH_SETTING_KEYS]);
  const merged: Record<string, string | undefined> = {};
  for (const key of EMAIL_AUTH_SETTING_KEYS) {
    merged[key] = process.env[key] || file[key];
  }
  return readEmailAuthSettings(merged);
}

/** Set once at startup; null in tests and scripts that never start the host. */
let startupSettings: EmailAuthSettings | null = null;

/**
 * The start-up step: read the settings, refuse a value that cannot work
 * (it throws), keep them for every message, and say once what is in effect.
 */
export function initEmailAuthSettings(): EmailAuthSettings {
  const settings = loadEmailAuthSettings();
  startupSettings = settings;
  const trusted = [...settings.trusted];
  logger.info(
    {
      mode: settings.mode,
      trusted,
      unknown: settings.unknown,
      requireFromDomain: settings.requireFromDomain,
    },
    settings.mode === 'enforce'
      ? `Inbound email sender authentication: enforce (mail from a listed sender that is not authenticated is dropped; "unknown" is ${settings.unknown === 'allow' ? 'let through' : 'dropped'})`
      : `Inbound email sender authentication: flag (the verdict is recorded and no message is dropped)${trusted.length === 0 ? '; no trusted mail server is set, so every verdict is "unknown"' : ''}`,
  );
  return settings;
}

/** The settings in effect. Before the start-up step they are read at each use. */
export function currentEmailAuthSettings(): EmailAuthSettings {
  return startupSettings ?? loadEmailAuthSettings();
}

/** @internal */
export function _resetEmailAuthSettingsForTests(): void {
  startupSettings = null;
}
