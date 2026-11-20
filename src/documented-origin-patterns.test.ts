import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isExpectedOrigin } from './repo-reader.js';

/**
 * The PROGRAM_ORIGIN_PATTERN examples in config/instance.env.example and in
 * the docs are copied by adopters into a systemd `Environment=` line. systemd
 * reads a backslash and `%` itself, so an example must hold neither, and it
 * must still be a correct anchored pattern for its remote URL. Each example
 * is read from the file exactly as written and given to the real check.
 */
const ROOT = path.resolve(__dirname, '..');
const KEY = 'PROGRAM_ORIGIN_PATTERN=';

function patternsIn(rel: string): string[] {
  return fs
    .readFileSync(path.join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((line) => /^(# ?|Environment=)?PROGRAM_ORIGIN_PATTERN=/.test(line))
    .map((line) => line.slice(line.indexOf(KEY) + KEY.length));
}

function markdownFiles(rel: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, rel), {
    withFileTypes: true,
  })) {
    const child = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...markdownFiles(child));
    else if (e.name.endsWith('.md')) out.push(child);
  }
  return out;
}

/** The pattern with its host name replaced, so two hosts compare equal. */
function shape(pattern: string): string {
  return pattern.replace(
    /[a-z0-9-]+(\[\.\][a-z0-9-]+)+(?=[:/]your-org\/)/,
    'HOST',
  );
}

const REPO = 'your-org/your-program-repo';
// Every example in config/instance.env.example, exactly as written there,
// with URLs it must accept and URLs it must refuse.
const EXAMPLES: Record<string, { accept: string[]; refuse: string[] }> = {
  '^git@github[.]com:your-org/your-program-repo([.]git)?$': {
    accept: [`git@github.com:${REPO}.git`, `git@github.com:${REPO}`],
    refuse: [
      `git@githubxcom:${REPO}.git`,
      `git@github.com:${REPO}-evil.git`,
      `git@github.com:${REPO}xgit`,
      `git@github.com:other/your-program-repo.git`,
      `git@git.example.edu:${REPO}.git`,
      `ext::git@github.com:${REPO}.git`,
      `git@github.com:${REPO}.git\n`,
      `https://github.com/${REPO}.git`,
    ],
  },
  '^git@git[.]example[.]edu:your-org/your-program-repo([.]git)?$': {
    accept: [`git@git.example.edu:${REPO}.git`, `git@git.example.edu:${REPO}`],
    refuse: [
      `git@gitxexample.edu:${REPO}.git`,
      `git@git.examplexedu:${REPO}.git`,
      `git@git.example.edu.evil.test:${REPO}.git`,
      `git@github.com:${REPO}.git`,
      `git@git.example.edu:${REPO}-evil.git`,
      `ext::git@git.example.edu:${REPO}.git`,
    ],
  },
  '^https://([A-Za-z0-9_.~:-]+@)?git[.]example[.]edu/your-org/your-program-repo([.]git)?$':
    {
      accept: [
        `https://git.example.edu/${REPO}.git`,
        `https://git.example.edu/${REPO}`,
        `https://x-access-token:ghs_Abc123@git.example.edu/${REPO}.git`,
        `https://github_pat_11AB_cd@git.example.edu/${REPO}.git`,
      ],
      refuse: [
        `http://git.example.edu/${REPO}.git`,
        `https://github.com/${REPO}.git`,
        `https://gitxexample.edu/${REPO}.git`,
        `https://git.example.edu.evil.test/${REPO}.git`,
        // A "credential" that hides another host.
        `https://attacker.test?@git.example.edu/${REPO}.git`,
        `https://attacker.test#@git.example.edu/${REPO}.git`,
        `https://attacker.test/@git.example.edu/${REPO}.git`,
        `https://a@b@git.example.edu/${REPO}.git`,
        // White space in the credential part, which `\s` used to exclude.
        `https://a b@git.example.edu/${REPO}.git`,
        `https://a\tb@git.example.edu/${REPO}.git`,
        `https://a\nb@git.example.edu/${REPO}.git`,
        `https://@git.example.edu/${REPO}.git`,
        `https://git.example.edu/${REPO}.git?x=1`,
        `https://git.example.edu/${REPO}.git\n`,
        `--upload-pack=https://git.example.edu/${REPO}.git`,
      ],
    },
};

describe('documented PROGRAM_ORIGIN_PATTERN examples', () => {
  afterEach(() => vi.unstubAllEnvs());

  const inConfig = patternsIn('config/instance.env.example');

  it('config/instance.env.example holds exactly the examples tested here', () => {
    expect([...inConfig].sort()).toEqual(Object.keys(EXAMPLES).sort());
  });

  for (const [pattern, { accept, refuse }] of Object.entries(EXAMPLES)) {
    it(`accepts and refuses the right URLs: ${pattern}`, () => {
      vi.stubEnv('PROGRAM_ORIGIN_PATTERN', pattern);
      for (const url of accept)
        expect([url, isExpectedOrigin(url)]).toEqual([url, true]);
      for (const url of refuse)
        expect([url, isExpectedOrigin(url)]).toEqual([url, false]);
    });
  }

  it('no example, in the settings file or a doc, holds a backslash or a percent sign', () => {
    const docs = ['AGENTS.md', 'README.md', ...markdownFiles('docs')];
    const shapes = new Set(inConfig.map(shape));
    let seen = 0;
    for (const rel of ['config/instance.env.example', ...docs]) {
      for (const pattern of patternsIn(rel)) {
        seen++;
        const where = `${rel}: ${pattern}`;
        expect(where).not.toMatch(/[\\%]/);
        expect(pattern.startsWith('^') && pattern.endsWith('$'), where).toBe(
          true,
        );
        // A doc repeats a shape from the settings file, for its own host.
        expect(shapes.has(shape(pattern)), where).toBe(true);
      }
    }
    // The settings file, docs/deployment.md and at least one more doc.
    expect(seen).toBeGreaterThanOrEqual(inConfig.length + 2);
  });
});
