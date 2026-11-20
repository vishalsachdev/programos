/**
 * Adversarial suite: nothing the agent can write in its checkout is run or
 * obeyed by host git.
 *
 * Each case plants one thing the container could plant (it can write the
 * whole checkout, .git included), then runs every host operation: the sync
 * before a turn, the audit commit, the sync after a turn, the read mirror's
 * refresh, and the check that reads the checkout's origin. Then:
 *
 *   - the canary file does not exist (a planted program would create it);
 *   - the decoy remote received nothing;
 *   - where the case allows it, the well-behaved result still holds: the
 *     agent's commit and the audit entry are on the expected origin.
 *
 * The canaries are inert shell scripts that append their arguments to a
 * file in the test's temp folder.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./behaviour-sensor.js', () => ({
  makeSensorId: () => 'sensor-test',
  placeholderFor: () => '[sensor: pending:sensor-test]',
  runBehaviourSensor: vi.fn(async () => undefined),
}));

import {
  _setPendingWritesForTests,
  flushAuditLog,
  logDroppedEmail,
  syncKnowledgeBase,
} from './audit-log.js';
import {
  _resetHostRepoStateForTests,
  setHostRepoAlerter,
  type SyncResult,
} from './host-repo.js';
import { realProgramRepoReason, RepoReader } from './repo-reader.js';
import {
  git,
  makeKbFixture,
  type KbFixture,
} from './test-support/kb-fixture.js';

let kb: KbFixture;
let alerts: string[];

beforeEach(() => {
  _resetHostRepoStateForTests();
  kb = makeKbFixture();
  git(kb.root, ['clone', '-q', '--mirror', kb.origin, kb.mirror]);
  alerts = [];
  setHostRepoAlerter(async (text) => {
    alerts.push(text);
  });
});

afterEach(async () => {
  await flushAuditLog();
  _setPendingWritesForTests(0);
  kb.cleanup();
});

/** Append raw text to the checkout's .git/config, as the container can. */
function plantConfig(text: string): void {
  fs.appendFileSync(path.join(kb.checkout, '.git', 'config'), `\n${text}\n`);
}

/** Replace the checkout's origin address (a plain config edit). */
function setOriginUrl(url: string): void {
  const file = path.join(kb.checkout, '.git', 'config');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace(/^(\s*url\s*=).*$/m, (_, key) => `${key} ${url}`),
  );
}

const ALL_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'post-index-change',
  'pre-upload-pack',
  'post-upload-pack',
];

function plantHooks(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const hook of ALL_HOOKS)
    fs.copyFileSync(kb.canaryScript, path.join(dir, hook));
}

interface Ran {
  before: SyncResult;
  after: SyncResult;
}

/** Every host operation that used to touch the checkout, or still reads it. */
async function runHostOperations(): Promise<Ran> {
  const before = await syncKnowledgeBase({ fetchOrigin: true });
  logDroppedEmail('stranger@example.org', 'hello');
  await flushAuditLog();
  const after = await syncKnowledgeBase();
  const reader = new RepoReader(kb.mirror);
  reader.init();
  reader.refresh({ force: true });
  realProgramRepoReason();
  return { before, after };
}

function expectNothingRan(): void {
  expect(kb.canaryLines()).toEqual([]);
  expect(kb.decoyRefs()).toBe('');
}

function expectNormalResult(): void {
  const subjects = kb.originLog('%s');
  expect(subjects).toContain('agent: notes/agent.md');
  expect(subjects).toContain('Audit log: 1 entries');
}

interface Case {
  name: string;
  /** Runs after the agent's ordinary commit exists. */
  plant: () => void;
  /** false: the plant itself breaks the checkout; only "nothing ran" holds. */
  delivers?: boolean;
  /** A command in the checkout that proves the plant is live (fires). */
  armedBy?: () => void;
}

const inCheckout = (args: string[]) => () => {
  try {
    git(kb.checkout, args);
  } catch {
    /* the planted program may make the command fail; it still ran */
  }
};

