import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendToCheckout } from './checkout-fs.js';
import {
  _resetHostRepoStateForTests,
  ensureHostRepo,
  expectedOriginUrl,
  exportEnvFor,
  exportMountsFor,
  exportPaths,
  EXPORT_CONTAINER_OBJECTS,
  EXPORT_CONTAINER_REPO,
  hostRepoPlacementProblem,
  isPlainGitUrl,
  probeUploadPackIsolation,
  setHostRepoAlerter,
  syncHostRepo,
  withoutHostOwnedGitPaths,
} from './host-repo.js';
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
  alerts = [];
  setHostRepoAlerter(async (text) => {
    alerts.push(text);
  });
});

afterEach(() => {
  kb.cleanup();
});

/** A host write, as audit-log.ts makes it. */
function hostWrite(line: string, file = 'discussions/audit-log/2026-01-05.md') {
  ensureHostRepo();
  appendToCheckout(kb.host, path.join(kb.host, file), `${line}\n`);
}

describe('host repo: creation', () => {
  it('is created without the checkout, adopts the origin branch on the first sync, and keeps entries written before that', async () => {
    kb.personCommit('discussions/audit-log/2026-01-05.md', 'earlier entry\n');
    hostWrite('written before the first fetch');
    const result = await syncHostRepo({ count: 1, fetchOrigin: true });
    expect(result.failed).toBeUndefined();
    expect(result.pushed).toBe(true);
    expect(kb.originFile('discussions/audit-log/2026-01-05.md')).toBe(
      'earlier entry\nwritten before the first fetch\n',
    );
  });

  it('seeds from the read mirror when there is one, with no network step', () => {
    git(kb.root, ['clone', '-q', '--mirror', kb.origin, kb.mirror]);
    vi.stubEnv('PROGRAM_ORIGIN_URL', '');
    ensureHostRepo();
    expect(git(kb.host, ['rev-parse', 'main']).trim()).toBe(
      git(kb.origin, ['rev-parse', 'main']).trim(),
    );
    // The origin then comes from the mirror's config, a host-owned file.
    expect(expectedOriginUrl().url).toBe(kb.origin);
  });

  it('only materializes the folders the host writes', async () => {
    await syncHostRepo({ fetchOrigin: true });
    expect(fs.existsSync(path.join(kb.host, 'README.md'))).toBe(false);
    expect(fs.existsSync(path.join(kb.host, 'program'))).toBe(false);
  });

  it('refuses a location inside the checkout, and the other way round', () => {
    vi.stubEnv('PROGRAM_HOST_REPO', path.join(kb.checkout, 'sub'));
    expect(hostRepoPlacementProblem()).toMatch(/must not contain/);
    expect(() => ensureHostRepo()).toThrow(/host repo refused/);
    vi.stubEnv('PROGRAM_HOST_REPO', kb.root);
    expect(hostRepoPlacementProblem()).toMatch(/must not contain/);
  });
});

describe('host repo: origin', () => {
  it('takes the origin from host settings only, and checks it against the pattern', () => {
    expect(expectedOriginUrl()).toEqual({ url: kb.origin });
    // The checkout says otherwise; it is not asked.
    git(kb.checkout, ['remote', 'set-url', 'origin', kb.decoy]);
    expect(expectedOriginUrl()).toEqual({ url: kb.origin });
    vi.stubEnv('PROGRAM_ORIGIN_URL', kb.decoy);
    expect(expectedOriginUrl().url).toBeNull();
    expect(expectedOriginUrl().problem).toMatch(/PROGRAM_ORIGIN_PATTERN/);
  });

  it('accepts only plain git URLs', () => {
    for (const ok of [
      'https://git.example.org/org/repo.git',
      'ssh://git@git.example.org/org/repo.git',
      'git@git.example.org:org/repo.git',
      '/srv/repos/x.git',
      'file:///srv/repos/x.git',
    ])
      expect(isPlainGitUrl(ok), ok).toBe(true);
    for (const bad of [
      '',
      '--upload-pack=/tmp/x',
      'ext::sh -c id',
      'fd::3',
      'https://a b',
      'relative/path',
    ])
      expect(isPlainGitUrl(bad), bad).toBe(false);
  });

  it('stops the sync and alerts when the configured origin is not the expected one', async () => {
    vi.stubEnv('PROGRAM_ORIGIN_URL', kb.decoy);
    hostWrite('entry');
    const result = await syncHostRepo({ count: 1 });
    expect(result.failed).toMatch(/origin/);
    expect(result.pushed).toBe(false);
    expect(kb.decoyRefs()).toBe('');
    expect(alerts).toHaveLength(1);
  });
});

