/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { readEnvFile } from './env.js';
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

/**
 * True where Docker runs in a VM (Docker Desktop on macOS or WSL) and
 * host.docker.internal is routed to the host's loopback.
 */
function usesDockerDesktop(): boolean {
  if (os.platform() === 'darwin') return true;
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  return fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
}

export function detectProxyBindHost(): string {
  // Docker Desktop (same VM routing on macOS and WSL) — loopback is correct.
  if (usesDockerDesktop()) return '127.0.0.1';

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

/**
 * What the agent container can reach on the network (CONTAINER_NETWORK).
 *
 * restricted: the container joins a Docker network created with --internal.
 *   It has no route beyond the host: no outside host, no git host, and no
 *   DNS answers for outside names. It reaches the credential proxy on that
 *   network's gateway address, and any other host service that listens on
 *   all interfaces (so keep host listeners on loopback).
 * open: the runtime's default network. The container can open a connection
 *   to any host.
 *
 * Verified with real containers on Docker Engine on Linux, where restricted
 * is the default. On Docker Desktop (macOS, WSL) the mechanism is not
 * verified, so the default there is open; `restricted` can be set by hand.
 */
export type ContainerNetworkMode = 'restricted' | 'open';

export function resolveContainerNetworkMode(
  value: string | undefined,
  dockerDesktop: boolean,
): ContainerNetworkMode {
  const v = (value || '').trim().toLowerCase();
  if (v === 'restricted' || v === 'open') return v;
  if (v)
    throw new Error(
      `CONTAINER_NETWORK must be "restricted" or "open", got "${value}"`,
    );
  return dockerDesktop ? 'open' : 'restricted';
}

/** Process environment first, then `.env`. Read on each call (tests stub it). */
export function containerNetworkMode(): ContainerNetworkMode {
  return resolveContainerNetworkMode(
    process.env.CONTAINER_NETWORK ||
      readEnvFile(['CONTAINER_NETWORK']).CONTAINER_NETWORK,
    usesDockerDesktop(),
  );
}

/** Name of the internal Docker network used when the network is restricted. */
export const RESTRICTED_NETWORK_NAME =
  process.env.CONTAINER_NETWORK_NAME || 'nanoclaw-agents';

let restrictedGateway: string | undefined;

function inspectRestrictedNetwork(): string | null {
  let out: string;
  try {
    out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'network',
        'inspect',
        '-f',
        '{{.Internal}} {{(index .IPAM.Config 0).Gateway}}',
        RESTRICTED_NETWORK_NAME,
      ],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    return null; // no such network
  }
  const [internal, gateway] = out.trim().split(/\s+/);
  // Never run "restricted" on a network that someone created without
  // --internal: it would be open under a restricted name.
  if (internal !== 'true')
    throw new Error(
      `Docker network ${RESTRICTED_NETWORK_NAME} exists but is not internal. ` +
        `Remove it (docker network rm ${RESTRICTED_NETWORK_NAME}) or set CONTAINER_NETWORK_NAME.`,
    );
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(gateway || ''))
    throw new Error(
      `Docker network ${RESTRICTED_NETWORK_NAME} has no IPv4 gateway address`,
    );
  return gateway;
}

/**
 * Create the internal network if it is missing and return its gateway
 * address (the host's address on that network). Inter-container traffic is
 * off, so agent containers cannot reach each other either.
 */
export function ensureRestrictedNetwork(): string {
  if (restrictedGateway) return restrictedGateway;
  let gateway = inspectRestrictedNetwork();
  if (!gateway) {
    execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'network',
        'create',
        '--internal',
        '-o',
        'com.docker.network.bridge.enable_icc=false',
        RESTRICTED_NETWORK_NAME,
      ],
      { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    gateway = inspectRestrictedNetwork();
    if (!gateway)
      throw new Error(
        `Could not create Docker network ${RESTRICTED_NETWORK_NAME}`,
      );
    logger.info(
      { network: RESTRICTED_NETWORK_NAME, gateway },
      'Created the internal network for agent containers',
    );
  }
  restrictedGateway = gateway;
  return gateway;
}

/** Test hook: forget the cached gateway address. */
export function _resetRestrictedNetworkForTests(): void {
  restrictedGateway = undefined;
}

/** True for an address only the host itself can reach. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * The restricted network still routes to the host on the network's gateway
 * address, so a host service that listens on all interfaces is reachable
 * from the agent container. The webhook listener does that by default
 * (WEBHOOK_HOST, src/channels/webhook.ts). The default is not changed here;
 * the operator is told at each start.
 */
export function warnIfWebhookReachableFromContainers(): void {
  const host = process.env.WEBHOOK_HOST || '0.0.0.0';
  if (isLoopbackHost(host)) return;
  logger.warn(
    { webhookHost: host },
    'CONTAINER_NETWORK is restricted, but the webhook listener is not on a ' +
      'loopback address (WEBHOOK_HOST): the agent container can reach it, ' +
      'and any other host service that listens on all interfaces, on the ' +
      'network gateway address. Set WEBHOOK_HOST=127.0.0.1 in the process ' +
      'environment and put a reverse proxy in front.',
  );
}

/**
 * Address the credential proxy must bind to for the current network mode.
 * Restricted on Linux: the internal network's gateway address, the only host
 * address those containers can route to. Otherwise PROXY_BIND_HOST.
 * CREDENTIAL_PROXY_HOST applies to the open network only (0.0.0.0 excepted).
 */
export function resolveProxyBindHost(): string {
  const mode = containerNetworkMode();
  if (mode === 'open') {
    logger.warn(
      'CONTAINER_NETWORK is open: the agent container can reach any host. ' +
        'What it reads (mail, the knowledge base) can leave without passing ' +
        'the delivery gate or the audit log. Set CONTAINER_NETWORK=restricted ' +
        'unless you need the agent to use the network.',
    );
    return PROXY_BIND_HOST;
  }
  warnIfWebhookReachableFromContainers();
  if (usesDockerDesktop()) {
    ensureRestrictedNetwork();
    logger.warn(
      'CONTAINER_NETWORK=restricted is not verified on Docker Desktop. ' +
        'Run scripts/check-container-egress.ts before you rely on it.',
    );
    return PROXY_BIND_HOST;
  }
  const gateway = ensureRestrictedNetwork();
  logger.info(
    { network: RESTRICTED_NETWORK_NAME, gateway },
    'Agent container network is restricted',
  );
  // The gateway is the only host address these containers can route to. An
  // override that names another address (docker0, loopback) would leave
  // every agent turn without a model, so it is not used here.
  const override = process.env.CREDENTIAL_PROXY_HOST;
  if (override === '0.0.0.0') return override;
  if (override && override !== gateway) {
    logger.warn(
      { override, gateway },
      'CREDENTIAL_PROXY_HOST is ignored while CONTAINER_NETWORK is restricted: the credential proxy binds to the restricted network gateway',
    );
  }
  return gateway;
}

/**
 * CLI args that set the container's network and how it resolves the host
 * gateway name.
 */
export function hostGatewayArgs(): string[] {
  if (containerNetworkMode() === 'restricted') {
    const gateway = ensureRestrictedNetwork();
    // Docker Desktop resolves host.docker.internal itself.
    if (usesDockerDesktop()) return ['--network', RESTRICTED_NETWORK_NAME];
    // `host-gateway` would give the docker0 address, which an internal
    // network cannot route to. Name this network's own gateway instead.
    return [
      '--network',
      RESTRICTED_NETWORK_NAME,
      `--add-host=${CONTAINER_HOST_GATEWAY}:${gateway}`,
    ];
  }
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
