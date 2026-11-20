/**
 * Delivery state is always signed and always checked. With no signing key
 * configured the host creates one at its first start, in a file only the
 * host user can read, outside the project folder; a row without a valid
 * signature is never delivered.
 */
import { createHmac } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELIVERY_STATE_KEY_PATH, HOST_CONFIG_DIR } from './config.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getRouterState,
  setRouterState,
} from './db.js';
import {
  _resetDeliveryStateKeysForTests,
  clearDeliveryState,
  deliveryStateKeyFileProblem,
  initDeliveryStateKeys,
  loadDeliveryState,
  saveDeliveryState,
  type DeliveryState,
} from './delivery-state.js';

const JID = 'webhook-email:thread-1';
const STATE: DeliveryState = {
  version: 1,
  phase: 'transport-pending',
  chatJid: JID,
  targetTimestamp: '2026-08-10T15:00:00.000Z',
  previousCursor: '',
  context: { sender: 'person@example.edu', subject: 'Launch question' },
  outcomeId: 'outcome-1',
  prepared: {
    channel: 'webhook',
    deliveryId: 'delivery-1',
    jid: JID,
    payload: { to: 'person@example.edu', body: 'Hello' },
  },
  replyText: 'Hello',
  attempt: 1,
  createdAt: '2026-08-10T15:01:00.000Z',
};
const ROW = `delivery-state:${JID}`;

let root: string;
let project: string;
let keyFile: string;

function mac(payload: string, key: string): string {
  return createHmac('sha256', key)
    .update('nanoclaw-delivery-state-v1\0')
    .update(payload)
    .digest('hex');
}

/** The row a process with write access to the store could put there. */
function plant(value: unknown, key?: string): void {
  const payload = JSON.stringify(value);
  setRouterState(
    ROW,
    key
      ? JSON.stringify({
          signatureVersion: 1,
          payload,
          mac: mac(payload, key),
        })
      : payload,
  );
}

/** What src/index.ts does with a chat that has saved state. */
async function deliverSaved() {
  const { processDelivery } = await import('./delivery-processor.js');
  const deps = {
    loadState: loadDeliveryState,
    clearState: clearDeliveryState,
    auditDeadLetter: vi.fn(() => 'written' as const),
    alertDeadLetter: vi.fn(async () => undefined),
    runBusinessAgent: vi.fn(),
    runRepairAgent: vi.fn(),
    deliverPrepared: vi.fn(),
  };
  const result = await processDelivery(
    {
      chatJid: JID,
      prompt: 'unused',
      previousCursor: '',
      targetTimestamp: STATE.targetTimestamp,
    } as never,
    deps as never,
  );
  return { result, deps };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-key-')));
  project = path.join(root, 'project');
  fs.mkdirSync(project);
  keyFile = path.join(
    root,
    'home',
    '.config',
    'nanoclaw',
    'delivery-state.key',
  );
  _initTestDatabase(path.join(root, 'messages.db'));
  // No key of any kind is configured: no .env in the project folder.
  vi.spyOn(process, 'cwd').mockReturnValue(project);
  vi.stubEnv('DELIVERY_STATE_SIGNING_KEY', '');
  _resetDeliveryStateKeysForTests();
});

afterEach(() => {
  _closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetDeliveryStateKeysForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('with no signing key configured', () => {
  it('state is signed all the same, and an unsigned row is not state', () => {
    expect(saveDeliveryState(STATE)).toEqual({ status: 'saved' });
    const stored = JSON.parse(getRouterState(ROW)!);
    expect(stored.signatureVersion).toBe(1);
    expect(stored.mac).toMatch(/^[0-9a-f]{64}$/);
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state: STATE });

    plant(STATE);
    expect(loadDeliveryState(JID)).toEqual({
      status: 'invalid',
      reason: 'missing-state-signature',
    });
  });

  it('a planted pending row is never delivered: it is dead-lettered, the operator is alerted, the row is cleared', async () => {
    for (const [name, key, reason] of [
      ['no signature', undefined, 'missing-state-signature'],
      [
        'a signature with a key of its own',
        'k'.repeat(64),
        'invalid-state-signature',
      ],
      ['an empty key', '', 'missing-state-signature'],
    ] as const) {
      plant(STATE, key);
      const { result, deps } = await deliverSaved();
      expect(result, name).toEqual({ status: 'retry', attempt: 1 });
      expect(deps.deliverPrepared, name).not.toHaveBeenCalled();
      expect(deps.runBusinessAgent, name).not.toHaveBeenCalled();
      expect(deps.auditDeadLetter, name).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'corrupt-state',
          reason: `corrupt-state: ${reason}`,
        }),
      );
      expect(deps.alertDeadLetter, name).toHaveBeenCalledTimes(1);
      expect(loadDeliveryState(JID), name).toEqual({ status: 'none' });
    }
  });

  it('the same holds after the start-up step, with the key from the key file', async () => {
    initDeliveryStateKeys(keyFile);
    plant(STATE);
    const { deps } = await deliverSaved();
    expect(deps.deliverPrepared).not.toHaveBeenCalled();
    expect(deps.alertDeadLetter).toHaveBeenCalledTimes(1);
  });
});

