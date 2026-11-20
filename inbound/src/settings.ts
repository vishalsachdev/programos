// Settings come from wrangler vars and secrets. No value here belongs to a
// real deployment: the defaults are the placeholders the host code uses.

import { hostNameList, type AuthTrust } from './auth.js';

/** The part of Workers KV this worker uses. A test passes an in-memory one. */
export interface KVStore {
  get(key: string, type: 'text'): Promise<string | null>;
  get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface Env {
  // Secrets (wrangler secret put)
  GITHUB_TOKEN?: string;
  WEBHOOK_SECRET?: string;
  // Vars (wrangler.toml)
  GITHUB_REPO?: string;
  GITHUB_BRANCH?: string;
  GITHUB_API_URL?: string;
  INBOX_DIR?: string;
  GIT_AUTHOR_NAME?: string;
  GIT_AUTHOR_EMAIL?: string;
  HOST_WEBHOOK_URL?: string;
  MAX_MESSAGE_BYTES?: string;
  MAX_ATTEMPTS?: string;
  PLATFORM_AUTHSERV_ID?: string;
  FORWARDER_AUTHSERV_IDS?: string;
  FORWARDER_DOMAINS?: string;
  // KV namespace binding
  PENDING: KVStore;
}

export interface Settings {
  githubToken: string;
  webhookSecret: string;
  githubRepo: string;
  githubBranch: string;
  githubApiUrl: string;
  inboxDir: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
  hostWebhookUrl: string;
  maxAttempts: number;
  authTrust: AuthTrust;
}

/**
 * The git author the host accepts today for a committed `.eml`
 * (`readFileAtCreationAsync` in the host's `src/repo-reader.ts`). The host
 * compares the author email exactly, so this default must equal that value.
 */
export const DEFAULT_GIT_AUTHOR_EMAIL = 'email-inbox@example.org';
export const DEFAULT_GIT_AUTHOR_NAME = 'Email Inbox';
/**
 * The host reads a committed `.eml` only under this folder (same function).
 * A different INBOX_DIR files mail the host will not use as evidence.
 */
export const DEFAULT_INBOX_DIR = 'discussions/raw';
/** 10 MiB. Below the host's 16 MiB read buffer and the 25 MiB KV value limit. */
export const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
/** With the backoff in buffer.ts this is about 35 hours of retries. */
export const DEFAULT_MAX_ATTEMPTS = 12;

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Setting must be a positive whole number, got "${value}"`);
  }
  return n;
}

/** Needs no other setting, so the size check works when the rest is wrong. */
export function maxMessageBytes(env: Env): number {
  return positiveInt(env.MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES);
}

/** Read on its own too, so attempts are still counted when a setting is wrong. */
export function maxAttempts(env: Env): number {
  return positiveInt(env.MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
}

/**
 * Which servers' authentication results are read (`auth.ts`). All three are
 * empty by default: nothing is read and the host's verdict is "unknown".
 */
export function authTrust(env: Env): AuthTrust {
  const platform = hostNameList(
    env.PLATFORM_AUTHSERV_ID,
    'PLATFORM_AUTHSERV_ID',
  );
  if (platform.length > 1) {
    throw new Error('PLATFORM_AUTHSERV_ID must be one host name');
  }
  const forwarderAuthservIds = hostNameList(
    env.FORWARDER_AUTHSERV_IDS,
    'FORWARDER_AUTHSERV_IDS',
  );
  const forwarderDomains = hostNameList(
    env.FORWARDER_DOMAINS,
    'FORWARDER_DOMAINS',
  );
  if ((forwarderAuthservIds.length === 0) !== (forwarderDomains.length === 0)) {
    throw new Error(
      'FORWARDER_AUTHSERV_IDS and FORWARDER_DOMAINS are set together or not at all',
    );
  }
  if (forwarderAuthservIds.length > 0 && platform.length === 0) {
    throw new Error('FORWARDER_AUTHSERV_IDS needs PLATFORM_AUTHSERV_ID');
  }
  if (forwarderAuthservIds.includes(platform[0])) {
    throw new Error(
      'FORWARDER_AUTHSERV_IDS must not repeat PLATFORM_AUTHSERV_ID',
    );
  }
  return {
    platformAuthservId: platform[0] ?? '',
    forwarderAuthservIds,
    forwarderDomains,
  };
}

function required(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing setting ${key}`);
  }
  return value.trim();
}

export function readSettings(env: Env): Settings {
  const githubRepo = required(env, 'GITHUB_REPO');
  if (!/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    throw new Error('GITHUB_REPO must look like owner/name');
  }
  const hostWebhookUrl = required(env, 'HOST_WEBHOOK_URL');
  if (!/^https:\/\//i.test(hostWebhookUrl)) {
    throw new Error('HOST_WEBHOOK_URL must start with https://');
  }
  const inboxDir = (env.INBOX_DIR?.trim() || DEFAULT_INBOX_DIR).replace(
    /\/+$/,
    '',
  );
  if (
    inboxDir === '' ||
    inboxDir.startsWith('/') ||
    inboxDir.includes('\\') ||
    inboxDir
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('INBOX_DIR must be a plain relative folder path');
  }
  const gitAuthorEmail =
    env.GIT_AUTHOR_EMAIL?.trim() || DEFAULT_GIT_AUTHOR_EMAIL;
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(gitAuthorEmail)) {
    throw new Error('GIT_AUTHOR_EMAIL must be an email address');
  }
  return {
    githubToken: required(env, 'GITHUB_TOKEN'),
    webhookSecret: required(env, 'WEBHOOK_SECRET'),
    githubRepo,
    githubBranch: env.GITHUB_BRANCH?.trim() || 'main',
    githubApiUrl: (
      env.GITHUB_API_URL?.trim() || 'https://api.github.com'
    ).replace(/\/+$/, ''),
    inboxDir,
    gitAuthorName: env.GIT_AUTHOR_NAME?.trim() || DEFAULT_GIT_AUTHOR_NAME,
    gitAuthorEmail,
    hostWebhookUrl,
    maxAttempts: maxAttempts(env),
    authTrust: authTrust(env),
  };
}
