import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock the agent-writable-tree helpers (real ones touch the filesystem)
vi.mock('./host-fs-safety.js', () => ({
  chownTreeNoFollow: vi.fn(),
  copyDirInTree: vi.fn(),
  ensureDirInTree: vi.fn((root: string) => root),
  writeFileInTree: vi.fn(),
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Mock credential-proxy
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
  registerProxyCaller: vi.fn(),
  revokeProxyCaller: vi.fn(),
}));

// Create a controllable fake ChildProcess
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
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import fs from 'fs';
import { spawn } from 'child_process';
import { logger } from './logger.js';
import { registerProxyCaller, revokeProxyCaller } from './credential-proxy.js';
import { writeFileInTree } from './host-fs-safety.js';
import {
  runContainerAgent,
  ContainerOutput,
  writeTasksSnapshot,
} from './container-runner.js';
import type { RegisteredGroup, ScheduledTask } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a unique caller token, passes it to Claude, and revokes on close without logging it', async () => {
    const resultPromise = runContainerAgent(testGroup, testInput, () => {});
    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const header = args.find((arg) =>
      arg.startsWith('ANTHROPIC_CUSTOM_HEADERS='),
    );
    expect(header).toMatch(
      /^ANTHROPIC_CUSTOM_HEADERS=X-NanoClaw-Proxy-Token: [0-9a-f]{64}$/,
    );
    const token = header!.split(': ')[1];
    expect(registerProxyCaller).toHaveBeenCalledWith(token);
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(
      token,
    );
    fakeProc.emit('close', 1);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
    expect(revokeProxyCaller).toHaveBeenCalledWith(token);
    expect(JSON.stringify(vi.mocked(writeFileInTree).mock.calls)).not.toContain(
      token,
    );
  });

  it('mounts saved Telegram sources read-only and only for the current group', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      String(p).includes('/telegram-uploads/'),
    );
    try {
      const resultPromise = runContainerAgent(testGroup, testInput, () => {});
      const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
      expect(args).toContain(
        '/tmp/nanoclaw-test-data/telegram-uploads/test-group:/workspace/telegram-uploads:ro',
      );
      expect(
        args.some(
          (arg) => arg.includes('/telegram-uploads/') && !arg.endsWith(':ro'),
        ),
      ).toBe(false);
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      await resultPromise;
    } finally {
      vi.mocked(fs.existsSync).mockReturnValue(false);
    }
  });

  it('forwards the model and effort knobs into the container when set', async () => {
    process.env.NANOCLAW_AGENT_EFFORT = 'xhigh';
    process.env.NANOCLAW_AGENT_MODEL = 'claude-opus-5-5';
    try {
      const resultPromise = runContainerAgent(testGroup, testInput, () => {});
      const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
      expect(args).toContain('NANOCLAW_AGENT_EFFORT=xhigh');
      expect(args).toContain('NANOCLAW_AGENT_MODEL=claude-opus-5-5');
      fakeProc.emit('close', 0);
      await vi.advanceTimersByTimeAsync(10);
      await resultPromise;
    } finally {
      delete process.env.NANOCLAW_AGENT_EFFORT;
      delete process.env.NANOCLAW_AGENT_MODEL;
    }
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container agent mode contract', () => {
  it('disables every tool and MCP server only in delivery-repair mode', async () => {
    const actualFs = await vi.importActual<typeof import('fs')>('fs');
    const source = actualFs.readFileSync(
      'container/agent-runner/src/index.ts',
      'utf8',
    );

    expect(source).toContain("agentMode?: 'normal' | 'delivery-repair'");
    expect(source).toMatch(
      /const isDeliveryRepair\s*=\s*containerInput\.agentMode === 'delivery-repair'/,
    );
    expect(source).toContain(
      'allowedTools: isDeliveryRepair ? [] : NORMAL_ALLOWED_TOOLS',
    );
    expect(source).toContain(
      'mcpServers: isDeliveryRepair ? {} : normalMcpServers',
    );
    expect(source).toContain("'mcp__nanoclaw__*'");
    expect(source).toContain('nanoclaw: {');

    const hostSource = actualFs.readFileSync('src/container-runner.ts', 'utf8');
    expect(hostSource).toContain(
      "input.forceRunnerRefresh === true || input.agentMode === 'delivery-repair'",
    );
  });
});

describe('writeTasksSnapshot', () => {
  it('normalizes a Buffer prompt before writing current_tasks.json', () => {
    const task: ScheduledTask = {
      id: 'task-buffer',
      group_folder: 'test',
      chat_jid: 'group@g.us',
      prompt: Buffer.from('buffer prompt') as unknown as string,
      script: null,
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    };

    writeTasksSnapshot('test', true, [task]);

    const calls = vi.mocked(writeFileInTree).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastCall = calls[calls.length - 1];
    const [, name, content] = lastCall;
    expect(name).toBe('current_tasks.json');
    const parsed = JSON.parse(content as string);
    expect(parsed[0].prompt).toBe('buffer prompt');
  });
});