const cases: Case[] = [
  {
    name: 'every hook in .git/hooks',
    plant: () => plantHooks(path.join(kb.checkout, '.git', 'hooks')),
    armedBy: inCheckout(['commit', '-q', '--allow-empty', '-m', 'x']),
  },
  {
    name: 'core.hooksPath pointing at a folder of hooks',
    plant: () => {
      plantHooks(path.join(kb.checkout, '.hooks'));
      plantConfig(`[core]\n\thooksPath = ${kb.checkout}/.hooks`);
    },
    armedBy: inCheckout(['commit', '-q', '--allow-empty', '-m', 'x']),
  },
  {
    name: 'core.fsmonitor',
    plant: () => plantConfig(`[core]\n\tfsmonitor = ${kb.canaryScript}`),
    armedBy: inCheckout(['status']),
  },
  {
    name: 'core.sshCommand, with the remote turned into an ssh address',
    plant: () => {
      setOriginUrl('ssh://git@decoy.invalid/x.git');
      plantConfig(`[core]\n\tsshCommand = ${kb.canaryScript}`);
    },
    armedBy: inCheckout(['fetch', 'origin']),
  },
  {
    name: 'credential.helper and core.askPass',
    plant: () =>
      plantConfig(
        `[credential]\n\thelper = !${kb.canaryScript}\n` +
          `[core]\n\taskPass = ${kb.canaryScript}`,
      ),
  },
  {
    name: 'url.insteadOf, pushInsteadOf, pushurl and a second remote as the push default',
    plant: () =>
      plantConfig(
        `[url "${kb.decoy}"]\n\tinsteadOf = ${kb.origin}\n\tpushInsteadOf = ${kb.origin}\n` +
          `[remote "origin"]\n\tpushurl = ${kb.decoy}\n` +
          `[remote "evil"]\n\turl = ${kb.decoy}\n\tfetch = +refs/heads/*:refs/remotes/evil/*\n` +
          `[remote]\n\tpushDefault = evil\n` +
          `[branch "main"]\n\tpushRemote = evil`,
      ),
    armedBy: () => {
      inCheckout(['push', '-q', 'origin', 'main'])();
      // Armed means the decoy got the branch; undo it for the real check.
      expect(kb.decoyRefs()).not.toBe('');
      fs.rmSync(path.join(kb.decoy, 'refs', 'heads', 'main'));
      fs.writeFileSync(kb.canary, 'armed\n');
    },
  },
  {
    name: 'remote.origin.url replaced by the decoy',
    plant: () => git(kb.checkout, ['remote', 'set-url', 'origin', kb.decoy]),
  },
  {
    name: 'filter, diff, textconv and merge drivers through .gitattributes, with a real merge on the host',
    plant: () => {
      fs.writeFileSync(
        path.join(kb.checkout, '.gitattributes'),
        '* filter=evil diff=evil merge=evil\n',
      );
      git(kb.checkout, ['add', '.gitattributes']);
      git(kb.checkout, ['commit', '-q', '-m', 'agent: attributes']);
      // The host must now replay the agent's commits on a moved origin.
      kb.personCommit('README.md', 'kb\nchanged by a person\n');
      plantConfig(
        `[filter "evil"]\n\tclean = ${kb.canaryScript}\n\tsmudge = ${kb.canaryScript}\n\tprocess = ${kb.canaryScript}\n\trequired = true\n` +
          `[diff "evil"]\n\ttextconv = ${kb.canaryScript}\n\tcommand = ${kb.canaryScript}\n` +
          `[diff]\n\texternal = ${kb.canaryScript}\n` +
          `[merge "evil"]\n\tdriver = ${kb.canaryScript} %O %A %B\n` +
          `[merge]\n\ttool = evil\n[mergetool "evil"]\n\tcmd = ${kb.canaryScript}`,
      );
    },
    armedBy: inCheckout(['diff', 'HEAD~1']),
  },
  {
    name: 'aliases',
    plant: () =>
      plantConfig(
        `[alias]\n` +
          ['fetch', 'push', 'commit', 'rebase', 'upload-pack', 'status', 'x']
            .map((a) => `\t${a} = !${kb.canaryScript}`)
            .join('\n'),
      ),
    armedBy: inCheckout(['x']),
  },
  {
    name: 'core.pager, core.editor, sequence.editor and gpg.program with signing on',
    plant: () =>
      plantConfig(
        `[core]\n\tpager = ${kb.canaryScript}\n\teditor = ${kb.canaryScript}\n` +
          `[sequence]\n\teditor = ${kb.canaryScript}\n` +
          `[gpg]\n\tprogram = ${kb.canaryScript}\n[gpg "ssh"]\n\tprogram = ${kb.canaryScript}\n` +
          `[commit]\n\tgpgSign = true\n[tag]\n\tgpgSign = true\n[push]\n\tgpgSign = if-asked\n` +
          `[pager]\n\tlog = ${kb.canaryScript}\n[interactive]\n\tdiffFilter = ${kb.canaryScript}`,
      ),
    armedBy: inCheckout(['commit', '-q', '--allow-empty', '-m', 'x']),
  },
  {
    name: 'include.path and includeIf pulling in another config file',
    plant: () => {
      const extra = path.join(kb.checkout, '.extra-config');
      fs.writeFileSync(
        extra,
        `[core]\n\tfsmonitor = ${kb.canaryScript}\n\thooksPath = ${kb.checkout}/.hooks\n`,
      );
      plantHooks(path.join(kb.checkout, '.hooks'));
      plantConfig(
        `[include]\n\tpath = ${extra}\n[includeIf "gitdir:**"]\n\tpath = ${extra}`,
      );
    },
    armedBy: inCheckout(['status']),
  },
  {
    name: 'core.gitProxy, http.proxy, http.extraHeader and http.cookieFile',
    plant: () =>
      plantConfig(
        `[core]\n\tgitProxy = ${kb.canaryScript}\n` +
          `[http]\n\tproxy = http://127.0.0.1:9\n\textraHeader = X-Leak: 1\n\tcookieFile = ${kb.canary}\n\tsaveCookies = true\n` +
          `[remote "origin"]\n\tproxy = http://127.0.0.1:9`,
      ),
  },
  {
    name: 'a submodule with an ext:: address, with recursion switched on',
    plant: () => {
      fs.writeFileSync(
        path.join(kb.checkout, '.gitmodules'),
        `[submodule "sub"]\n\tpath = sub\n\turl = ${kb.decoy}\n`,
      );
      git(kb.checkout, ['add', '.gitmodules']);
      git(kb.checkout, [
        'update-index',
        '--add',
        '--cacheinfo',
        `160000,${git(kb.checkout, ['rev-parse', 'HEAD']).trim()},sub`,
      ]);
      git(kb.checkout, ['commit', '-q', '-m', 'agent: submodule']);
      plantConfig(
        `[submodule]\n\trecurse = true\n[fetch]\n\trecurseSubmodules = true\n` +
          `[push]\n\trecurseSubmodules = on-demand\n[protocol "ext"]\n\tallow = always\n` +
          `[submodule "sub"]\n\turl = ext::${kb.canaryScript} sub\n\tupdate = !${kb.canaryScript}`,
      );
    },
  },
  {
    name: 'uploadpack.packObjectsHook, core.alternateRefsCommand and an ext:: remote',
    plant: () => {
      setOriginUrl(`ext::${kb.canaryScript} origin`);
      plantConfig(
        `[uploadpack]\n\tpackObjectsHook = ${kb.canaryScript}\n` +
          `[core]\n\talternateRefsCommand = ${kb.canaryScript}\n` +
          `[protocol "ext"]\n\tallow = always`,
      );
    },
    armedBy: inCheckout(['fetch', 'origin']),
  },
  {
    name: 'a promisor remote behind an ext:: address',
    delivers: false,
    plant: () => {
      setOriginUrl(`ext::${kb.canaryScript} lazy`);
      plantConfig(
        `[core]\n\trepositoryformatversion = 1\n[extensions]\n\tpartialClone = origin\n` +
          `[protocol "ext"]\n\tallow = always\n` +
          `[remote "origin"]\n\tpromisor = true\n\tpartialclonefilter = blob:none`,
      );
    },
  },
  {
    name: 'refs, tags and HEAD named like command-line options',
    plant: () => {
      const sha = git(kb.checkout, ['rev-parse', 'HEAD']);
      const heads = path.join(kb.checkout, '.git', 'refs', 'heads');
      const tags = path.join(kb.checkout, '.git', 'refs', 'tags');
      fs.mkdirSync(tags, { recursive: true });
      for (const name of [
        `--upload-pack=${path.basename(kb.canaryScript)}`,
        `--output=canary`,
        `-ocanary`,
        `--exec=canary`,
      ]) {
        fs.writeFileSync(path.join(heads, name), sha);
        fs.writeFileSync(path.join(tags, name), sha);
      }
      fs.appendFileSync(
        path.join(kb.checkout, '.git', 'packed-refs'),
        `${sha.trim()} refs/heads/--receive-pack=${kb.canaryScript}\n`,
      );
    },
  },
];

