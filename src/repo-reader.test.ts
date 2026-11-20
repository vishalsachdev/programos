import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from './logger.js';
import { RepoReader } from './repo-reader.js';

// Disable commit signing so the test is hermetic and never depends on the
// host's global git config (e.g. CI environments that force SSH signing).
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf-8',
    },
  );
}

describe('RepoReader', () => {
  let dir: string;
  let upstream: string; // simulated "github" repo
  let mirror: string; // the bare read mirror

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-reader-'));
    upstream = path.join(dir, 'upstream');
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-b', 'main');
    git(upstream, 'config', 'user.email', 'avery.personal@gmail.com');
    git(upstream, 'config', 'user.name', 'Avery Morgan');
    fs.mkdirSync(path.join(upstream, 'program'), { recursive: true });
    fs.writeFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Avery | avery@example.edu |\n',
    );
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', 'init');
    mirror = path.join(dir, 'mirror.git');
    execFileSync('git', ['clone', '--mirror', upstream, mirror]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reads a file at the pinned SHA after init', () => {
    const r = new RepoReader(mirror);
    expect(r.init()).toBe(true);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
  });

  // Catches losing the pinned revision or fail-closed behavior in async inbound evidence reads.
  it('reads pinned content asynchronously and returns null for unavailable files', async () => {
    const r = new RepoReader(mirror);
    expect(await r.readFileAsync('program/EMAIL_ALLOWLIST.md')).toBeNull();
    r.init();
    expect(await r.readFileAsync('program/EMAIL_ALLOWLIST.md')).toBe(
      '| Avery | avery@example.edu |\n',
    );
    expect(await r.readFileAsync('missing.md')).toBeNull();
    fs.writeFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Someone | other@example.org |\n',
    );
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', 'advance upstream without refreshing reader');
    expect(await r.readFileAsync('program/EMAIL_ALLOWLIST.md')).toBe(
      '| Avery | avery@example.edu |\n',
    );
  });

  // R1-3: catches serving agent edits after an email's intake commit while its webhook was delayed.
  it('reads the received eml at its original Worker commit after the mirror advances to an agent edit', async () => {
    const relPath = 'discussions/raw/received.eml';
    fs.mkdirSync(path.join(upstream, 'discussions/raw'), { recursive: true });
    fs.writeFileSync(
      path.join(upstream, relPath),
      'From: person@example.org\n\nContact true-inbound@example.org',
    );
    git(upstream, 'add', '-A');
    git(
      upstream,
      '-c',
      'user.email=email-inbox@example.org',
      'commit',
      '-m',
      'Worker receives email',
    );
    fs.appendFileSync(
      path.join(upstream, relPath),
      '\nAgent appends invented@example.org',
    );
    git(upstream, 'add', '-A');
    git(
      upstream,
      'commit',
      '-m',
      'Agent edits raw file before webhook delivery',
    );
    const r = new RepoReader(mirror);
    r.init();
    r.refresh({ force: true });
    expect(await r.readFileAtCreationAsync(relPath)).toBe(
      'From: person@example.org\n\nContact true-inbound@example.org',
    );
    expect(
      await r.readFileAtCreationAsync('program/EMAIL_ALLOWLIST.md'),
    ).toBeNull();
  });

  it('accepts an original eml only from the configured intake git author', async () => {
    const commitEml = (name: string, author: string) => {
      fs.mkdirSync(path.join(upstream, 'discussions/raw'), { recursive: true });
      fs.writeFileSync(
        path.join(upstream, 'discussions/raw', name),
        `From: ${name}\n`,
      );
      git(upstream, 'add', '-A');
      git(upstream, '-c', `user.email=${author}`, 'commit', '-m', name);
    };
    commitEml('configured.eml', 'intake@mail.test');
    commitEml('placeholder.eml', 'email-inbox@example.org');

    vi.stubEnv('INTAKE_GIT_AUTHOR_EMAIL', 'intake@mail.test');
    vi.resetModules();
    const fresh = await import('./repo-reader.js');
    const r = new fresh.RepoReader(mirror);
    r.init();
    r.refresh({ force: true });
    expect(
      await r.readFileAtCreationAsync('discussions/raw/configured.eml'),
    ).toBe('From: configured.eml\n');
    expect(
      await r.readFileAtCreationAsync('discussions/raw/placeholder.eml'),
    ).toBeNull();
    vi.resetModules();
  });

  it('commitExists resolves full and abbreviated SHAs, rejects fabricated ones (G51)', () => {
    const r = new RepoReader(mirror);
    expect(r.init()).toBe(true);
    const head = git(upstream, 'rev-parse', 'HEAD').trim();
    expect(r.commitExists(head)).toBe(true);
    expect(r.commitExists(head.slice(0, 7))).toBe(true);
    // Fabricated hash.
    expect(r.commitExists('9990ffa')).toBe(false);
    // Malformed inputs never reach git.
    expect(r.commitExists('not-a-hash')).toBe(false);
    expect(r.commitExists('abc12')).toBe(false);
  });

  it('listDir returns entry names under a directory, null for a missing one', () => {
    const r = new RepoReader(mirror);
    expect(r.init()).toBe(true);
    expect(r.listDir('program')).toEqual(['EMAIL_ALLOWLIST.md']);
    // Root listing: subdirectory appears as a bare name.
    expect(r.listDir('')).toContain('program');
    expect(r.listDir('no-such-dir')).toBeNull();
  });

  it('readFileBuffer returns byte-identical content for non-UTF8 files', () => {
    // Simulates raw .eml MIME content — must survive the round trip without
    // any encoding mangling (utf-8 decode would corrupt 0xff/0xfe).
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    fs.writeFileSync(path.join(upstream, 'raw.eml'), bytes);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-m', 'add binary eml');
    const r = new RepoReader(mirror);
    r.init();
    r.refresh({ force: true });
    const buf = r.readFileBuffer('raw.eml');
    expect(buf).not.toBeNull();
    expect(Buffer.compare(buf!, bytes)).toBe(0);
    expect(r.readFileBuffer('nope.eml')).toBeNull();
  });

  it('returns null for a missing file, true/false from exists()', () => {
    const r = new RepoReader(mirror);
    r.init();
    expect(r.readFile('nope.md')).toBeNull();
    expect(r.exists('program/EMAIL_ALLOWLIST.md')).toBe(true);
    expect(r.exists('nope.md')).toBe(false);
  });

  it('refresh() advances to new upstream commits', () => {
    const r = new RepoReader(mirror);
    r.init();
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Sam | sam@example.edu |\n',
    );
    git(upstream, 'commit', '-am', 'add sam');
    const { advanced } = r.refresh();
    expect(advanced).toBe(true);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'sam@example.edu',
    );
  });

  it('refreshAsync() advances to new upstream commits', async () => {
    const r = new RepoReader(mirror);
    r.init();
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Sam | sam@example.edu |\n',
    );
    git(upstream, 'commit', '-am', 'add sam');
    expect((await r.refreshAsync({ force: true })).advanced).toBe(true);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'sam@example.edu',
    );
    // Nothing new: not advanced.
    expect((await r.refreshAsync({ force: true })).advanced).toBe(false);
  });

  it('refreshAsync() keeps the admin-authored allowlist pin after a bot change', async () => {
    const r = new RepoReader(mirror);
    r.init();
    git(upstream, 'config', 'user.email', 'program-bot@example.org');
    git(upstream, 'config', 'user.name', 'Coordinator');
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Attacker | attacker@example.com |\n',
    );
    git(upstream, 'commit', '-am', 'bot changes allowlist');
    expect((await r.refreshAsync({ force: true })).advanced).toBe(true);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).not.toContain(
      'attacker@example.com',
    );
  });

  it('keeps the last admin-authored allowlist after a bot-authored change', () => {
    const r = new RepoReader(mirror);
    r.init();
    git(upstream, 'config', 'user.email', 'program-bot@example.org');
    git(upstream, 'config', 'user.name', 'Coordinator');
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Attacker | attacker@example.com |\n',
    );
    git(upstream, 'commit', '-am', 'bot changes allowlist');

    expect(r.refresh({ force: true }).advanced).toBe(true);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).not.toContain(
      'attacker@example.com',
    );
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
  });

  it('advances the pin to a newer admin revision even when a bot commit is latest', () => {
    const r = new RepoReader(mirror);
    r.init();
    // Admin adds a stakeholder…
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| New Staff | staff@example.edu |\n',
    );
    git(upstream, 'commit', '-am', 'admin adds staff');
    // …then a bot commit lands on top.
    git(upstream, 'config', 'user.email', 'program-bot@example.org');
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Attacker | attacker@example.com |\n',
    );
    git(upstream, 'commit', '-am', 'bot changes allowlist');

    expect(r.refresh({ force: true }).advanced).toBe(true);
    const served = r.readFile('program/EMAIL_ALLOWLIST.md');
    // The admin's own change is served; the bot's is not.
    expect(served).toContain('staff@example.edu');
    expect(served).not.toContain('attacker@example.com');
  });

  it('keeps the last-good allowlist pin when author verification fails transiently', () => {
    const r = new RepoReader(mirror);
    r.init();
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
    // Reconcile against a SHA git cannot resolve — the transient-failure
    // path must keep serving the existing pin, not null it.
    (r as any).reconcileAllowlistSha('f'.repeat(40));
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
  });

  it('re-pins the allowlist on a later refresh after a failed init-time check', () => {
    const r = new RepoReader(mirror);
    r.init();
    // Simulate an init-time author-check failure leaving no pin (a failed
    // check also leaves the verified marker lagging).
    (r as any).allowlistSha = null;
    (r as any).allowlistVerifiedSha = null;
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toBeNull();
    // A refresh with no new commits must still retry the reconcile.
    r.refresh({ force: true });
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
  });

  it('retries a stale pin left by a transient failure during an advancing refresh', () => {
    const r = new RepoReader(mirror);
    r.init();
    const v1 = git(upstream, 'rev-parse', 'HEAD').trim();
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| New Staff | staff@example.edu |\n',
    );
    git(upstream, 'commit', '-am', 'admin adds staff');
    r.refresh({ force: true });
    // Simulate the advance-time author check having failed: the pin stayed
    // on v1 and the verified marker lags the current SHA.
    (r as any).allowlistSha = v1;
    (r as any).allowlistVerifiedSha = null;
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).not.toContain(
      'staff@example.edu',
    );
    // A refresh with no new commits must re-verify and advance the pin.
    r.refresh({ force: true });
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'staff@example.edu',
    );
  });

  it('recovers the last admin-authored allowlist on a cold start', () => {
    git(upstream, 'config', 'user.email', 'faculty@example.com');
    git(upstream, 'config', 'user.name', 'Faculty Member');
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Attacker | attacker@example.com |\n',
    );
    git(upstream, 'commit', '-am', 'unauthorized allowlist change');
    execFileSync('git', [
      '-C',
      mirror,
      'fetch',
      'origin',
      '+refs/heads/main:refs/heads/main',
    ]);

    const r = new RepoReader(mirror);
    expect(r.init()).toBe(true);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).not.toContain(
      'attacker@example.com',
    );
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
  });

  it('serves last-good SHA when fetch fails', () => {
    const r = new RepoReader(mirror);
    r.init();
    const before = r.currentSha;
    fs.rmSync(upstream, { recursive: true, force: true }); // kill the remote
    const { advanced, sha } = r.refresh();
    expect(advanced).toBe(false);
    expect(sha).toBe(before);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
  });

  // Changed with host-repo.ts: the bootstrap used to run `git remote
  // get-url origin` in the live checkout. It now clones PROGRAM_ORIGIN_URL,
  // the operator's setting, and never asks the checkout.
  it('init() bootstraps a missing mirror from PROGRAM_ORIGIN_URL', () => {
    // Fresh deployment: no mirror yet; the operator named the origin
    // ("github" — here the upstream fixture).
    vi.stubEnv('PROGRAM_REPO', path.join(dir, 'no-live-checkout'));
    vi.stubEnv('PROGRAM_ORIGIN_URL', upstream);
    vi.stubEnv('PROGRAM_ORIGIN_PATTERN', '^/');

    const freshMirror = path.join(dir, 'bootstrapped-mirror.git');
    const r = new RepoReader(freshMirror);
    expect(r.init()).toBe(true);
    expect(r.currentSha).not.toBeNull();
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'avery@example.edu',
    );
  });

  it('bootstrap does not take the origin from the live checkout', () => {
    // The live checkout's .git/config is container-writable. With no
    // PROGRAM_ORIGIN_URL there is no bootstrap, whatever the checkout says.
    const live = path.join(dir, 'live-checkout');
    execFileSync('git', ['clone', upstream, live]);
    vi.stubEnv('PROGRAM_REPO', live);
    vi.stubEnv('PROGRAM_ORIGIN_PATTERN', '^/');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const r = new RepoReader(path.join(dir, 'not-bootstrapped.git'));
    expect(r.init()).toBe(false);
    expect(
      warn.mock.calls.some((c) =>
        String(c[1]).includes('PROGRAM_ORIGIN_URL is not set'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(dir, 'not-bootstrapped.git'))).toBe(false);
    warn.mockRestore();
  });

  it('bootstrap refuses an origin URL that is not the expected repo', () => {
    // The value must never reach `git clone` unchecked (option injection,
    // ext::), also when it comes from the setting.
    for (const url of [
      '--upload-pack=touch /tmp/pwned',
      'ext::sh -c touch% /tmp/pwned',
      'https://github.com/attacker/program-repo.git',
    ]) {
      vi.stubEnv('PROGRAM_ORIGIN_URL', url);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const r = new RepoReader(path.join(dir, `m-${Math.random()}.git`));
      expect(r.init()).toBe(false);
      // Refused before any clone was attempted, not merely failed.
      expect(
        warn.mock.calls.some((c) =>
          String(c[1]).includes('not the expected origin'),
        ),
      ).toBe(true);
      expect(
        warn.mock.calls.some((c) => String(c[1]).includes('clone failed')),
      ).toBe(false);
      warn.mockRestore();
    }
  });

  it('bootstrap accepts the real repo URL with or without a token', async () => {
    const { isExpectedOrigin } = await import('./repo-reader.js');
    expect(
      isExpectedOrigin(
        'https://x-token:abc@github.com/example-org/program-repo.git',
      ),
    ).toBe(true);
    expect(
      isExpectedOrigin('git@github.com:example-org/program-repo.git'),
    ).toBe(true);
    expect(
      isExpectedOrigin('https://github.com/example-org/program-repo-evil'),
    ).toBe(false);
    // A "credential" that hides another host.
    for (const url of [
      'https://attacker.example?@github.com/example-org/program-repo.git',
      'https://attacker.example#@github.com/example-org/program-repo',
      'https://github.com/example-org/program-repo.git?x=1',
      'https://github.com.evil/example-org/program-repo.git',
      'http://github.com/example-org/program-repo.git',
    ])
      expect(isExpectedOrigin(url)).toBe(false);
  });

  it('accepts a GitHub Enterprise origin through PROGRAM_ORIGIN_PATTERN', async () => {
    const { isExpectedOrigin } = await import('./repo-reader.js');
    // Without the setting, only the placeholder repo on github.com passes.
    expect(isExpectedOrigin('git@git.example.edu:team/kb.git')).toBe(false);
    expect(isExpectedOrigin('https://git.example.edu/team/kb.git')).toBe(false);

    // The two patterns in config/instance.env.example, for another host.
    vi.stubEnv(
      'PROGRAM_ORIGIN_PATTERN',
      '^git@git[.]example[.]edu:team/kb([.]git)?$',
    );
    expect(isExpectedOrigin('git@git.example.edu:team/kb.git')).toBe(true);
    expect(isExpectedOrigin('git@git.example.edu:team/kb')).toBe(true);
    for (const url of [
      'git@github.com:team/kb.git',
      'git@github.com:example-org/program-repo.git',
      'git@gitxexample.edu:team/kb.git',
      'git@git.example.edu:team/kb-evil.git',
      'git@git.example.edu:other/kb.git',
      'ext::git@git.example.edu:team/kb.git',
    ])
      expect(isExpectedOrigin(url)).toBe(false);

    vi.stubEnv(
      'PROGRAM_ORIGIN_PATTERN',
      '^https://([A-Za-z0-9_.~:-]+@)?git[.]example[.]edu/team/kb([.]git)?$',
    );
    expect(isExpectedOrigin('https://git.example.edu/team/kb.git')).toBe(true);
    expect(
      isExpectedOrigin('https://x-token:abc@git.example.edu/team/kb.git'),
    ).toBe(true);
    for (const url of [
      'https://github.com/team/kb.git',
      'http://git.example.edu/team/kb.git',
      'https://git.example.edu.evil.test/team/kb.git',
      // A "credential" that hides another host.
      'https://attacker.test?@git.example.edu/team/kb.git',
      'https://attacker.test#@git.example.edu/team/kb.git',
      'https://attacker.test/@git.example.edu/team/kb.git',
      'https://git.example.edu/team/kb.git?x=1',
      '--upload-pack=https://git.example.edu/team/kb.git',
    ])
      expect(isExpectedOrigin(url)).toBe(false);
  });

  it('init() fails closed when the mirror is missing and bootstrap cannot succeed', () => {
    // No live checkout either — bootstrap has no origin URL to clone from.
    vi.stubEnv('PROGRAM_REPO', path.join(dir, 'no-live-checkout'));
    const r = new RepoReader(path.join(dir, 'no-such.git'));
    expect(r.init()).toBe(false);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toBeNull();
    expect(r.exists('program/EMAIL_ALLOWLIST.md')).toBe(false);
  });

  it('stays silent on a plain missing file (no warn)', () => {
    const r = new RepoReader(mirror);
    r.init();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(r.readFile('nope.md')).toBeNull();
    expect(r.exists('nope.md')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns (and returns null/false) when the mirror breaks after the SHA is pinned', () => {
    const r = new RepoReader(mirror);
    r.init();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    fs.rmSync(mirror, { recursive: true, force: true }); // corrupt/delete mirror
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: 'program/EMAIL_ALLOWLIST.md' }),
      'RepoReader: read failed (mirror problem?)',
    );
    warn.mockClear();
    expect(r.exists('program/EMAIL_ALLOWLIST.md')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: 'program/EMAIL_ALLOWLIST.md' }),
      'RepoReader: read failed (mirror problem?)',
    );
  });

  it('success-cooldown skips the fetch; force bypasses it', () => {
    const r = new RepoReader(mirror);
    r.init();
    // Successful fetch starts the 30s cooldown.
    expect(r.refresh().advanced).toBe(false);
    fs.appendFileSync(
      path.join(upstream, 'program', 'EMAIL_ALLOWLIST.md'),
      '| Sam | sam@example.edu |\n',
    );
    git(upstream, 'commit', '-am', 'add sam');
    // Within the cooldown an un-forced refresh skips the fetch entirely.
    expect(r.refresh().advanced).toBe(false);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).not.toContain(
      'sam@example.edu',
    );
    // force: true always fetches (push-webhook path).
    expect(r.refresh({ force: true }).advanced).toBe(true);
    expect(r.readFile('program/EMAIL_ALLOWLIST.md')).toContain(
      'sam@example.edu',
    );
  });

  it('a failed fetch does not start the cooldown (retries not suppressed)', () => {
    const r = new RepoReader(mirror);
    r.init();
    fs.rmSync(upstream, { recursive: true, force: true }); // kill the remote
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    r.refresh();
    r.refresh();
    // Both back-to-back calls attempted (and failed) the fetch — a failure
    // must not suppress the retry behind a cooldown.
    const fetchFailures = warn.mock.calls.filter(
      (c) => c[1] === 'RepoReader: fetch failed; serving last-good SHA',
    );
    expect(fetchFailures).toHaveLength(2);
  });
});
