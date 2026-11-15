import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// setup/register.ts runs as root on a live install and writes into groups/,
// which agent containers can write to (their own folder; groups/global for
// the main group). It must not write through a link planted there.

const paths = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  const base = `${tmp}/nc-register-${process.pid}`;
  return { base, store: `${base}/store` };
});

vi.mock('../src/config.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.ts')>()),
  STORE_DIR: paths.store,
}));

import { run } from './register.ts';

const cwd = process.cwd();
let outside: string;

beforeEach(() => {
  fs.rmSync(paths.base, { recursive: true, force: true });
  outside = path.join(paths.base, 'outside');
  fs.mkdirSync(path.join(paths.base, 'groups', 'global'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), '# Andy\nKEEP\n');
  process.chdir(paths.base);
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(paths.base, { recursive: true, force: true });
});

const args = (...extra: string[]) => [
  '--jid',
  'x@g.us',
  '--name',
  'New',
  '--trigger',
  '@K',
  '--folder',
  'newgrp',
  ...extra,
];

describe('setup register never writes through a planted link', () => {
  it('does not create CLAUDE.md through a dangling link', async () => {
    fs.writeFileSync(
      path.join(paths.base, 'groups/global/CLAUDE.md'),
      '# Andy\n',
    );
    fs.mkdirSync(path.join(paths.base, 'groups/newgrp'));
    fs.symlinkSync(
      path.join(outside, 'new.md'),
      path.join(paths.base, 'groups/newgrp/CLAUDE.md'),
    );
    await run(args()).catch(() => {});
    expect(fs.existsSync(path.join(outside, 'new.md'))).toBe(false);
  });

  it('does not rewrite a linked CLAUDE.md when renaming the assistant', async () => {
    fs.symlinkSync(
      path.join(outside, 'secret.md'),
      path.join(paths.base, 'groups/global/CLAUDE.md'),
    );
    await run(args('--assistant-name', 'Bob')).catch(() => {});
    expect(fs.readFileSync(path.join(outside, 'secret.md'), 'utf8')).toBe(
      '# Andy\nKEEP\n',
    );
  });
});