describe('host git obeys nothing in the agent checkout', () => {
  for (const c of cases) {
    it(c.name, async () => {
      kb.agentCommit('notes/agent.md', 'from the agent\n');
      c.plant();
      const ran = await runHostOperations();
      expectNothingRan();
      if (c.delivers !== false) {
        expect(ran.after.refused).toBeUndefined();
        expectNormalResult();
      }
    });

    if (c.armedBy)
      it(`${c.name} (the plant is live: git run in the checkout does fire it)`, () => {
        kb.agentCommit('notes/agent.md', 'from the agent\n');
        c.plant();
        c.armedBy!();
        expect(kb.canaryLines().length).toBeGreaterThan(0);
      });
  }
});

describe('the checkout .git replaced or redirected', () => {
  /** Another repository on the host, with content that must not leak. */
  function otherRepo(): string {
    const other = path.join(kb.root, 'other');
    git(kb.root, ['init', '-q', '--template=', other]);
    git(other, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    fs.writeFileSync(path.join(other, 'private.txt'), 'not for the origin\n');
    git(other, ['add', '-A']);
    git(other, ['commit', '-q', '-m', 'other repo']);
    plantHooks(path.join(other, '.git', 'hooks'));
    return other;
  }

  async function expectNothingTaken(reason: string): Promise<void> {
    const ran = await runHostOperations();
    expectNothingRan();
    expect(ran.after.refused?.reason).toBe(reason);
    expect(kb.originFile('private.txt')).toBeNull();
    expect(kb.originLog('%s')).not.toContain('other repo');
    // The host's own work goes on.
    expect(kb.originLog('%s')).toContain('Audit log: 1 entries');
    expect(alerts.length).toBeGreaterThan(0);
  }

  it('.git is a file that points at another repository', async () => {
    const other = otherRepo();
    fs.renameSync(
      path.join(kb.checkout, '.git'),
      path.join(kb.root, 'real-git'),
    );
    fs.writeFileSync(path.join(kb.checkout, '.git'), `gitdir: ${other}/.git\n`);
    await expectNothingTaken('not-a-plain-checkout');
  });

  it('.git is a link to another repository', async () => {
    const other = otherRepo();
    fs.renameSync(
      path.join(kb.checkout, '.git'),
      path.join(kb.root, 'real-git'),
    );
    fs.symlinkSync(path.join(other, '.git'), path.join(kb.checkout, '.git'));
    await expectNothingTaken('not-a-plain-checkout');
  });

  it("the branch and the object store are redirected to another repository's", async () => {
    const other = otherRepo();
    const dotGit = path.join(kb.checkout, '.git');
    fs.mkdirSync(path.join(dotGit, 'objects', 'info'), { recursive: true });
    fs.writeFileSync(
      path.join(dotGit, 'objects', 'info', 'alternates'),
      `${other}/.git/objects\n`,
    );
    fs.rmSync(path.join(dotGit, 'refs', 'heads', 'main'), { force: true });
    fs.rmSync(path.join(dotGit, 'packed-refs'), { force: true });
    fs.symlinkSync(
      path.join(other, '.git', 'refs', 'heads', 'main'),
      path.join(dotGit, 'refs', 'heads', 'main'),
    );
    await expectNothingTaken('unrelated-history');
  });

  it('.git/hooks and .git/config are links to planted files elsewhere', async () => {
    kb.agentCommit('notes/agent.md', 'from the agent\n');
    const dotGit = path.join(kb.checkout, '.git');
    const elsewhere = path.join(kb.root, 'elsewhere');
    plantHooks(path.join(elsewhere, 'hooks'));
    fs.rmSync(path.join(dotGit, 'hooks'), { recursive: true, force: true });
    fs.symlinkSync(path.join(elsewhere, 'hooks'), path.join(dotGit, 'hooks'));
    fs.writeFileSync(
      path.join(elsewhere, 'config'),
      fs.readFileSync(path.join(dotGit, 'config'), 'utf8') +
        `\n[core]\n\tfsmonitor = ${kb.canaryScript}\n\tsshCommand = ${kb.canaryScript}\n` +
        `[remote "origin"]\n\tpushurl = ${kb.decoy}\n`,
    );
    fs.rmSync(path.join(dotGit, 'config'));
    fs.symlinkSync(path.join(elsewhere, 'config'), path.join(dotGit, 'config'));
    const ran = await runHostOperations();
    expectNothingRan();
    expect(ran.after.refused).toBeUndefined();
    expectNormalResult();
    // The checkout's config is read as a file and a link is not followed:
    // the planted origin is not even seen as a hint.
    vi.stubEnv('PROGRAM_ORIGIN_PATTERN', '');
    vi.stubEnv('PROGRAM_ORIGIN_URL', '');
    vi.stubEnv('PROGRAM_READ_MIRROR', path.join(kb.root, 'no-mirror'));
    expect(realProgramRepoReason()).toBeNull();
  });
});

describe('the working tree', () => {
  /** The dates an audit entry written now can carry, in any time zone. */
  function nearDates(): string[] {
    return [-1, 0, 1].map((d) =>
      new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10),
    );
  }

  it('a link planted where the host used to write the audit log is not written through', async () => {
    const outside = path.join(kb.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(kb.checkout, 'discussions', 'audit-log'));
    await runHostOperations();
    expectNothingRan();
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(kb.originLog('%s')).toContain('Audit log: 1 entries');
  });

  it('a commit that turns an audit file into a link is refused, and nothing is written through it', async () => {
    const outside = path.join(kb.root, 'outside');
    fs.mkdirSync(outside);
    const dir = path.join(kb.checkout, 'discussions', 'audit-log');
    fs.mkdirSync(dir, { recursive: true });
    for (const date of nearDates())
      fs.symlinkSync(
        path.join(outside, `${date}.md`),
        path.join(dir, `${date}.md`),
      );
    git(kb.checkout, ['add', '-A']);
    git(kb.checkout, ['commit', '-q', '-m', 'agent: links']);
    const ran = await runHostOperations();
    expectNothingRan();
    expect(ran.after.refused?.reason).toBe('host-folder-entry');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(kb.originLog('%s')).not.toContain('agent: links');
    expect(kb.originLog('%s')).toContain('Audit log: 1 entries');
  });

  it('a commit that replaces a host-written folder by a link is refused', async () => {
    const outside = path.join(kb.root, 'outside');
    fs.mkdirSync(outside);
    git(kb.checkout, ['rm', '-q', '-r', 'discussions/kb-triage']);
    fs.mkdirSync(path.join(kb.checkout, 'discussions'), { recursive: true });
    fs.symlinkSync(outside, path.join(kb.checkout, 'discussions', 'kb-triage'));
    git(kb.checkout, ['add', '-A']);
    git(kb.checkout, ['commit', '-q', '-m', 'agent: folder link']);
    const ran = await runHostOperations();
    expectNothingRan();
    expect(ran.after.refused?.reason).toBe('host-folder-entry');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('a link that reaches the host repo from the origin is checked out as a plain file, never as a link', async () => {
    // Pushed by someone with write access to the origin, so no check on the
    // agent's commits sees it.
    const outside = path.join(kb.root, 'outside');
    fs.mkdirSync(outside);
    const person = path.join(kb.root, 'person');
    kb.personCommit('notes/p.md', 'p\n');
    const dir = path.join(person, 'discussions', 'audit-log');
    fs.mkdirSync(dir, { recursive: true });
    for (const date of nearDates())
      fs.symlinkSync(
        path.join(outside, `${date}.md`),
        path.join(dir, `${date}.md`),
      );
    git(person, ['add', '-A']);
    git(person, ['commit', '-q', '-m', 'person: links']);
    git(person, ['push', '-q', 'origin', 'main']);
    await runHostOperations();
    expectNothingRan();
    expect(fs.readdirSync(outside)).toEqual([]);
    for (const name of fs.readdirSync(
      path.join(kb.host, 'discussions', 'audit-log'),
    ))
      expect(
        fs
          .lstatSync(path.join(kb.host, 'discussions', 'audit-log', name))
          .isSymbolicLink(),
      ).toBe(false);
  });
});
