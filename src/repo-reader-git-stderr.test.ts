/**
 * Found by the independent read of the credential-handling change (PR 71):
 * the read mirror ran its clone and its fetch with git's stderr joined to
 * the host's own. When a git host refuses a login, git names the URL it
 * used, and a token written as the user name (`https://<token>@host/...`)
 * is part of that URL. The line then reached the host's error log without
 * passing the redaction.
 *
 * A stand-in `git` writes that message for the two network commands and
 * passes everything else to the real git. The host code runs in a process
 * of its own so that its raw stderr can be read.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  git,
  makeKbFixture,
  type KbFixture,
} from './test-support/kb-fixture.js';

const TOKEN = ['not', 'a', 'real', 'token', '7171'].join('-');
const ADDRESS = '127.0.0.1:9/team/program-repo.git';
const SETTING = `https://${TOKEN}@${ADDRESS}`;
const PATTERN = '^https://([A-Za-z0-9_.~:-]+@)?127[.]0[.]0[.]1:9/team/';

let kb: KbFixture;
let bin: string;

function realGit(): string {
  const found = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((d) => path.join(d, 'git'))
    .find((p) => fs.existsSync(p));
  if (!found) throw new Error('test setup: git not found on PATH');
  return found;
}

beforeEach(() => {
  kb = makeKbFixture();
  bin = path.join(kb.root, 'fake-bin');
  fs.mkdirSync(bin);
  // What git 2.43 prints when the server answers 401 to a URL whose user
  // name is the token and no password can be asked for.
  fs.writeFileSync(
    path.join(bin, 'git'),
    `#!/bin/bash
for arg in "$@"; do
  if [ "$arg" = clone ] || [ "$arg" = fetch ]; then
    echo "fatal: could not read Password for 'https://${TOKEN}@127.0.0.1:9': No such device or address" >&2
    exit 128
  fi
done
exec ${realGit()} "$@"
`,
    { mode: 0o755 },
  );
});

afterEach(() => kb.cleanup());

function runHost(mirror: string): string {
  const r = spawnSync(
    path.resolve('node_modules/.bin/tsx'),
    [path.resolve('src/test-support/mirror-child.ts'), mirror],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: kb.root,
        TMPDIR: process.env.TMPDIR ?? '',
        GIT_TERMINAL_PROMPT: '0',
        PROGRAM_ORIGIN_URL: SETTING,
        PROGRAM_ORIGIN_PATTERN: PATTERN,
      },
    },
  );
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

describe('read mirror: what git writes to stderr stays out of the host stderr', () => {
  it('the bootstrap clone: a refused login is logged without the token', () => {
    const all = runHost(kb.mirror);
    expect(all).toMatch(/mirror bootstrap clone failed/);
    expect(all).toMatch(/could not read Password/); // the reason is kept
    expect(all).not.toContain(TOKEN);
  });

  it('the fetch of an existing mirror: a refused login is logged without the token', () => {
    git(kb.root, [
      'clone',
      '-q',
      '--mirror',
      '--template=',
      kb.origin,
      kb.mirror,
    ]);
    git(kb.mirror, ['config', 'remote.origin.url', `https://${ADDRESS}`]);
    const all = runHost(kb.mirror);
    expect(all).toMatch(/fetch failed; serving last-good SHA/);
    expect(all).toMatch(/could not read Password/);
    expect(all).not.toContain(TOKEN);
  });
});