describe('host repo: the existing behaviour', () => {
  it('commits and pushes audit entries as the bot', async () => {
    await syncHostRepo({ fetchOrigin: true });
    hostWrite('one');
    hostWrite('two', 'discussions/kb-triage/2026-01-05.md');
    const result = await syncHostRepo({ count: 2 });
    expect(result).toMatchObject({ committed: true, pushed: true });
    expect(kb.originLog('%s|%ae|%ce')[0]).toBe(
      'Audit log: 2 entries|program-bot@example.org|program-bot@example.org',
    );
    expect(kb.originFile('discussions/kb-triage/2026-01-05.md')).toBe('two\n');
  });

  it('pushes an agent commit to the origin', async () => {
    await syncHostRepo({ fetchOrigin: true });
    const sha = kb.agentCommit('notes/a.md', 'from the agent\n');
    const result = await syncHostRepo();
    expect(result).toMatchObject({ imported: 1, pushed: true });
    expect(git(kb.origin, ['rev-parse', 'main']).trim()).toBe(sha);
    expect(kb.originLog('%ae')[0]).toBe('agent@example.org');
  });

  it('does nothing when there is nothing to push', async () => {
    await syncHostRepo({ fetchOrigin: true });
    const before = kb.originLog('%H');
    expect(await syncHostRepo()).toEqual({
      committed: false,
      imported: 0,
      pushed: false,
    });
    expect(kb.originLog('%H')).toEqual(before);
  });

  it('on a rejected push, rebases on the origin and pushes again', async () => {
    await syncHostRepo({ fetchOrigin: true });
    kb.personCommit('notes/person.md', 'a person pushed first\n');
    kb.agentCommit('notes/agent.md', 'agent\n');
    hostWrite('entry');
    // No fetch first: the push is rejected, then rebased and retried.
    const result = await syncHostRepo({ count: 1 });
    expect(result).toMatchObject({
      committed: true,
      imported: 1,
      pushed: true,
    });
    expect(result.failed).toBeUndefined();
    expect(kb.originLog('%s').slice(0, 3).sort()).toEqual([
      'Audit log: 1 entries',
      'agent: notes/agent.md',
      'person: notes/person.md',
    ]);
    // Linear history: nothing the person pushed was rewritten.
    expect(git(kb.origin, ['rev-list', '--merges', 'main'])).toBe('');
    expect(kb.originLog('%s|%ae')).toContain(
      'agent: notes/agent.md|agent@example.org',
    );
  });

  it('replays agent commits made on an older base, once', async () => {
    await syncHostRepo({ fetchOrigin: true });
    kb.agentCommit('notes/agent.md', 'agent\n');
    hostWrite('entry');
    kb.personCommit('notes/person.md', 'person\n');
    expect(await syncHostRepo({ count: 1, fetchOrigin: true })).toMatchObject({
      imported: 1,
      pushed: true,
    });
    const after = kb.originLog('%H');
    // The checkout still holds the commit in its old form. Another sync
    // must not push it a second time.
    const again = await syncHostRepo({ fetchOrigin: true });
    expect(again.pushed).toBe(false);
    expect(again.refused).toBeUndefined();
    expect(kb.originLog('%H')).toEqual(after);
  });

  it('alerts the operator once per stuck push, and recovers', async () => {
    await syncHostRepo({ fetchOrigin: true });
    const hook = path.join(kb.origin, 'hooks', 'pre-receive');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    kb.agentCommit('notes/a.md', 'a\n');
    expect((await syncHostRepo()).failed).toMatch(/^push/);
    expect((await syncHostRepo()).failed).toMatch(/^push/);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/Knowledge-base push failed/);
    fs.rmSync(hook);
    expect((await syncHostRepo()).pushed).toBe(true);
    expect(kb.originFile('notes/a.md')).toBe('a\n');
  });

  it('leaves a conflicting agent commit in the checkout, alerts, and still pushes its own', async () => {
    await syncHostRepo({ fetchOrigin: true });
    kb.personCommit('notes/x.md', 'person version\n');
    kb.agentCommit('notes/x.md', 'agent version\n');
    hostWrite('entry');
    const result = await syncHostRepo({ count: 1, fetchOrigin: true });
    expect(result.refused?.reason).toBe('rebase-conflict');
    expect(result.pushed).toBe(true);
    expect(kb.originFile('notes/x.md')).toBe('person version\n');
    expect(kb.originLog('%s')[0]).toBe('Audit log: 1 entries');
    expect(git(kb.host, ['status', '--porcelain'])).toBe('');
    expect(git(kb.host, ['symbolic-ref', 'HEAD']).trim()).toBe(
      'refs/heads/main',
    );
    expect(alerts).toHaveLength(1);
  });
});

