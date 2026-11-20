#!/usr/bin/env tsx
/**
 * First-start check for the agent container's network and the push path.
 *
 *   npx tsx scripts/check-container-egress.ts
 *
 * Run it on the deployment host, as the user that runs the service, with the
 * same environment (CONTAINER_NETWORK, CONTAINER_IMAGE, PROGRAM_REPO). It
 * starts containers with the network arguments the host itself uses
 * (hostGatewayArgs in src/container-runtime.ts) and checks:
 *
 *   1. the container reaches the host on the credential proxy's address;
 *   2. restricted: the container cannot reach an outside host by name or by
 *      address, and cannot resolve an outside name;
 *      open: reported, not failed;
 *   3. a commit made inside the container, in a mounted checkout, ends up on
 *      the remote after the host's push (a temporary local remote, so the
 *      real knowledge base is not touched);
 *   4. if PROGRAM_REPO is a checkout: the host credential can push there
 *      (`git push --dry-run`, which changes nothing).
 *
 * Exit code 0 only if every check passes.
 */
import { execFile, execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE } from '../src/config.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  containerNetworkMode,
  hostGatewayArgs,
  resolveProxyBindHost,
} from '../src/container-runtime.js';
import { pushCheckoutAfterTurn } from '../src/checkout-sync.js';
import { CHECKOUT_OWNER, checkoutGitOptions } from '../src/program-repo.js';

const OUTSIDE_NAME = process.env.CHECK_OUTSIDE_HOST || 'example.com';
const OUTSIDE_ADDRESS = process.env.CHECK_OUTSIDE_ADDRESS || '1.1.1.1';

