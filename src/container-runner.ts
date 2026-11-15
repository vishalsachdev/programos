/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { writeAllowlistSnapshot } from './allowlist-snapshot.js';
import {
  chownTreeNoFollow,
  copyDirInTree,
  ensureDirInTree,
  writeFileInTree,
} from './host-fs-safety.js';
import { logger } from './logger.js';
import { getRepoReader } from './repo-reader.js';
import { runnerSourceNeedsCopy } from './runner-cache.js';
import {
  getTelegramUploadDir,
  TELEGRAM_UPLOAD_CONTAINER_PATH,
} from './telegram-upload-store.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import {
  detectAuthMode,
  registerProxyCaller,
  revokeProxyCaller,
} from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  CONTAINER_WORKING_CONTEXT_DIR,
  getWorkingContextDir,
} from './working-context.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  agentMode?: 'normal' | 'delivery-repair';
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  /**
   * Recopy the group's cached agent-runner source from the host before this
   * run. Set for the outreach composer run: the cache is group-writable and
   * persists, so a prior prompt-injected run could have tampered it.
   */
  forceRunnerRefresh?: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

// Chown a tree to the container user (uid 1000). Needed because the host
// process runs as root but the container runs as node. The tree is
// agent-writable, so links are lchown'd and never followed.
const CONTAINER_UID = 1000;
const CONTAINER_GID = 1000;

function chownToContainer(targetPath: string): void {
  try {
    chownTreeNoFollow(targetPath, CONTAINER_UID, CONTAINER_GID);
  } catch {
    // Best effort
  }
}

/**
 * Write a container run log under groups/<folder>/logs. Runs inside the
 * container 'close' handler, so a refusal (planted link) is logged, never
 * thrown: an exception there would take down the host process.
 */