describe('host repo: checks on agent commits', () => {
  it('refuses a commit that changes a protected file, whatever author it claims', async () => {
    await syncHostRepo({ fetchOrigin: true });
    const before = kb.originLog('%H');
    fs.writeFileSync(path.join(kb.checkout, 'program/curriculum.md'), 'x\n');
    git(kb.checkout, ['commit', '-q', '-am', 'forged'], {
      GIT_AUTHOR_EMAIL: 'avery@example.edu',
      GIT_COMMITTER_EMAIL: 'avery@example.edu',
    });
    const result = await syncHostRepo();
    expect(result.refused?.reason).toBe('protected-file');
    expect(result.refused?.detail).toContain('program/curriculum.md');
    expect(kb.originLog('%H')).toEqual(before);
    expect(alerts).toHaveLength(1);
    // Once per stuck tip, not once per sync.
    await syncHostRepo();
    expect(alerts).toHaveLength(1);
  });

  it('refuses a protected file changed inside a merge commit, and under another letter case', async () => {
    await syncHostRepo({ fetchOrigin: true });
    git(kb.checkout, ['checkout', '-q', '-b', 'side']);
    kb.agentCommit('notes/side.md', 's\n');
    git(kb.checkout, ['checkout', '-q', 'main']);
    kb.agentCommit('notes/main.md', 'm\n');
    git(kb.checkout, ['merge', '-q', '--no-commit', '--no-ff', 'side']);
    fs.writeFileSync(path.join(kb.checkout, 'program/curriculum.md'), 'evil\n');
    git(kb.checkout, ['add', '-A']);
    git(kb.checkout, ['commit', '-q', '-m', 'merge']);
    expect((await syncHostRepo()).refused?.reason).toBe('protected-file');

    git(kb.checkout, ['reset', '-q', '--hard', 'origin/main']);
    kb.agentCommit('program/EMAIL_ALLOWLIST.md', 'everyone\n');
    expect((await syncHostRepo()).refused?.detail).toContain(
      'program/EMAIL_ALLOWLIST.md',
    );
  });

  it("takes a clean merge of an admin's protected change that the host had not fetched yet", async () => {
    await syncHostRepo({ fetchOrigin: true });
    kb.agentCommit('notes/a.md', 'a\n');
    kb.personCommit('program/curriculum.md', 'v2 by the admin\n');
    // The container pulled by itself (it may hold its own credential).
    git(kb.checkout, [
      'pull',
      '-q',
      '--no-rebase',
      '--no-edit',
      'origin',
      'main',
    ]);
    const result = await syncHostRepo(); // no fetch asked for
    expect(result.refused).toBeUndefined();
    expect(result.pushed).toBe(true);
    expect(kb.originFile('program/curriculum.md')).toBe('v2 by the admin\n');
    expect(kb.originFile('notes/a.md')).toBe('a\n');
  });

  it('refuses a branch that shares no history with the host', async () => {
    await syncHostRepo({ fetchOrigin: true });
    const before = kb.originLog('%H');
    git(kb.checkout, ['checkout', '-q', '--orphan', 'other']);
    git(kb.checkout, ['commit', '-q', '--allow-empty', '-m', 'unrelated']);
    git(kb.checkout, ['branch', '-f', 'main', 'other']);
    const result = await syncHostRepo();
    expect(result.refused?.reason).toBe('unrelated-history');
    expect(kb.originLog('%H')).toEqual(before);
  });
});

