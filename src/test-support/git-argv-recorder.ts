/**
 * Test support: a `git` placed first on PATH that records the arguments and
 * the credential-carrying environment of every git process the code under
 * test starts, then runs the real git. Lets a test show what a local user
 * could have read in the process list.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { vi } from 'vitest';

export interface GitRecorder {
  /** One entry per git process: its arguments joined by spaces. */
  argv(): string[];
  /** The GIT_CONFIG_KEY_<n> entries each process had, on one line ('' for none). */
  configKeys(): string[];
  /** Everything recorded, as one string. */
  argvText(): string;
}

export function recordGitProcesses(dir: string): GitRecorder {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf-8' }).trim();
  const bin = path.join(dir, 'recorder-bin');
  const argvLog = path.join(dir, 'git-argv.log');
  const envLog = path.join(dir, 'git-env.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(argvLog, '');
  fs.writeFileSync(envLog, '');
  fs.writeFileSync(
    path.join(bin, 'git'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${argvLog}'`,
      `{ env | grep '^GIT_CONFIG_KEY_' | tr '\\n' ' '; echo; } >> '${envLog}'`,
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  // Files other users of the test machine may append to (the host runs git
  // as the checkout owner when it is root).
  fs.chmodSync(argvLog, 0o666);
  fs.chmodSync(envLog, 0o666);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  const lines = (file: string) =>
    fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
  return {
    argv: () => lines(argvLog),
    configKeys: () => lines(envLog),
    argvText: () => fs.readFileSync(argvLog, 'utf8'),
  };
}
