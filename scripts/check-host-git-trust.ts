/**
 * First-start check for the host-owned repository (src/host-repo.ts).
 *
 *   npx tsx scripts/check-host-git-trust.ts            local checks only
 *   npx tsx scripts/check-host-git-trust.ts --network  also asks the origin
 *                                                       (a fetch and a push
 *                                                       with --dry-run)
 *
 * Run it as the user the bot runs as, with the bot's environment (the PART 2
 * settings of config/instance.env.example). It changes nothing in the agent's
 * checkout. It creates the host repo if it is missing, as the bot would at
 * its first start. Exit code 1 when a line says FAIL.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ensureHostRepo,
  expectedOriginUrl,
  exportPaths,
  getHostRepoPath,
  hostGitOptions,
  hostRepoPlacementProblem,
  HOST_WRITTEN_DIRS,
  KB_BRANCH,
  probeUploadPackIsolation,
} from '../src/host-repo.js';
import { getProgramRepoPath } from '../src/program-repo.js';

let failed = false;
function line(state: 'PASS' | 'FAIL' | 'NOTE', text: string): void {
  if (state === 'FAIL') failed = true;
  console.log(`${state}  ${text}`);
}

function hostGit(args: string[], credentialed = false): string {
  return execFileSync('git', args, {
    ...hostGitOptions({ credentialed }),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The origin address without a password or token. */
function redact(url: string): string {
  return url.replace(/\/\/[^/@]*@/, '//***@');
}

const network = process.argv.includes('--network');
const checkout = getProgramRepoPath();
const host = getHostRepoPath();
console.log(`checkout (agent-writable): ${checkout}`);
console.log(`host repo (host-owned):    ${host}`);

// 1. git on this host must not run what a served repository names.
const probe = probeUploadPackIsolation();
if (probe.ok)
  line(
    'PASS',
    `${probe.gitVersion}: a fetch out of a hostile repository ran nothing`,
  );
else
  line(
    'FAIL',
    `${probe.gitVersion} ran ${probe.fired.join(', ')} while serving a repository. ` +
      `Upgrade git; until then the host takes no commits from the agent checkout.`,
  );

// 2. Placement.
const placement = hostRepoPlacementProblem();
if (placement) line('FAIL', placement);
else line('PASS', 'the host repo is outside the agent checkout');

// 3. The origin comes from host settings.
const origin = expectedOriginUrl();
if (origin.problem) line('FAIL', origin.problem);
else if (!origin.url)
  line(
    'FAIL',
    'no origin: set PROGRAM_ORIGIN_URL, or create the read mirror (its origin is used)',
  );
else line('PASS', `origin from host settings: ${redact(origin.url)}`);

// 4. The host repo.
let hostReady = false;
if (!placement) {
  try {
    ensureHostRepo();
    hostReady = fs.existsSync(path.join(host, '.git', 'HEAD'));
    if (hostReady) line('PASS', 'the host repo exists');
    else line('FAIL', 'the host repo could not be created');
  } catch (err) {
    line(
      'FAIL',
      `the host repo could not be created: ${(err as Error).message}`,
    );
  }
}
if (hostReady) {
  let tip = '';
  try {
    tip = hostGit([
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${KB_BRANCH}`,
    ]);
  } catch {
    /* no commit yet */
  }
  if (tip) line('PASS', `host branch ${KB_BRANCH} is at ${tip.slice(0, 12)}`);
  else
    line(
      'NOTE',
      `the host repo has no commit yet; it takes the origin's history at the first sync`,
    );
  const exported = path.join(exportPaths().repo, 'refs', 'heads', KB_BRANCH);
  if (tip && fs.existsSync(exported))
    line(
      fs.readFileSync(exported, 'utf8').trim() === tip ? 'PASS' : 'NOTE',
      'the export for the container names the host branch tip (refreshed at each sync)',
    );
}

// 5. The checkout, read as files only.
let dotGit: fs.Stats | null = null;
try {
  dotGit = fs.lstatSync(path.join(checkout, '.git'));
} catch {
  /* missing */
}
if (!dotGit) line('NOTE', 'no checkout at PROGRAM_REPO');
else if (!dotGit.isDirectory() || dotGit.isSymbolicLink())
  line(
    'FAIL',
    'the .git of the checkout is a file or a link; the host takes nothing from it',
  );
else line('PASS', 'the .git of the checkout is a plain folder');

// Audit entries written before the upgrade and never committed stay in the
// checkout. Compare as files; no git runs there.
if (dotGit && hostReady) {
  const leftovers: string[] = [];
  for (const dir of HOST_WRITTEN_DIRS) {
    const inCheckout = path.join(checkout, dir);
    let names: string[] = [];
    try {
      if (fs.lstatSync(inCheckout).isDirectory())
        names = fs.readdirSync(inCheckout);
    } catch {
      /* missing */
    }
    for (const name of names) {
      const a = path.join(inCheckout, name);
      const b = path.join(host, dir, name);
      const st = fs.lstatSync(a);
      if (!st.isFile()) continue;
      const mine = fs.readFileSync(a);
      if (!fs.existsSync(b) || !fs.readFileSync(b).includes(mine))
        leftovers.push(path.join(dir, name));
    }
  }
  if (leftovers.length)
    line(
      'NOTE',
      `${leftovers.length} file(s) in the checkout differ from the host repo's copy ` +
        `(${leftovers.slice(0, 5).join(', ')}${leftovers.length > 5 ? ', ...' : ''}). ` +
        `If they hold audit entries from before the upgrade that were never pushed, ` +
        `append them by hand to the same file in the host repo. Otherwise the ` +
        `agent's next pull brings the checkout up to date.`,
    );
  else line('PASS', 'no host-written file is ahead in the checkout');
}

// 6. Optional: the credential.
if (network && hostReady && origin.url) {
  try {
    hostGit(['ls-remote', '--heads', '--', origin.url, KB_BRANCH], true);
    line('PASS', 'the host credential reads the origin');
  } catch (err) {
    line(
      'FAIL',
      `the host credential cannot read the origin: ${String(
        (err as { stderr?: string }).stderr || err,
      )
        .trim()
        .slice(0, 200)}`,
    );
  }
  try {
    hostGit(
      [
        'push',
        '--dry-run',
        '--no-verify',
        '--',
        origin.url,
        `refs/heads/${KB_BRANCH}:refs/heads/${KB_BRANCH}`,
      ],
      true,
    );
    line('PASS', 'the host credential can push to the origin (dry run)');
  } catch (err) {
    line(
      'NOTE',
      `push --dry-run did not succeed: ${String(
        (err as { stderr?: string }).stderr || err,
      )
        .trim()
        .slice(0, 200)}`,
    );
  }
} else if (!network) {
  line(
    'NOTE',
    'the origin was not contacted; add --network to check the credential',
  );
}

process.exit(failed ? 1 : 0);
