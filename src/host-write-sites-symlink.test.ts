import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every host (root) write into a tree an agent container can write to, called
// through the real production function with a symlink planted where the agent
// could plant one. host-fs-safety.test.ts proves the helpers; this file proves
// the call sites use them. Agent-writable host paths (see buildVolumeMounts):
// data/ipc/<g>, data/sessions/<g>/.claude, groups/<g>, data/working-context.

const paths = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  const base = `${tmp}/nc-host-write-sites-${process.pid}`;
  return {
    base,
    data: `${base}/data`,
    groups: `${base}/groups`,
    store: `${base}/store`,
    outside: `${base}/outside`,
  };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: paths.data,
  GROUPS_DIR: paths.groups,
  STORE_DIR: paths.store,
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));
vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({
    readFile: () => null,
    allowlistPin: null,
    refresh: () => {},
  }),
}));
vi.mock('./allowlist-snapshot.js', () => ({
  writeAllowlistSnapshot: vi.fn(),
}));

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 4242;
  return proc;
}
let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: vi.fn(() => fakeProc) };
});

import {
  runContainerAgent,
  writeGroupsSnapshot,
  writeIpcFile,
  writeTasksSnapshot,
} from './container-runner.js';
import { readGroupTemplate, seedGroupFolder } from './group-folder.js';
import { GroupQueue } from './group-queue.js';
import { processImage } from './image.js';
import { initDatabase } from './db.js';
import { exportEvalReport } from './eval-tracker.js';
import { drainIpcDir } from './ipc.js';
import { SqliteOutboxStore } from './outbound-email-outbox.js';
import {
  ensureWorkingContextStore,
  loadWorkingContext,
  loadWorkingContextAsync,
  pruneStaleEntries,
} from './working-context.js';
import type { RegisteredGroup } from './types.js';

const SECRET = 'KEEP=1\n';
let secret: string;
let chown: ReturnType<typeof vi.spyOn>;
let lchown: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fs.rmSync(paths.base, { recursive: true, force: true });
  for (const d of [paths.data, paths.groups, paths.store, paths.outside])
    fs.mkdirSync(d, { recursive: true });
  secret = path.join(paths.outside, 'secret.env');
  fs.writeFileSync(secret, SECRET);
  fakeProc = createFakeProcess();
  // Record ownership changes instead of making them (tests are not root).
  chown = vi.spyOn(fs, 'chownSync').mockImplementation(() => {});
  lchown = vi.spyOn(fs, 'lchownSync').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(paths.base, { recursive: true, force: true });
});

/** Nothing was created in, removed from, or changed under `outside`. */
function expectOutsideUntouched(extra: string[] = []): void {
  expect(fs.readdirSync(paths.outside).sort()).toEqual(
    ['secret.env', ...extra].sort(),
  );
  expect(fs.readFileSync(secret, 'utf8')).toBe(SECRET);
}

/** chown follows links; lchown does not. Neither may reach `outside`. */
function ownershipChangesOutside(): string[] {
  const realOutside = fs.realpathSync(paths.outside);
  const followed = (chown.mock.calls as unknown[][])
    .map((c) => String(c[0]))
    .filter((p) => {
      try {
        return fs.realpathSync(p).startsWith(realOutside);
      } catch {
        return false;
      }
    });
  const direct = (lchown.mock.calls as unknown[][])
    .map((c) => path.resolve(String(c[0])))
    .filter((p) => p.startsWith(paths.outside));
  return [...followed, ...direct];
}

function plant(linkPath: string, target: string): void {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath);
}

const group = (folder: string, isMain = false): RegisteredGroup => ({
  name: folder,
  folder,
  trigger: '@K',
  added_at: new Date().toISOString(),
  ...(isMain ? { isMain: true } : {}),
});

async function runOnce(folder: string, isMain = false): Promise<void> {
  const run = runContainerAgent(
    group(folder, isMain),
    { prompt: 'hi', groupFolder: folder, chatJid: 'j@x', isMain },
    () => {},
  );
  setImmediate(() => fakeProc.emit('close', 0));
  await run.catch(() => {}); // refusing to start is an acceptable outcome
}

const ipc = (...p: string[]) => path.join(paths.data, 'ipc', 'g', ...p);
const sessions = (...p: string[]) =>
  path.join(paths.data, 'sessions', 'g', '.claude', ...p);
