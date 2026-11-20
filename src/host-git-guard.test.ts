/**
 * Regression guard: host code may run git only in the places reviewed here.
 *
 * The agent can write everything in its checkout, .git included, and git
 * obeys a repository's config and hooks. So no host git process may have the
 * checkout as its repository (host-repo.ts explains the design). This test
 * fails when a git call appears in a file that is not on the list below, or
 * when a listed file starts to aim git at the checkout.
 *
 * To add a git call: put it in host-repo.ts if it needs a working tree or a
 * credential; otherwise show in review that its repository is host-owned,
 * then add the file here with the reason.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** File -> why its git calls are safe, and what each call must contain. */
const REVIEWED: Record<string, { why: string; eachCall?: RegExp }> = {
  'src/host-repo.ts': {
    why: 'The host-owned repository. The checkout appears only as the source of a fetch (upload-pack side).',
  },
  'src/repo-reader.ts': {
    why: 'The bare read mirror, host-owned; or a clone into it from PROGRAM_ORIGIN_URL.',
    eachCall: /'-C',\s*this\.mirrorPath|'clone',\s*'--mirror'/,
  },
  'src/program-origin.ts': {
    why: "Reads the read mirror's config with --git-dir. The checkout's config is read as a file.",
    eachCall: /'--git-dir',\s*readMirrorPath\(\)/,
  },
  'src/channels/github-push-events.ts': {
    why: 'Every call takes the read mirror path from its caller.',
    eachCall: /'-C',\s*(mirrorPath|repoPath)\b/,
  },
  'scripts/check-host-git-trust.ts': {
    why: 'The first-start check. Runs git in the host repo with hostGitOptions.',
    eachCall: /hostGitOptions\(\{ credentialed \}\)/,
  },
  'scripts/deploy.sh': {
    why: 'Runs in the code checkout, which no container can write (mounted read-only for the main group).',
  },
  'scripts/state-snapshot-pull.sh': {
    why: 'Runs in the code checkout, as above. An example script the host does not run.',
  },
};

const SCAN_DIRS = ['src', 'scripts', 'setup'];
const SKIP = [
  /\.test\.ts$/,
  /^scripts\/upstream-sync\//,
  /^src\/test-support\//,
];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (
        /\.(ts|mts|mjs|cjs|js|sh)$/.test(entry.name) &&
        !SKIP.some((re) => re.test(rel))
      )
        out.push(rel);
    }
  };
  SCAN_DIRS.forEach(walk);
  return out.sort();
}

/** Offsets where a file starts a git process. */
function gitCalls(rel: string, text: string): number[] {
  const re = rel.endsWith('.sh')
    ? /(^|[\s;&|(`$])git\s+[a-z-]/gm
    : // 'git' as a program name: a quoted literal on its own, or the start
      // of a command string.
      /(['"`])git\1|['"`]git\s+[a-z-]/g;
  const hits: number[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const line = text.slice(lineStart, text.indexOf('\n', m.index));
    // Prose in a comment or a message is not a call.
    if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) continue;
    if (!rel.endsWith('.sh') && !/^(['"`])git\1$/.test(m[0])) {
      // A command string: only when handed to a process spawner.
      if (!/(exec|spawn)[A-Za-z]*\(\s*$/.test(text.slice(0, m.index))) continue;
    }
    hits.push(m.index);
  }
  return hits;
}

describe('host git calls are confined to the reviewed files', () => {
  const files = sourceFiles();
  const withGit = files.filter(
    (rel) =>
      gitCalls(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8')).length > 0,
  );

  it('finds the known callers (the scan itself works)', () => {
    expect(withGit).toContain('src/host-repo.ts');
    expect(withGit).toContain('src/repo-reader.ts');
    expect(files.length).toBeGreaterThan(100);
  });

  it('no file outside the reviewed list starts git', () => {
    expect(withGit.filter((rel) => !REVIEWED[rel])).toEqual([]);
  });

  it('the reviewed list has no stale entry', () => {
    expect(
      Object.keys(REVIEWED).filter((rel) => !withGit.includes(rel)),
    ).toEqual([]);
  });

  it('each call in a reviewed file names its host-owned repository', () => {
    for (const [rel, rule] of Object.entries(REVIEWED)) {
      if (!rule.eachCall) continue;
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const at of gitCalls(rel, text)) {
        const call = text.slice(at, at + 400);
        expect(
          rule.eachCall.test(call),
          `${rel}: git call at offset ${at} does not name its repository:\n${call.slice(0, 160)}`,
        ).toBe(true);
      }
    }
  });

  it('no host code aims a process at the checkout as its git repository', () => {
    const bad: string[] = [];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (/checkoutGitOptions/.test(text))
        bad.push(`${rel}: checkoutGitOptions`);
      if (/'(-C|--git-dir|--work-tree)',\s*getProgramRepoPath\(\)/.test(text))
        bad.push(`${rel}: git option with the checkout path`);
      if (/GIT_(DIR|WORK_TREE)\s*[:=]\s*getProgramRepoPath\(\)/.test(text))
        bad.push(`${rel}: GIT_DIR or GIT_WORK_TREE set to the checkout`);
    }
    expect(bad).toEqual([]);
  });

  it('host-repo.ts runs git in the host repo by default and hands the checkout over only as a fetch source', () => {
    const text = fs.readFileSync(path.join(ROOT, 'src/host-repo.ts'), 'utf8');
    // The two runners default their working directory to the host repo.
    expect(
      text.match(/cwd = getHostRepoPath\(\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    // The checkout path is used to check where the host repo may be, to
    // recognize the checkout among a container's mounts, to check that its
    // .git is a plain folder, and to build the fetch address. Nothing else.
    const uses = text
      .split('\n')
      .filter(
        (l) => /getProgramRepoPath\(\)/.test(l) && !/^\s*(\*|\/\/)/.test(l),
      )
      .map((l) => l.trim());
    expect(uses).toEqual([
      'const checkout = getProgramRepoPath();',
      'const checkout = realOrResolved(getProgramRepoPath());',
      "const st = fs.lstatSync(path.join(getProgramRepoPath(), '.git'));",
      'const checkout = path.resolve(getProgramRepoPath());',
    ]);
    expect(text).toContain('`file://${checkout}`');
  });
});