function writeRunLog(groupDir: string, logFile: string, content: string): void {
  try {
    writeFileInTree(groupDir, path.relative(groupDir, logFile), content);
  } catch (err) {
    logger.warn({ logFile, err }, 'Container run log not written');
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  forceRunnerRefresh = false,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  // Originals/extractions are host-owned sources, never written through the
  // agent-writable curriculum checkout. Other groups do not see this store.
  const telegramUploadDir = getTelegramUploadDir(group.folder);
  if (fs.existsSync(telegramUploadDir)) {
    mounts.push({
      hostPath: telegramUploadDir,
      containerPath: TELEGRAM_UPLOAD_CONTAINER_PATH,
      readonly: true,
    });
  }

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (store, group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main gets writable access to the store (SQLite DB) so it can
    // query and write to the database directly.
    const storeDir = path.join(projectRoot, 'store');
    mounts.push({
      hostPath: storeDir,
      containerPath: '/workspace/project/store',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory — writable for main so it can update shared context
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: false,
      });
    }

    // Working-context store (private per-user WORKING layer) — writable for
    // main ONLY. Privacy gate: non-main groups never see this mount; see
    // src/working-context.ts (admin-only until the Coordinator user-privacy
    // question is resolved).
    const workingContextDir = getWorkingContextDir();
    ensureDirInTree(workingContextDir);
    chownToContainer(workingContextDir);
    mounts.push({
      hostPath: workingContextDir,
      containerPath: CONTAINER_WORKING_CONTEXT_DIR,
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  ensureDirInTree(groupSessionsDir);
  chownToContainer(groupSessionsDir);
  // Seed unless a regular file is there; a planted link is replaced.
  let hasSettings = false;
  try {
    hasSettings = fs
      .lstatSync(path.join(groupSessionsDir, 'settings.json'))
      .isFile();
  } catch {
    // absent
  }
  if (!hasSettings) {
    writeFileInTree(
      groupSessionsDir,
      'settings.json',
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      copyDirInTree(srcDir, groupSessionsDir, path.join('skills', skillDir));
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  for (const sub of ['messages', 'tasks', 'input'])
    ensureDirInTree(groupIpcDir, sub);
  chownToContainer(groupIpcDir);
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // RC-018: pinned allowlist for the container's send_email precheck. Its
  // own READ-ONLY mount, so a prompt-injected agent cannot rewrite the
  // snapshot its tool judges from.
  // Outside every writable mount (data/sessions/<group> is mounted writable
  // at /home/node/.claude), so no alias path can rewrite it.
  const allowlistSnapshotDir = path.join(
    DATA_DIR,
    'allowlist-snapshots',
    group.folder,
  );
  fs.mkdirSync(allowlistSnapshotDir, { recursive: true });
  const reader = getRepoReader();
  writeAllowlistSnapshot(allowlistSnapshotDir, {
    readFile: (rel) => reader.readFile(rel),
    currentSha: reader.allowlistPin,
  });
  chownToContainer(allowlistSnapshotDir);
  mounts.push({
    hostPath: allowlistSnapshotDir,
    containerPath: '/workspace/allowlist',
    readonly: true,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    // Whole-tree staleness check (RC-018): any runner file newer than its
    // cached copy, or absent from the cache, triggers a refresh.
    const needsCopy = runnerSourceNeedsCopy(
      agentRunnerSrc,
      groupAgentRunnerDir,
      forceRunnerRefresh,
    );
    if (needsCopy) {
      // Wipe, don't overlay: a tampered or stale cache may contain extra
      // files that a plain recursive copy would leave in place.
      fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  proxyToken: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );
  args.push(
    '-e',
    `ANTHROPIC_CUSTOM_HEADERS=X-NanoClaw-Proxy-Token: ${proxyToken}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Per-call-site model config: forward the model knobs into the container
  // when set on the host (PM2 env). NANOCLAW_AGENT_MODEL overrides the main
  // session's model; NANOCLAW_GATE_MODEL overrides the kb-gate-reviewer
  // subagent's model (agent-runner defaults it to 'opus' when unset);
  // NANOCLAW_AGENT_EFFORT overrides both sessions' effort (default 'high').
  for (const key of [
    'NANOCLAW_AGENT_MODEL',
    'NANOCLAW_GATE_MODEL',
    'NANOCLAW_AGENT_EFFORT',
  ]) {
    const value = process.env[key];
    if (value) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  ensureDirInTree(groupDir);

  const mounts = buildVolumeMounts(
    group,
    input.isMain,
    input.forceRunnerRefresh === true || input.agentMode === 'delivery-repair',
  );
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const proxyToken = randomBytes(32).toString('hex');
  const containerArgs = buildContainerArgs(mounts, containerName, proxyToken);
  const loggedArgs = containerArgs
    .map((arg) =>
      arg.startsWith('ANTHROPIC_CUSTOM_HEADERS=')
        ? 'ANTHROPIC_CUSTOM_HEADERS=[REDACTED]'
        : arg,
    )
    .join(' ');

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: loggedArgs,
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  // groups/<folder> is agent-writable: logs/ and each log file are
  // created through host-fs-safety so a planted link is never followed.
  ensureDirInTree(groupDir, 'logs');

  return new Promise((resolve) => {
    registerProxyCaller(proxyToken);
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { group: group.name, containerName, err },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      revokeProxyCaller(proxyToken);
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        writeRunLog(
          groupDir,
          path.join(groupDir, 'logs', `container-${ts}.log`),
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(groupDir, 'logs', `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          loggedArgs,
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      writeRunLog(groupDir, logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      revokeProxyCaller(proxyToken);
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

/** Shape of a task as exposed to containers via current_tasks.json. */
interface TaskSnapshotRow {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

function normalizeTaskPrompt(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: string }).type === 'Buffer' &&
    Array.isArray((value as { data?: number[] }).data)
  ) {
    try {
      return Buffer.from((value as { data: number[] }).data).toString('utf-8');
    } catch (_err) {
      // fall through to generic string coercion
    }
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function toTaskSnapshotRow(t: ScheduledTask): TaskSnapshotRow {
  return {
    id: t.id,
    groupFolder: t.group_folder,
    prompt: normalizeTaskPrompt(t.prompt),
    script: normalizeTaskPrompt(t.script) || undefined,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  };
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: ScheduledTask[],
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);

  // Main sees all tasks, others only see their own
  const filteredTasks = (
    isMain ? tasks : tasks.filter((t) => t.group_folder === groupFolder)
  ).map(toTaskSnapshotRow);

  writeFileInTree(
    groupIpcDir,
    'current_tasks.json',
    JSON.stringify(filteredTasks, null, 2),
  );
}

/** Write a host-computed artifact into the group's IPC directory. */
export function writeIpcFile(
  groupFolder: string,
  name: string,
  content: string,
): void {
  writeFileInTree(resolveGroupIpcPath(groupFolder), name, content);
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  writeFileInTree(
    groupIpcDir,
    'available_groups.json',
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
