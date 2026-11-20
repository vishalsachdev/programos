import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  DELIVERY_STATE_KEY_PATH,
} from './config.js';
import { deleteRouterState, getRouterState, setRouterState } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { realPathOfNearestExisting } from './real-path.js';
import type { PreparedDelivery } from './types.js';

const STATE_VERSION = 1 as const;
const STATE_KEY_PREFIX = 'delivery-state:';
const TRANSPORT_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNATURE_VERSION = 1;

export interface DeliveryContext {
  sender?: string;
  subject?: string;
  receivedAt?: string;
  messageId?: string;
  channelData?: unknown;
}

interface DeliveryStateBase {
  version: typeof STATE_VERSION;
  chatJid: string;
  targetTimestamp: string;
  previousCursor: string;
  context: DeliveryContext;
  outcomeId: string;
  /** Missing only on pre-body-gate state; [] is current evidence, not legacy. */
  trustedBodyAddresses?: string[];
}

export interface RepairRequiredState extends DeliveryStateBase {
  phase: 'repair-required';
  gateReason: string;
  rejectedOutput: string;
  attempt: number;
  createdAt: string;
}

export interface TransportPendingState extends DeliveryStateBase {
  phase: 'transport-pending';
  prepared: PreparedDelivery;
  replyText: string;
  attempt: number;
  createdAt: string;
}

export interface ProviderAcceptedState extends DeliveryStateBase {
  phase: 'provider-accepted';
  prepared: PreparedDelivery;
  replyText: string;
  attempt: number;
  providerId: string;
  acceptedAt: string;
}

export type DeliveryState =
  | RepairRequiredState
  | TransportPendingState
  | ProviderAcceptedState;

export type LoadDeliveryStateResult =
  | { status: 'none' }
  | { status: 'valid'; state: DeliveryState }
  | { status: 'invalid'; reason: string };

export type SaveDeliveryStateResult =
  | { status: 'saved' }
  | { status: 'invalid'; reason: string };

function stateKey(jid: string): string {
  return `${STATE_KEY_PREFIX}${jid}`;
}

/**
 * The keys that sign and check saved delivery state. State is always signed
 * and always checked: there is no setting under which a row is taken as it
 * stands.
 *
 * `sign` is, in this order:
 *  1. DELIVERY_STATE_SIGNING_KEY (process environment, or `.env`);
 *  2. the first one set of WEBHOOK_SECRET, TELEGRAM_BOT_TOKEN and
 *     RESEND_API_KEY in `.env`, as it always has been: a secret that exists
 *     for another purpose, so a leak of it also lets its holder forge
 *     delivery state, and rotating it makes state saved before the rotation
 *     fail the check;
 *  3. the key in the host's key file (DELIVERY_STATE_KEY_PATH), which the
 *     host creates at its first start when neither of the above is set.
 *
 * `verify` lists every key a saved state may have been signed with: the
 * signing key, the fallback secret, and the key file's key when the file
 * exists. So state signed before a dedicated key was set still loads, and
 * so does state signed with the key file before any key was configured.
 *
 * A process that never ran the start-up step (a test, a script) signs with
 * a key made for that process alone when nothing is configured. It never
 * reads or writes the key file.
 */
export interface DeliveryStateKeys {
  sign: string;
  verify: string[];
  /** Where the signing key came from. */
  source:
    | 'DELIVERY_STATE_SIGNING_KEY'
    | 'WEBHOOK_SECRET'
    | 'TELEGRAM_BOT_TOKEN'
    | 'RESEND_API_KEY'
    | 'key-file'
    | 'this-process';
}

const FALLBACK_KEY_SETTINGS = [
  'WEBHOOK_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'RESEND_API_KEY',
] as const;

const KEY_FILE_FORM = /^[0-9a-f]{64}$/;

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

/**
 * Why the key file must not be used at this place, or null. The project
 * root is mounted into the main group's container, so a key under it is a
 * key the agent can read.
 */
