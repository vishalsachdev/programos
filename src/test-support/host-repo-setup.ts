/**
 * Vitest setup file: every test file gets a throwaway folder as its
 * host-owned repository unless it sets PROGRAM_HOST_REPO itself. Without
 * this, a test that only logs an audit entry would create a real git
 * repository beside whatever PROGRAM_REPO it uses (the default location).
 *
 * The folder holds an empty ".git", which the file helpers accept and which
 * host-repo.ts treats as "no repository": nothing is committed or pushed.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterAll } from 'vitest';

if (!process.env.PROGRAM_HOST_REPO) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-host-repo-'));
  fs.mkdirSync(path.join(dir, '.git'));
  process.env.PROGRAM_HOST_REPO = dir;
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(`${dir}-export.git`, { recursive: true, force: true });
  });
}
