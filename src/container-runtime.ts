/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

const ORPHAN_CLEANUP_GRACE_MS = parseInt(
  process.env.NANOCLAW_ORPHAN_CLEANUP_GRACE_MS || '60000',
  10,
);

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   including when the bridge is down and Node omits it from networkInterfaces().
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

export function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // Node excludes a down docker0 link. ip reports its assigned address even
  // without carrier. Never widen the bind to all host interfaces on failure.
  try {
    const output = execFileSync(
      'ip',
      ['-4', '-o', 'addr', 'show', 'dev', 'docker0'],
      {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const address = output.match(
      /\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/,
    )?.[1];
    if (address) return address;
  } catch {
    // Missing bridge or ip command: fail closed below.
  }
  throw new Error('Cannot determine docker0 IPv4 address for credential proxy');
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    const preserved: string[] = [];
    const stopped: string[] = [];
    const now = Date.now();

    for (const name of orphans) {
      try {
        const startedAt = execSync(
          `${CONTAINER_RUNTIME_BIN} inspect --format '{{.State.StartedAt}}' ${name}`,
          { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
        )
          .trim()
          .replace(/^'+|'+$/g, '');
        const startedAtMs = Date.parse(startedAt);
        if (
          !Number.isNaN(startedAtMs) &&
          now - startedAtMs < ORPHAN_CLEANUP_GRACE_MS
        ) {
          preserved.push(name);
          continue;
        }
      } catch {
        // If inspect fails, fall through and try to stop it.
      }

      try {
        stopContainer(name);
        stopped.push(name);
      } catch {
        /* already stopped */
      }
    }
    if (stopped.length > 0) {
      logger.info(
        { count: stopped.length, names: stopped },
        'Stopped orphaned containers',
      );
    }
    if (preserved.length > 0) {
      logger.info(
        {
          count: preserved.length,
          names: preserved,
          graceMs: ORPHAN_CLEANUP_GRACE_MS,
        },
        'Preserved recently started containers during orphan cleanup',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
