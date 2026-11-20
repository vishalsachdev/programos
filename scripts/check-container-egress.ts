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
 *      the remote after the host takes it out and pushes it (src/host-repo.ts;
 *      a temporary checkout, host repository and local remote, so the real
 *      knowledge base is not touched).
 *
 * The host's credential against the real origin is checked by
 * `npx tsx scripts/check-host-git-trust.ts --network`.
 *
 * Exit code 0 only if every check passes.
 */
import { execFile, execFileSync } from 'child_process';
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
import { syncHostRepo } from '../src/host-repo.js';
import { CHECKOUT_OWNER } from '../src/program-repo.js';

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
  const saved = new Map<string, string | undefined>(
    [
      'PROGRAM_REPO',
      'PROGRAM_HOST_REPO',
      'PROGRAM_READ_MIRROR',
      'PROGRAM_ORIGIN_URL',
      'PROGRAM_ORIGIN_PATTERN',
    ].map((key) => [key, process.env[key]]),
  );
  try {
    const remote = path.join(tmp, 'remote.git');
    const checkout = path.join(tmp, 'checkout');
    // The host's git runs as the checkout owner when the host is root.
    if (process.getuid?.() === 0)
      execFileSync('chown', [
        `${CHECKOUT_OWNER.uid}:${CHECKOUT_OWNER.gid}`,
        tmp,
      ]);
    else fs.chmodSync(tmp, 0o755);
    // The temporary remote and checkout are made by git inside a container,
    // and read back the same way: this script starts no git on the host.
    // The folder is mounted at its own path, so the paths mean the same on
    // both sides.
    const setup = await inContainer(
      `cd ${tmp} && git init -q --bare -b main remote.git && ` +
        'git clone -q remote.git checkout 2>/dev/null && cd checkout && ' +
        'git checkout -q -b main && git config user.name check && ' +
        'git config user.email check@example.org && echo check > README.md && ' +
        'git add README.md && git commit -q -m start && git push -q -u origin main',
      ['-v', `${tmp}:${tmp}`, '-e', 'HOME=/tmp'],
    );
    if (setup.code !== 0)
      report(false, 'a temporary remote and checkout could be made', setup.out);

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

    // The host's own settings, pointed at the temporary repositories. The
    // host runs no git in the checkout: it fetches the commit out of it.
    Object.assign(process.env, {
      PROGRAM_REPO: checkout,
      PROGRAM_HOST_REPO: path.join(tmp, 'host'),
      PROGRAM_READ_MIRROR: path.join(tmp, 'mirror.git'),
      PROGRAM_ORIGIN_URL: remote,
      PROGRAM_ORIGIN_PATTERN: `^${remote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    });
    const outcome = await syncHostRepo();
    const onRemote = (
      await inContainer(`git --git-dir ${remote} show main:from-container.md`, [
        '-v',
        `${tmp}:${tmp}:ro`,
        '-e',
        'HOME=/tmp',
      ])
    ).out;
    report(
      outcome.pushed &&
        outcome.imported >= 1 &&
        onRemote === 'written in the container',
      'the host took the container commit out of the checkout and pushed it to the remote',
      outcome.pushed
        ? ''
        : `sync outcome: ${JSON.stringify({ ...outcome })}`.slice(0, 300),
    );
  } finally {
    for (const key of saved.keys()) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(
    'NOTE  the host credential against the real origin: run npx tsx scripts/check-host-git-trust.ts --network',
  );
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