export function deliveryStateKeyFileProblem(keyFile: string): string | null {
  const dir = realPathOfNearestExisting(path.dirname(keyFile));
  const root = realPathOfNearestExisting(process.cwd());
  if (isInside(dir, root)) {
    return (
      `The delivery-state key file would be at ${keyFile}, inside the project folder ${root}, which the main group's container can read. ` +
      'Set DELIVERY_STATE_SIGNING_KEY in .env to a long random value of its own (openssl rand -hex 32), or run the host with a HOME outside the project folder.'
    );
  }
  return null;
}

/**
 * The key in the key file, or undefined when there is no file. Throws when
 * something is at that path that this host did not write as its key: the
 * host does not start on a key it cannot account for. The message names
 * the path and never the content.
 */
function readKeyFile(keyFile: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(keyFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(
      `Cannot read the delivery-state key file ${keyFile}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  const remedy =
    'Remove it to have a new key created at the next start (a reply in delivery at that moment is handled again), or set DELIVERY_STATE_SIGNING_KEY.';
  if (!stat.isFile()) {
    throw new Error(
      `The delivery-state key file ${keyFile} is not a regular file. ${remedy}`,
    );
  }
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    stat.uid !== process.getuid()
  ) {
    throw new Error(
      `The delivery-state key file ${keyFile} belongs to another user. ${remedy}`,
    );
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    // Written 0600 by this host; somebody widened it. Narrow it again.
    fs.chmodSync(keyFile, 0o600);
  }
  let key: string;
  try {
    key = fs.readFileSync(keyFile, 'utf-8').trim();
  } catch (err) {
    throw new Error(
      `Cannot read the delivery-state key file ${keyFile}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  if (!KEY_FILE_FORM.test(key)) {
    throw new Error(
      `The delivery-state key file ${keyFile} does not hold a key this host wrote. ${remedy}`,
    );
  }
  return key;
}

/** Create the key file, readable by its owner only. Returns its key. */
function createKeyFile(keyFile: string): string {
  const problem = deliveryStateKeyFileProblem(keyFile);
  if (problem) throw new Error(problem);
  const key = randomBytes(32).toString('hex');
  const tmp = `${keyFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    // The folder may have been made through a link that was not there when
    // the placement was judged; judge the place the file will really be in.
    const late = deliveryStateKeyFileProblem(keyFile);
    if (late) throw new Error(late);
    // Written whole under another name, then given its name with a hard
    // link: the name never exists with half a key in it (a stop between
    // the two steps leaves no key file), a link never replaces a file that
    // is there, and it does not follow a symbolic link at that name. A
    // start that got there first wins.
    fs.writeFileSync(tmp, `${key}\n`, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
    try {
      fs.linkSync(tmp, keyFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = readKeyFile(keyFile);
      if (existing) return existing;
      throw err;
    }
    return key;
  } catch (err) {
    if (err instanceof Error && !('code' in err)) throw err;
    throw new Error(
      `Cannot create the delivery-state key file ${keyFile}: ${(err as NodeJS.ErrnoException).code ?? 'error'}. ` +
        'Make its folder writable by the host user, or set DELIVERY_STATE_SIGNING_KEY in .env.',
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** One key per process for a process that never ran the start-up step. */
let processKey: string | null = null;

/**
 * `keyFile` is given by the start-up step only. With it, the key file is
 * read when it exists and created when no other key is configured. Without
 * it the file is not touched.
 */
export function resolveDeliveryStateKeys(keyFile?: string): DeliveryStateKeys {
  const env = readEnvFile([
    'DELIVERY_STATE_SIGNING_KEY',
    ...FALLBACK_KEY_SETTINGS,
  ]);
  const dedicated =
    process.env.DELIVERY_STATE_SIGNING_KEY || env.DELIVERY_STATE_SIGNING_KEY;
  const fallbackSetting = FALLBACK_KEY_SETTINGS.find((name) => env[name]);
  const fallback = fallbackSetting ? env[fallbackSetting] : undefined;
  const configured = dedicated || fallback;

  let fileKey: string | undefined;
  let own: string | undefined;
  if (keyFile !== undefined) {
    // A key file under the project folder is never read: the agent could
    // have read it, or written it.
    const misplaced = deliveryStateKeyFileProblem(keyFile);
    if (!misplaced) {
      try {
        fileKey = readKeyFile(keyFile);
      } catch (err) {
        // With a key configured the file is only one more key to check
        // old state with. A host that never needed it must not stop over
        // it (a HOME the service user cannot enter, a stray file there).
        if (!configured) throw err;
        logger.warn(
          { keyFile, reason: err instanceof Error ? err.message : 'error' },
          'Delivery state: the key file was not read; a signing key is configured, so it is not needed. State signed with a key from that file, if any, will fail its check',
        );
      }
    }
    if (!configured && !fileKey) fileKey = createKeyFile(keyFile);
  } else if (!configured) {
    processKey ??= randomBytes(32).toString('hex');
    own = processKey;
  }
  const sign = configured || fileKey || own;
  if (!sign) throw new Error('No delivery-state signing key');
  return {
    sign,
    verify: [
      ...new Set([dedicated, fallback, fileKey, own].filter(isNonEmptyString)),
    ],
    source: dedicated
      ? 'DELIVERY_STATE_SIGNING_KEY'
      : (fallbackSetting ?? (fileKey ? 'key-file' : 'this-process')),
  };
}

/** Set once at startup; null in tests and scripts that never start the host. */
let startupKeys: DeliveryStateKeys | null = null;

/**
 * Read the keys once, as the listeners read their secrets once at start: an
 * edit of `.env` then takes effect at the restart, for all of them together.
 * Creates the key file when no key is configured. Returns the keys so the
 * caller can say where the signing key comes from. Before this is called
 * (tests, scripts) the settings are read at each use.
 */
export function initDeliveryStateKeys(
  keyFile: string = DELIVERY_STATE_KEY_PATH,
): DeliveryStateKeys {
  startupKeys = resolveDeliveryStateKeys(keyFile);
  return startupKeys;
}

/** @internal */
export function _resetDeliveryStateKeysForTests(): void {
  startupKeys = null;
  processKey = null;
}

function currentKeys(): DeliveryStateKeys {
  return startupKeys ?? resolveDeliveryStateKeys();
}

function macFor(payload: string, key: string): string {
  return createHmac('sha256', key)
    .update('nanoclaw-delivery-state-v1\0')
    .update(payload)
    .digest('hex');
}

function unwrapSignedState(
  serialized: string,
): { ok: true; payload: string } | { ok: false; reason: string } {
  const keys = currentKeys().verify;
  let wrapper: unknown;
  try {
    wrapper = JSON.parse(serialized);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (
    !isRecord(wrapper) ||
    wrapper.signatureVersion !== SIGNATURE_VERSION ||
    typeof wrapper.payload !== 'string' ||
    typeof wrapper.mac !== 'string'
  ) {
    return { ok: false, reason: 'missing-state-signature' };
  }
  const actual = Buffer.from(wrapper.mac, 'hex');
  // Every key is tried, with no early exit: which one matched is not timed.
  let matched = false;
  for (const key of keys) {
    const expected = Buffer.from(macFor(wrapper.payload, key), 'hex');
    if (expected.length === actual.length && timingSafeEqual(expected, actual))
      matched = true;
  }
  if (!matched) return { ok: false, reason: 'invalid-state-signature' };
  return { ok: true, payload: wrapper.payload };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isAttempt(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

function isContext(value: unknown): value is DeliveryContext {
  if (!isRecord(value)) return false;
  return (
    ['sender', 'subject', 'messageId'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    ) &&
    (value.receivedAt === undefined || isIsoDate(value.receivedAt)) &&
    (value.channelData === undefined || value.channelData !== null)
  );
}

function isPreparedDelivery(value: unknown): value is PreparedDelivery {
  return (
    isRecord(value) &&
    isNonEmptyString(value.channel) &&
    isNonEmptyString(value.deliveryId) &&
    isNonEmptyString(value.jid) &&
    Object.prototype.hasOwnProperty.call(value, 'payload') &&
    value.payload !== undefined
  );
}

function validateState(
  value: unknown,
  expectedJid?: string,
): { ok: true; state: DeliveryState } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: 'invalid-state' };
  if (value.version !== STATE_VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  if (expectedJid !== undefined && value.chatJid !== expectedJid) {
    return { ok: false, reason: 'chat-jid-mismatch' };
  }
  if (
    !isNonEmptyString(value.chatJid) ||
    !isIsoDate(value.targetTimestamp) ||
    typeof value.previousCursor !== 'string' ||
    !isContext(value.context) ||
    !isNonEmptyString(value.outcomeId) ||
    (Object.hasOwn(value, 'trustedBodyAddresses') &&
      (!Array.isArray(value.trustedBodyAddresses) ||
        !value.trustedBodyAddresses.every(
          (address) => typeof address === 'string',
        )))
  ) {
    return { ok: false, reason: 'invalid-common-fields' };
  }

  if (value.phase === 'repair-required') {
    if (
      !isNonEmptyString(value.gateReason) ||
      typeof value.rejectedOutput !== 'string' ||
      !isAttempt(value.attempt) ||
      !isIsoDate(value.createdAt)
    ) {
      return { ok: false, reason: 'invalid-repair-state' };
    }
    return { ok: true, state: value as unknown as RepairRequiredState };
  }

  if (value.phase === 'transport-pending') {
    if (
      !isPreparedDelivery(value.prepared) ||
      value.prepared.jid !== value.chatJid ||
      typeof value.replyText !== 'string' ||
      !isAttempt(value.attempt) ||
      !isIsoDate(value.createdAt)
    ) {
      return { ok: false, reason: 'invalid-transport-state' };
    }
    return { ok: true, state: value as unknown as TransportPendingState };
  }

  if (value.phase === 'provider-accepted') {
    if (
      !isPreparedDelivery(value.prepared) ||
      value.prepared.jid !== value.chatJid ||
      typeof value.replyText !== 'string' ||
      !isAttempt(value.attempt) ||
      !isNonEmptyString(value.providerId) ||
      !isIsoDate(value.acceptedAt)
    ) {
      return { ok: false, reason: 'invalid-provider-state' };
    }
    return { ok: true, state: value as unknown as ProviderAcceptedState };
  }

  return { ok: false, reason: 'unsupported-phase' };
}

export function loadDeliveryState(jid: string): LoadDeliveryStateResult {
  const serialized = getRouterState(stateKey(jid));
  if (serialized === undefined) return { status: 'none' };
  if (Buffer.byteLength(serialized, 'utf8') > CONTAINER_MAX_OUTPUT_SIZE) {
    return { status: 'invalid', reason: 'state-too-large' };
  }
  const unwrapped = unwrapSignedState(serialized);
  if (!unwrapped.ok) {
    return { status: 'invalid', reason: unwrapped.reason };
  }
  try {
    const result = validateState(JSON.parse(unwrapped.payload), jid);
    return result.ok
      ? { status: 'valid', state: result.state }
      : { status: 'invalid', reason: result.reason };
  } catch {
    return { status: 'invalid', reason: 'malformed-json' };
  }
}

export function saveDeliveryState(
  state: DeliveryState,
): SaveDeliveryStateResult {
  const result = validateState(state, state.chatJid);
  if (!result.ok) return { status: 'invalid', reason: result.reason };

  let serialized: string;
  try {
    serialized = JSON.stringify(result.state);
  } catch {
    return { status: 'invalid', reason: 'unserializable-state' };
  }
  if (Buffer.byteLength(serialized, 'utf8') > CONTAINER_MAX_OUTPUT_SIZE) {
    return { status: 'invalid', reason: 'state-too-large' };
  }
  const stored = JSON.stringify({
    signatureVersion: SIGNATURE_VERSION,
    payload: serialized,
    mac: macFor(serialized, currentKeys().sign),
  });
  if (Buffer.byteLength(stored, 'utf8') > CONTAINER_MAX_OUTPUT_SIZE) {
    return { status: 'invalid', reason: 'state-too-large' };
  }
  setRouterState(stateKey(state.chatJid), stored);
  return { status: 'saved' };
}

export function clearDeliveryState(jid: string): void {
  deleteRouterState(stateKey(jid));
}

export function isTransportExpired(
  state: DeliveryState,
  now = new Date(),
): boolean {
  if (state.phase !== 'transport-pending') return false;
  return now.getTime() - Date.parse(state.createdAt) >= TRANSPORT_TTL_MS;
}
