import fs from 'fs';

import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

// Fail closed: with no usable config file, no sender may trigger the agent.
// Mode stays 'trigger' so messages are still stored, only not acted on.
const DENY_ALL_CONFIG: SenderAllowlistConfig = {
  default: { allow: [], mode: 'trigger' },
  chats: {},
  logDenied: true,
};

// The loader runs for every message, so each path is reported once per
// failure reason; a successful load clears it and a later failure logs again.
const reportedFailures = new Map<string, string>();

function denyAll(
  filePath: string,
  reason: string,
  err?: unknown,
): SenderAllowlistConfig {
  if (reportedFailures.get(filePath) !== reason) {
    reportedFailures.set(filePath, reason);
    logger.error(
      { path: filePath, reason, ...(err === undefined ? {} : { err }) },
      'sender-allowlist: no usable config file at this path; chat triggers are denied for every sender until it is fixed (example: config-examples/sender-allowlist.json)',
    );
  }
  return DENY_ALL_CONFIG;
}

function isValidEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const validAllow =
    e.allow === '*' ||
    (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
  const validMode = e.mode === 'trigger' || e.mode === 'drop';
  return validAllow && validMode;
}

export function loadSenderAllowlist(
  pathOverride?: string,
): SenderAllowlistConfig {
  const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return denyAll(filePath, 'file is missing');
    }
    return denyAll(filePath, 'file cannot be read', err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return denyAll(filePath, 'invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    return denyAll(filePath, 'invalid or missing default entry');
  }
  const obj = parsed as Record<string, unknown>;

  if (!isValidEntry(obj.default)) {
    return denyAll(filePath, 'invalid or missing default entry');
  }

  reportedFailures.delete(filePath);

  const chats: Record<string, ChatAllowlistEntry> = {};
  if (obj.chats && typeof obj.chats === 'object') {
    for (const [jid, entry] of Object.entries(
      obj.chats as Record<string, unknown>,
    )) {
      if (isValidEntry(entry)) {
        chats[jid] = entry;
      } else {
        logger.warn(
          { jid, path: filePath },
          'sender-allowlist: skipping invalid chat entry',
        );
      }
    }
  }

  return {
    default: obj.default as ChatAllowlistEntry,
    chats,
    logDenied: obj.logDenied !== false,
  };
}

function getEntry(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): ChatAllowlistEntry {
  return cfg.chats[chatJid] ?? cfg.default;
}

export function isSenderAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const entry = getEntry(chatJid, cfg);
  if (entry.allow === '*') return true;
  return entry.allow.includes(sender);
}

export function shouldDropMessage(
  chatJid: string,
  cfg: SenderAllowlistConfig,
): boolean {
  return getEntry(chatJid, cfg).mode === 'drop';
}

export function isTriggerAllowed(
  chatJid: string,
  sender: string,
  cfg: SenderAllowlistConfig,
): boolean {
  const allowed = isSenderAllowed(chatJid, sender, cfg);
  if (!allowed && cfg.logDenied) {
    logger.debug(
      { chatJid, sender },
      'sender-allowlist: trigger denied for sender',
    );
  }
  return allowed;
}