const wc = (...p: string[]) => path.join(paths.data, 'working-context', ...p);

describe('data/ipc/<g>: host writes never follow a planted symlink', () => {
  it('writeTasksSnapshot does not write through current_tasks.json', () => {
    plant(ipc('current_tasks.json'), secret);
    try {
      writeTasksSnapshot('g', false, []);
    } catch {
      /* refusing is fine */
    }
    expectOutsideUntouched();
  });

  it('writeGroupsSnapshot does not write through available_groups.json', () => {
    plant(ipc('available_groups.json'), secret);
    try {
      writeGroupsSnapshot('g', true, []);
    } catch {
      /* refusing is fine */
    }
    expectOutsideUntouched();
  });

  it('writeIpcFile does not write through a host artifact name', () => {
    plant(ipc('exceptions_report.json'), secret);
    try {
      writeIpcFile('g', 'exceptions_report.json', '{}\n');
    } catch {
      /* refusing is fine */
    }
    expectOutsideUntouched();
  });

  it('GroupQueue.closeStdin does not write _close through a linked input/', () => {
    plant(ipc('input'), paths.outside);
    const q = new GroupQueue();
    const state = (
      q as unknown as {
        getGroup(j: string): { active: boolean; groupFolder: string | null };
      }
    ).getGroup('j@x');
    state.active = true;
    state.groupFolder = 'g';
    q.closeStdin('j@x');
    expectOutsideUntouched();
  });

  it('GroupQueue.sendMessage does not write a message through a linked input/', () => {
    plant(ipc('input'), paths.outside);
    const q = new GroupQueue();
    const state = (
      q as unknown as {
        getGroup(j: string): { active: boolean; groupFolder: string | null };
      }
    ).getGroup('j@x');
    state.active = true;
    state.groupFolder = 'g';
    q.sendMessage('j@x', 'hello');
    expectOutsideUntouched();
  });

  it('drainIpcDir does not read or delete files through a linked messages/', async () => {
    const planted = path.join(paths.outside, 'msg.json');
    fs.writeFileSync(planted, JSON.stringify({ type: 'message', text: 'x' }));
    plant(ipc('messages'), paths.outside);
    const handle = vi.fn(async () => {});
    await drainIpcDir(
      ipc('messages'),
      path.join(paths.data, 'ipc'),
      'g',
      'message',
      handle,
    );
    expect(handle).not.toHaveBeenCalled();
    expectOutsideUntouched(['msg.json']);
  });

  it('drainIpcDir does not read a message through a linked file', async () => {
    const planted = path.join(paths.outside, 'msg.json');
    fs.writeFileSync(planted, JSON.stringify({ type: 'message', text: 'x' }));
    plant(ipc('messages', 'a.json'), planted);
    const handle = vi.fn(async () => {});
    await drainIpcDir(
      ipc('messages'),
      path.join(paths.data, 'ipc'),
      'g',
      'message',
      handle,
    );
    expect(handle).not.toHaveBeenCalled();
    expectOutsideUntouched(['msg.json']);
  });

  it('container start does not chown through a linked ipc subdirectory', async () => {
    plant(ipc('messages'), paths.outside);
    await runOnce('g');
    expect(ownershipChangesOutside()).toEqual([]);
    expectOutsideUntouched();
  });
});

describe('data/sessions/<g>/.claude: host writes never follow a planted symlink', () => {
  it('skills sync does not copy into a linked skills/ directory', async () => {
    plant(sessions('skills'), paths.outside);
    await runOnce('g');
    expectOutsideUntouched();
  });

  it('skills sync does not copy into a linked per-skill directory', async () => {
    plant(sessions('skills', 'status'), paths.outside);
    await runOnce('g');
    expectOutsideUntouched();
  });

  it('settings.json seeding does not write through a dangling link', async () => {
    plant(sessions('settings.json'), path.join(paths.outside, 'settings.json'));
    await runOnce('g');
    expectOutsideUntouched();
  });

  it('container start does not chown through a linked sessions entry', async () => {
    plant(sessions('escape'), paths.outside);
    await runOnce('g');
    expect(ownershipChangesOutside()).toEqual([]);
  });
});