let failed = 0;
function report(ok: boolean, what: string, detail = ''): void {
  if (!ok) failed++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? `\n      ${detail}` : ''}`,
  );
}

/** The same --user rule as buildContainerArgs in src/container-runner.ts. */
function userArgs(): string[] {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid != null && uid !== 0 && uid !== 1000)
    return ['--user', `${uid}:${gid}`, '-e', 'HOME=/home/node'];
  // An image without a USER line (not the agent image) would run as root.
  return ['--user', `${CHECKOUT_OWNER.uid}:${CHECKOUT_OWNER.gid}`];
}

/** Async on purpose: check 1 answers from a listener in this process. */
function inContainer(
  script: string,
  mounts: string[] = [],
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      CONTAINER_RUNTIME_BIN,
      [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        ...hostGatewayArgs(),
        ...userArgs(),
        ...mounts,
        CONTAINER_IMAGE,
        '-c',
        script,
      ],
      { encoding: 'utf8', timeout: 120_000 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          out: `${stdout}${stderr}`.trim(),
        }),
    );
  });
}

async function main(): Promise<void> {
  const mode = containerNetworkMode();
  console.log(`CONTAINER_NETWORK: ${mode}   image: ${CONTAINER_IMAGE}\n`);

  // 1. The host address the credential proxy binds to. A stand-in listener
  //    on a free port: the running service may hold the real port.
  const bindHost = resolveProxyBindHost();
  const server = http.createServer((_req, res) => res.end('proxy-address-ok'));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const proxy = await inContainer(
    `curl -s -m 10 http://${CONTAINER_HOST_GATEWAY}:${port}/`,
  );
  server.close();
  report(
    proxy.out.includes('proxy-address-ok'),
    `container reaches the host at ${bindHost} (credential proxy address)`,
    proxy.out.includes('proxy-address-ok') ? '' : proxy.out,
  );

  // 2. The outside.
  const byName = await inContainer(
    `curl -s -k -m 10 -o /dev/null https://${OUTSIDE_NAME}/ && echo REACHED`,
  );
  const byAddress = await inContainer(
    `curl -s -k -m 10 -o /dev/null https://${OUTSIDE_ADDRESS}/ && echo REACHED`,
  );
  const dns = await inContainer(
    `getent hosts ${OUTSIDE_NAME} >/dev/null 2>&1 && echo RESOLVED`,
  );
  if (mode === 'restricted') {
    report(
      !byName.out.includes('REACHED'),
      `outside host by name is unreachable (${OUTSIDE_NAME})`,
    );
    report(
      !byAddress.out.includes('REACHED'),
      `outside host by address is unreachable (${OUTSIDE_ADDRESS})`,
    );
    report(
      !dns.out.includes('RESOLVED'),
      `outside name does not resolve (${OUTSIDE_NAME})`,
      dns.out.includes('RESOLVED')
        ? 'DNS answers leave the host: data can be sent out inside lookups. A newer Docker does not answer outside names on an internal network (seen on Docker 29).'
        : '',
    );
  } else {
    console.log(
      `NOTE  network is open: outside by name ${byName.out.includes('REACHED') ? 'reachable' : 'not reachable'}, ` +
        `by address ${byAddress.out.includes('REACHED') ? 'reachable' : 'not reachable'}. ` +
        'Nothing limits what the agent can send out.',
    );
  }

  // 3. A commit made in the container reaches the remote through the host.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-check-'));
  try {
    const remote = path.join(tmp, 'remote.git');
    const checkout = path.join(tmp, 'checkout');
    const g = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=check',
          '-c',
          'user.email=check@example.org',
          ...args,
        ],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    g(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
    g(tmp, 'clone', '-q', remote, checkout);
    g(checkout, 'checkout', '-q', '-b', 'main');
    fs.writeFileSync(path.join(checkout, 'README.md'), 'check\n');
    g(checkout, 'add', 'README.md');
    g(checkout, 'commit', '-q', '-m', 'start');
    g(checkout, 'push', '-q', '-u', 'origin', 'main');
    // The host's git runs as the checkout owner when the host is root.
    if (process.getuid?.() === 0)
      execFileSync('chown', [
        '-R',
        `${CHECKOUT_OWNER.uid}:${CHECKOUT_OWNER.gid}`,
        tmp,
      ]);
    else fs.chmodSync(tmp, 0o755);

    const commit = await inContainer(
      'cd /workspace/extra/program-repo && ' +
        'git config user.name Coordinator && git config user.email bot@example.org && ' +
        'echo "written in the container" > from-container.md && ' +
        'git add from-container.md && git commit -q -m "container commit" && git rev-parse HEAD',
      ['-v', `${checkout}:/workspace/extra/program-repo`],
    );
    const sha = commit.out.split('\n').at(-1) || '';
    report(
      commit.code === 0 && /^[0-9a-f]{40}$/.test(sha),
      'the container can commit in the mounted checkout',
      commit.code === 0 ? '' : commit.out,
    );

    process.env.PROGRAM_REPO = checkout;
    const outcome = await pushCheckoutAfterTurn();
    let onRemote = '';
    try {
      onRemote = execFileSync('git', ['rev-parse', 'main'], {
        ...checkoutGitOptions(),
        cwd: remote,
        encoding: 'utf8',
      }).trim();
    } catch {
      // reported below
    }
    report(
      outcome === 'pushed' && onRemote === sha,
      'the host pushed the container commit to the remote',
      outcome === 'pushed' ? '' : `push outcome: ${outcome}`,
    );
  } finally {
    delete process.env.PROGRAM_REPO;
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 4. The real checkout: can the host credential push? Changes nothing.
  const real = checkoutGitOptions().cwd;
  if (fs.existsSync(path.join(real, '.git'))) {
    const r = spawnSync('git', ['push', '--dry-run'], {
      ...checkoutGitOptions(),
      encoding: 'utf8',
    });
    report(
      r.status === 0,
      `the host credential can push from ${real} (dry run)`,
      r.status === 0 ? '' : `${r.stderr}`.trim().slice(0, 300),
    );
  } else {
    console.log(
      `SKIP  no checkout at ${real}: set PROGRAM_REPO to check the host credential against the real remote`,
    );
  }

  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