describe('the key file', () => {
  it('is created at the first start: 64 hex characters, mode 0600, in a folder made 0700', () => {
    const keys = initDeliveryStateKeys(keyFile);
    expect(keys.source).toBe('key-file');
    const content = fs.readFileSync(keyFile, 'utf8');
    expect(content).toMatch(/^[0-9a-f]{64}\n$/);
    expect(keys.sign).toBe(content.trim());
    expect(keys.verify).toEqual([keys.sign]);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(keyFile)).mode & 0o777).toBe(0o700);
  });

  it('is used from then on: state saved before a restart loads after it', () => {
    initDeliveryStateKeys(keyFile);
    expect(saveDeliveryState(STATE)).toEqual({ status: 'saved' });
    const before = fs.readFileSync(keyFile, 'utf8');
    _resetDeliveryStateKeysForTests(); // a new process
    expect(initDeliveryStateKeys(keyFile).sign).toBe(before.trim());
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(before);
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state: STATE });
  });

  it('two hosts never share a key', () => {
    const first = initDeliveryStateKeys(keyFile).sign;
    const other = initDeliveryStateKeys(path.join(root, 'other', 'k.key')).sign;
    expect(other).not.toBe(first);
  });

  it('its key stays accepted after a key is configured, and is no longer the signing key', () => {
    initDeliveryStateKeys(keyFile);
    expect(saveDeliveryState(STATE)).toEqual({ status: 'saved' });
    const fileKey = fs.readFileSync(keyFile, 'utf8').trim();
    _resetDeliveryStateKeysForTests();

    fs.writeFileSync(
      path.join(project, '.env'),
      'DELIVERY_STATE_SIGNING_KEY=fake-dedicated-key\n',
      { mode: 0o600 },
    );
    const keys = initDeliveryStateKeys(keyFile);
    expect(keys.source).toBe('DELIVERY_STATE_SIGNING_KEY');
    expect(keys.verify).toEqual(['fake-dedicated-key', fileKey]);
    expect(loadDeliveryState(JID)).toEqual({ status: 'valid', state: STATE });
    expect(saveDeliveryState(STATE)).toEqual({ status: 'saved' });
    const stored = JSON.parse(getRouterState(ROW)!);
    expect(stored.mac).toBe(mac(stored.payload, 'fake-dedicated-key'));
  });

  it('is not created when a key is configured', () => {
    fs.writeFileSync(
      path.join(project, '.env'),
      'WEBHOOK_SECRET=fake-webhook-secret\n',
      { mode: 0o600 },
    );
    const keys = initDeliveryStateKeys(keyFile);
    expect(keys).toEqual({
      sign: 'fake-webhook-secret',
      verify: ['fake-webhook-secret'],
      source: 'WEBHOOK_SECRET',
    });
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it('a file somebody widened is narrowed again before it is used', () => {
    initDeliveryStateKeys(keyFile);
    fs.chmodSync(keyFile, 0o644);
    _resetDeliveryStateKeysForTests();
    initDeliveryStateKeys(keyFile);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('the host does not start on something at that path it did not write, and the message does not quote it', () => {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    const cases: [string, () => void, RegExp][] = [
      [
        'other content',
        () => fs.writeFileSync(keyFile, 'not-a-key-PLANTED-VALUE\n'),
        /does not hold a key this host wrote/,
      ],
      [
        'an empty file',
        () => fs.writeFileSync(keyFile, ''),
        /does not hold a key/,
      ],
      [
        'a symbolic link',
        () => {
          const target = path.join(root, 'elsewhere.key');
          fs.writeFileSync(target, 'a'.repeat(64));
          fs.symlinkSync(target, keyFile);
        },
        /not a regular file/,
      ],
      [
        'a symbolic link to nothing',
        () => fs.symlinkSync(path.join(root, 'nothing-here'), keyFile),
        /not a regular file/,
      ],
      ['a folder', () => fs.mkdirSync(keyFile), /not a regular file/],
    ];
    for (const [name, make, message] of cases) {
      fs.rmSync(keyFile, { recursive: true, force: true });
      make();
      let thrown = '';
      try {
        initDeliveryStateKeys(keyFile);
      } catch (err) {
        thrown = String((err as Error).message);
      }
      expect(thrown, name).toMatch(message);
      expect(thrown, name).toContain(keyFile);
      expect(thrown, name).not.toContain('PLANTED-VALUE');
      // Nothing was signed with a key of unknown origin.
      expect(fs.existsSync(path.join(root, 'elsewhere.key')) ? 1 : 1).toBe(1);
    }
  });

  it('is refused inside the project folder, which the main container can read', () => {
    const inside = path.join(project, 'store', 'delivery-state.key');
    expect(deliveryStateKeyFileProblem(inside)).toMatch(
      /inside the project folder/,
    );
    expect(() => initDeliveryStateKeys(inside)).toThrow(
      /Set DELIVERY_STATE_SIGNING_KEY/,
    );
    expect(fs.existsSync(inside)).toBe(false);
    // A key somebody put there is not read either.
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, 'b'.repeat(64));
    fs.writeFileSync(
      path.join(project, '.env'),
      'WEBHOOK_SECRET=fake-webhook-secret\n',
      { mode: 0o600 },
    );
    expect(initDeliveryStateKeys(inside).verify).toEqual([
      'fake-webhook-secret',
    ]);
    // Through a link into the project folder too.
    fs.rmSync(path.join(project, '.env'));
    const linked = path.join(root, 'linked');
    fs.symlinkSync(path.join(project, 'store'), linked);
    expect(() =>
      initDeliveryStateKeys(path.join(linked, 'delivery-state.key')),
    ).toThrow(/inside the project folder/);
  });

  it('is refused when a folder above it is a link into the project folder and the last folders do not exist yet', () => {
    // The first start: "~/.config" leads into the store, "nanoclaw" is not
    // there yet.
    const config = path.join(root, 'home2', '.config');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.mkdirSync(path.join(project, 'store'));
    fs.symlinkSync(path.join(project, 'store'), config);
    const viaLink = path.join(config, 'nanoclaw', 'delivery-state.key');
    expect(deliveryStateKeyFileProblem(viaLink)).toMatch(
      /inside the project folder/,
    );
    expect(() => initDeliveryStateKeys(viaLink)).toThrow(
      /inside the project folder/,
    );
    expect(fs.readdirSync(path.join(project, 'store'))).toEqual([]);
  });

  it('never has a name with half a key under it, and leaves no other file behind', () => {
    initDeliveryStateKeys(keyFile);
    expect(fs.readdirSync(path.dirname(keyFile))).toEqual([
      'delivery-state.key',
    ]);
    // Created by a hard link of a finished file: the two steps are a write
    // under another name and a link, so the key's name appears complete.
    const source = fs.readFileSync(
      path.join(__dirname, 'delivery-state.ts'),
      'utf8',
    );
    const create = source.slice(source.indexOf('function createKeyFile'));
    expect(create.indexOf('fs.writeFileSync(tmp')).toBeGreaterThan(0);
    expect(create.indexOf('fs.linkSync(tmp, keyFile)')).toBeGreaterThan(
      create.indexOf('fs.writeFileSync(tmp'),
    );
  });

  it('with a key configured, a key file that cannot be read does not stop the host', () => {
    fs.writeFileSync(
      path.join(project, '.env'),
      'WEBHOOK_SECRET=fake-webhook-secret\n',
      { mode: 0o600 },
    );
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    for (const make of [
      () => fs.writeFileSync(keyFile, ''),
      () => fs.writeFileSync(keyFile, 'not a key'),
      () => fs.mkdirSync(keyFile),
    ]) {
      fs.rmSync(keyFile, { recursive: true, force: true });
      make();
      expect(initDeliveryStateKeys(keyFile)).toEqual({
        sign: 'fake-webhook-secret',
        verify: ['fake-webhook-secret'],
        source: 'WEBHOOK_SECRET',
      });
    }
    // A folder of that name where a file is expected on the way.
    const blocked = path.join(root, 'a-file');
    fs.writeFileSync(blocked, 'x');
    expect(
      initDeliveryStateKeys(path.join(blocked, 'nanoclaw', 'k.key')).source,
    ).toBe('WEBHOOK_SECRET');
  });

  it('by default lives in the host settings folder, outside the project folder and every fixed mount', () => {
    expect(path.dirname(DELIVERY_STATE_KEY_PATH)).toBe(HOST_CONFIG_DIR);
    const realCwd = vi.mocked(process.cwd).getMockImplementation();
    vi.mocked(process.cwd).mockRestore();
    try {
      const projectRoot = process.cwd();
      const rel = path.relative(projectRoot, DELIVERY_STATE_KEY_PATH);
      expect(rel.startsWith('..') || path.isAbsolute(rel)).toBe(true);
    } finally {
      if (realCwd) vi.spyOn(process, 'cwd').mockImplementation(realCwd);
    }
  });
});