describe('groups/<g>: host writes never follow a planted symlink', () => {
  it('the container run log is not written through a linked logs/', async () => {
    plant(path.join(paths.groups, 'g', 'logs'), paths.outside);
    await runOnce('g');
    expectOutsideUntouched();
  });

  it('processImage does not write through a linked attachments/', async () => {
    plant(path.join(paths.groups, 'g', 'attachments'), paths.outside);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    await processImage(png, path.join(paths.groups, 'g'), '').catch(() => {});
    expectOutsideUntouched();
  });

  it('readGroupTemplate does not read the template through a link', () => {
    // groups/global is writable for the main group; a linked template would
    // copy a host file (e.g. .env) into every newly registered group.
    plant(path.join(paths.groups, 'global', 'CLAUDE.md'), secret);
    let template: string | null = null;
    try {
      template = readGroupTemplate(false);
    } catch {
      /* refusing is fine */
    }
    expect(template).toBeNull();
  });

  it('seedGroupFolder does not write CLAUDE.md through a dangling link', () => {
    plant(
      path.join(paths.groups, 'g', 'CLAUDE.md'),
      path.join(paths.outside, 'CLAUDE.md'),
    );
    try {
      seedGroupFolder(path.join(paths.groups, 'g'), '# K\n');
    } catch {
      /* refusing is fine */
    }
    expectOutsideUntouched();
  });
});

describe('data/working-context: host writes never follow a planted symlink', () => {
  const stale = [
    { ts: '2020-01-01T00:00:00Z', type: 'thread', text: 'old thread' },
  ];

  it('ensureWorkingContextStore does not create the store through a dangling link', () => {
    plant(wc('avery.json'), path.join(paths.outside, 'avery.json'));
    try {
      ensureWorkingContextStore('avery', paths.data);
    } catch {
      /* refusing is fine */
    }
    expectOutsideUntouched();
  });

  it('pruneStaleEntries does not write the archive through a dangling link', () => {
    fs.mkdirSync(wc(), { recursive: true });
    fs.writeFileSync(wc('avery.json'), JSON.stringify(stale));
    plant(
      wc('avery.archive.json'),
      path.join(paths.outside, 'avery.archive.json'),
    );
    pruneStaleEntries('avery', paths.data, new Date('2026-09-25T00:00:00Z'));
    expectOutsideUntouched();
  });

  it('loadWorkingContext does not read the store through a link', async () => {
    const hostFile = path.join(paths.outside, 'entries.json');
    fs.writeFileSync(hostFile, JSON.stringify(stale));
    plant(wc('avery.json'), hostFile);
    expect(loadWorkingContext('avery', paths.data)).toEqual([]);
    expect(await loadWorkingContextAsync('avery', paths.data)).toEqual([]);
  });

  it('container start does not chown through a linked working-context entry', async () => {
    plant(wc('escape'), paths.outside);
    await runOnce('main', true);
    expect(ownershipChangesOutside()).toEqual([]);
  });
});

describe('store/ (main-writable): SQLite opens never follow a planted symlink', () => {
  // SQLite follows a link at the database path and creates a missing target,
  // so a dangling link would have root create a file anywhere on the host.
  it('initDatabase does not open messages.db through a link', () => {
    plant(
      path.join(paths.store, 'messages.db'),
      path.join(paths.outside, 'x.db'),
    );
    try {
      initDatabase();
    } catch {
      /* refusing is fine */
    }
    expectOutsideUntouched();
  });

  it('the eval store does not open evals.db through a link', () => {
    plant(path.join(paths.store, 'evals.db'), path.join(paths.outside, 'e.db'));
    try {
      exportEvalReport('2026-01-01T00:00:00Z');
    } catch {
      /* refusing is fine */
    }
    expectOutsideUntouched();
  });

  it('the outbox process lock does not open outbox.lock.db through a link', () => {
    const lockPath = path.join(paths.store, 'outbox.lock.db');
    plant(lockPath, path.join(paths.outside, 'l.db'));
    const store = new SqliteOutboxStore({
      database: new Database(':memory:'),
      lockDbPath: lockPath,
    });
    try {
      store.acquireProcessLock();
    } catch {
      /* refusing is fine */
    }
    store.releaseProcessLock();
    expectOutsideUntouched();
  });
});