describe('host repo: the export the container pulls from', () => {
  it('names the host branch tip and holds no config beyond the bare flag', async () => {
    await syncHostRepo({ fetchOrigin: true });
    kb.agentCommit('notes/a.md', 'a\n');
    await syncHostRepo();
    const { repo, objects } = exportPaths();
    const tip = git(kb.host, ['rev-parse', 'main']).trim();
    expect(
      fs.readFileSync(path.join(repo, 'refs/heads/main'), 'utf8').trim(),
    ).toBe(tip);
    expect(fs.readFileSync(path.join(repo, 'config'), 'utf8')).not.toMatch(
      /url|remote|helper/i,
    );
    expect(
      fs.readFileSync(path.join(repo, 'objects/info/alternates'), 'utf8'),
    ).toBe(`${EXPORT_CONTAINER_OBJECTS}\n`);
    expect(objects).toBe(path.join(kb.host, '.git', 'objects'));
    // The origin URL is in the host repo's config only, which is not exported.
    expect(
      fs.readFileSync(path.join(kb.host, '.git/config'), 'utf8'),
    ).toContain(kb.origin);
  });
});

describe('host repo: container mounts', () => {
  const checkoutMount = () => ({
    hostPath: kb.checkout,
    containerPath: '/workspace/extra/program-repo',
    readonly: false,
  });

  it('gives a container with the writable checkout the read-only export, and says where it is', async () => {
    await syncHostRepo({ fetchOrigin: true });
    const extra = exportMountsFor([checkoutMount()]);
    expect(extra).toEqual([
      {
        hostPath: exportPaths().repo,
        containerPath: EXPORT_CONTAINER_REPO,
        readonly: true,
      },
      {
        hostPath: path.join(kb.host, '.git', 'objects'),
        containerPath: EXPORT_CONTAINER_OBJECTS,
        readonly: true,
      },
    ]);
    expect(exportEnvFor([checkoutMount(), ...extra])).toEqual({
      KB_UPSTREAM_REPO: EXPORT_CONTAINER_REPO,
      KB_CHECKOUT: '/workspace/extra/program-repo',
    });
    // The host repo itself, with its config, is never among the mounts.
    expect(extra.map((m) => m.hostPath)).not.toContain(kb.host);
    expect(extra.map((m) => m.hostPath)).not.toContain(
      path.join(kb.host, '.git'),
    );
  });

  it('gives nothing to a container without the checkout, or with a read-only one', () => {
    expect(exportMountsFor([])).toEqual([]);
    expect(exportMountsFor([{ ...checkoutMount(), readonly: true }])).toEqual(
      [],
    );
    expect(exportEnvFor([checkoutMount()])).toEqual({});
  });

  it('refuses an extra mount that reaches the host repo, its export or the read mirror', async () => {
    await syncHostRepo({ fetchOrigin: true });
    const mount = (hostPath: string) => ({
      hostPath,
      containerPath: '/workspace/extra/x',
      readonly: true,
    });
    const kept = withoutHostOwnedGitPaths([
      checkoutMount(),
      mount(kb.host),
      mount(path.join(kb.host, '.git')),
      mount(exportPaths().repo),
      mount(kb.mirror),
      mount(kb.root), // a parent of all of them
    ]);
    expect(kept).toEqual([checkoutMount()]);
  });

  it('the export works as a fetch source once its two parts are in place', async () => {
    await syncHostRepo({ fetchOrigin: true });
    kb.agentCommit('notes/a.md', 'a\n');
    await syncHostRepo();
    // Put the two mounts together the way the container sees them.
    const seen = path.join(kb.root, 'seen.git');
    fs.cpSync(exportPaths().repo, seen, { recursive: true });
    fs.writeFileSync(
      path.join(seen, 'objects', 'info', 'alternates'),
      `${exportPaths().objects}\n`,
    );
    const clone = path.join(kb.root, 'clone');
    git(kb.root, ['clone', '-q', seen, clone]);
    expect(fs.readFileSync(path.join(clone, 'notes/a.md'), 'utf8')).toBe('a\n');
  });
});

describe('probeUploadPackIsolation', () => {
  it('finds that this git runs nothing a served repository names', () => {
    const probe = probeUploadPackIsolation();
    expect(probe.fired).toEqual([]);
    expect(probe.ok).toBe(true);
    expect(probe.gitVersion).toMatch(/^git version \d+\.\d+/);
  });
});
