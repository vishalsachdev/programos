import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const {
  mockExecSync,
  mockExecFileSync,
  mockPlatform,
  mockInterfaces,
  mockExists,
} = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(
    () => '2: docker0 inet 172.17.0.1/16 scope global docker0\n',
  ),
  mockPlatform: vi.fn(() => 'linux'),
  mockInterfaces: vi.fn(() => ({})),
  mockExists: vi.fn(() => false),
}));
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: () => mockExecFileSync(),
}));
vi.mock('os', () => ({
  default: {
    platform: () => mockPlatform(),
    networkInterfaces: () => mockInterfaces(),
  },
}));
vi.mock('fs', () => ({ default: { existsSync: () => mockExists() } }));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  detectProxyBindHost,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.mockReturnValue('linux');
  mockInterfaces.mockReturnValue({});
  mockExists.mockReturnValue(false);
  mockExecFileSync.mockReturnValue(
    '2: docker0 inet 172.17.0.1/16 scope global docker0\n',
  );
});

describe('proxy bind host', () => {
  it('uses docker0 address when the link is down and Node omits it', () => {
    expect(detectProxyBindHost()).toBe('172.17.0.1');
  });

  it('fails closed if Linux has no docker0 IPv4 address', () => {
    mockExecFileSync.mockReturnValueOnce('');
    expect(() => detectProxyBindHost()).toThrow(/docker0 IPv4/);
  });

  it('keeps macOS and WSL on loopback', () => {
    mockPlatform.mockReturnValue('darwin');
    expect(detectProxyBindHost()).toBe('127.0.0.1');
    mockPlatform.mockReturnValue('linux');
    mockExists.mockReturnValue(true);
    expect(detectProxyBindHost()).toBe('127.0.0.1');
  });
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    mockExecSync.mockReturnValueOnce('2026-03-17T10:00:00.000000000Z');
    mockExecSync.mockReturnValueOnce('');
    mockExecSync.mockReturnValueOnce('2026-03-17T09:59:00.000000000Z');
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(5);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      5,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    mockExecSync.mockReturnValueOnce('2026-03-17T10:00:00.000000000Z');
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('2026-03-17T09:59:00.000000000Z');
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(5);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 1, names: ['nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });

  it('preserves recently started containers during restart handoff', () => {
    vi.setSystemTime(new Date('2026-03-17T10:00:30.000Z'));
    mockExecSync.mockReturnValueOnce('nanoclaw-recent-1\nnanoclaw-old-2\n');
    mockExecSync.mockReturnValueOnce('2026-03-17T10:00:00.000Z');
    mockExecSync.mockReturnValueOnce('2026-03-17T09:58:00.000Z');
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-old-2`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      {
        count: 1,
        names: ['nanoclaw-recent-1'],
        graceMs: 60000,
      },
      'Preserved recently started containers during orphan cleanup',
    );
  });
});
