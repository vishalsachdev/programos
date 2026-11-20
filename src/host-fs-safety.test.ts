import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendFileInTree,
  chownTreeNoFollow,
  copyDirInTree,
  ensureDirInTree,
  listFilesInTree,
  readFileInTree,
  readFileInTreeAsync,
  unlinkFileInTree,
  writeFileInTree,
} from './host-fs-safety.js';

// The host runs as root and writes into directories agent containers can
// write to. A container can plant a symlink there; none of these helpers may
// follow it out of the tree.

let base: string;
let root: string; // stands in for an agent-writable mount root
let outside: string; // stands in for any host path outside that root

beforeEach(() => {
  base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hfs-'));
  root = path.join(base, 'ipc', 'group');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.env'), 'KEEP=1\n');
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

describe('writeFileInTree', () => {
  it('writes a new file inside the tree', () => {
    writeFileInTree(root, 'current_tasks.json', '[]');
    expect(fs.readFileSync(path.join(root, 'current_tasks.json'), 'utf8')).toBe(
      '[]',
    );
  });

  it('replaces an existing regular file', () => {
    fs.writeFileSync(path.join(root, 'current_tasks.json'), 'old');
    writeFileInTree(root, 'current_tasks.json', 'new');
    expect(fs.readFileSync(path.join(root, 'current_tasks.json'), 'utf8')).toBe(
      'new',
    );
  });

  it('replaces a planted symlink instead of writing through it', () => {
    const target = path.join(outside, 'secret.env');
    fs.symlinkSync(target, path.join(root, 'current_tasks.json'));
    writeFileInTree(root, 'current_tasks.json', '[]');
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP=1\n');
    const st = fs.lstatSync(path.join(root, 'current_tasks.json'));
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
  });

  it('refuses a symlinked parent directory and creates nothing outside', () => {
    fs.symlinkSync(outside, path.join(root, 'logs'));
    expect(() => writeFileInTree(root, 'logs/container-1.log', 'x')).toThrow(
      /refused/,
    );
    expect(fs.readdirSync(outside)).toEqual(['secret.env']);
  });

  it('creates missing intermediate directories inside the tree', () => {
    writeFileInTree(root, 'logs/container-1.log', 'x');
    expect(
      fs.readFileSync(path.join(root, 'logs/container-1.log'), 'utf8'),
    ).toBe('x');
  });

  it('accepts a directory whose name starts with ..', () => {
    writeFileInTree(root, '..archive/x.md', 'ok');
    expect(fs.readFileSync(path.join(root, '..archive/x.md'), 'utf8')).toBe(
      'ok',
    );
  });

  it('refuses a relative path that escapes the tree', () => {
    expect(() => writeFileInTree(root, '../../outside/new.txt', 'x')).toThrow(
      /refused/,
    );
    expect(fs.readdirSync(outside)).toEqual(['secret.env']);
  });

  it('does not write through a symlink planted at a predictable temp name', () => {
    // A pid-based temp name is guessable (allowlist-snapshot.ts used one);
    // the temp file must be created exclusively under an unguessable name.
    const target = path.join(outside, 'secret.env');
    fs.symlinkSync(
      target,
      path.join(root, `current_tasks.json.${process.pid}.tmp`),
    );
    writeFileInTree(root, 'current_tasks.json', '[]');
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP=1\n');
    expect(fs.readFileSync(path.join(root, 'current_tasks.json'), 'utf8')).toBe(
      '[]',
    );
  });
});

describe('chownTreeNoFollow', () => {
  function recordingChown() {
    const calls: string[] = [];
    return {
      calls,
      lchown: (p: string) => {
        calls.push(p);
      },
    };
  }

  it('visits the root and every real file and directory', () => {
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.writeFileSync(path.join(root, 'tasks', 'a.json'), '{}');
    const rec = recordingChown();
    chownTreeNoFollow(root, 1000, 1000, rec.lchown);
    expect(rec.calls.sort()).toEqual(
      [
        root,
        path.join(root, 'tasks'),
        path.join(root, 'tasks', 'a.json'),
      ].sort(),
    );
  });

  it('never descends into or past a symlinked directory', () => {
    fs.symlinkSync(outside, path.join(root, 'poison'));
    const rec = recordingChown();
    chownTreeNoFollow(root, 1000, 1000, rec.lchown);
    expect(rec.calls.some((p) => p.startsWith(outside))).toBe(false);
    expect(rec.calls).not.toContain(path.join(root, 'poison', 'secret.env'));
  });

  it('uses a non-following chown for the symlink itself', () => {
    // lchown on the link changes the link, not its target. The default
    // implementation must be fs.lchownSync, never fs.chownSync.
    fs.symlinkSync(outside, path.join(root, 'poison'));
    const seen: string[] = [];
    const original = fs.chownSync;
    (fs as { chownSync: typeof fs.chownSync }).chownSync = ((
      p: fs.PathLike,
    ) => {
      seen.push(String(p));
    }) as typeof fs.chownSync;
    try {
      chownTreeNoFollow(root, process.getuid?.() ?? 0, process.getgid?.() ?? 0);
    } finally {
      (fs as { chownSync: typeof fs.chownSync }).chownSync = original;
    }
    expect(seen).toEqual([]);
  });

  it('leaves a hard-linked file alone (lchown would change the shared inode)', () => {
    fs.linkSync(path.join(outside, 'secret.env'), path.join(root, 'hard'));
    const visited: string[] = [];
    chownTreeNoFollow(root, 1000, 1000, (p) => visited.push(p));
    expect(visited).not.toContain(path.join(root, 'hard'));
  });

  it('does not throw when the root does not exist', () => {
    expect(() =>
      chownTreeNoFollow(path.join(base, 'missing'), 1000, 1000, () => {}),
    ).not.toThrow();
  });
});

describe('appendFileInTree', () => {
  it('creates then appends to a file inside the tree', () => {
    appendFileInTree(root, 'audit-log/2026-09-24.md', 'a\n');
    appendFileInTree(root, 'audit-log/2026-09-24.md', 'b\n');
    expect(
      fs.readFileSync(path.join(root, 'audit-log/2026-09-24.md'), 'utf8'),
    ).toBe('a\nb\n');
  });

  it('refuses to append through a planted symlink', () => {
    const target = path.join(outside, 'secret.env');
    fs.mkdirSync(path.join(root, 'audit-log'));
    fs.symlinkSync(target, path.join(root, 'audit-log/2026-09-25.md'));
    expect(() =>
      appendFileInTree(root, 'audit-log/2026-09-25.md', 'x'),
    ).toThrow(/refused/);
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP=1\n');
  });

  it('refuses a symlinked parent directory', () => {
    fs.symlinkSync(outside, path.join(root, 'audit-log'));
    expect(() => appendFileInTree(root, 'audit-log/new.md', 'x')).toThrow(
      /refused/,
    );
    expect(fs.readdirSync(outside)).toEqual(['secret.env']);
  });

  it('refuses a hard-linked file', () => {
    fs.linkSync(path.join(outside, 'secret.env'), path.join(root, 'linked.md'));
    expect(() => appendFileInTree(root, 'linked.md', 'x')).toThrow(/refused/);
    expect(fs.readFileSync(path.join(outside, 'secret.env'), 'utf8')).toBe(
      'KEEP=1\n',
    );
  });

  it('does not block on a planted FIFO', () => {
    const fifo = path.join(root, 'fifo.md');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // mkfifo unavailable
    }
    expect(() => appendFileInTree(root, 'fifo.md', 'x')).toThrow(/refused/);
  });
});

describe('readFileInTree', () => {
  it('reads a regular file', () => {
    fs.writeFileSync(path.join(root, 'a.md'), 'hello');
    expect(readFileInTree(root, 'a.md')).toBe('hello');
  });

  it('returns null for a missing file', () => {
    expect(readFileInTree(root, 'missing.md')).toBeNull();
  });

  it('refuses to read a FIFO (open succeeds, the type check must catch it)', () => {
    execFileSync('mkfifo', [path.join(root, 'pipe.md')]);
    expect(() => readFileInTree(root, 'pipe.md')).toThrow(/refused/);
  });

  it('refuses to read through a symlink', () => {
    fs.symlinkSync(path.join(outside, 'secret.env'), path.join(root, 'a.md'));
    expect(() => readFileInTree(root, 'a.md')).toThrow(/refused/);
  });
});

describe('owner option', () => {
  it('writeFileInTree and appendFileInTree hand the file to the owner', () => {
    const calls: Array<[number, number]> = [];
    const fchown = (_fd: number, uid: number, gid: number) => {
      calls.push([uid, gid]);
    };
    writeFileInTree(root, 'w.json', '[]', { uid: 1000, gid: 1000, fchown });
    appendFileInTree(root, 'a.md', 'x', { uid: 1000, gid: 1000, fchown });
    expect(calls).toEqual([
      [1000, 1000],
      [1000, 1000],
    ]);
  });
});

describe('ensureDirInTree', () => {
  it('creates the tree root and nested directories', () => {
    const fresh = path.join(base, 'ipc', 'new-group');
    ensureDirInTree(fresh, 'input');
    expect(fs.lstatSync(path.join(fresh, 'input')).isDirectory()).toBe(true);
  });

  it('refuses a symlinked directory and creates nothing outside', () => {
    fs.symlinkSync(outside, path.join(root, 'input'));
    expect(() => ensureDirInTree(root, 'input/sub')).toThrow(/refused/);
    expect(fs.readdirSync(outside)).toEqual(['secret.env']);
  });
});

describe('copyDirInTree', () => {
  let src: string;
  beforeEach(() => {
    src = path.join(base, 'src-skill');
    fs.mkdirSync(path.join(src, 'refs'), { recursive: true });
    fs.writeFileSync(path.join(src, 'SKILL.md'), 'skill');
    fs.writeFileSync(path.join(src, 'refs', 'a.md'), 'a');
  });

  it('copies a directory tree into the destination', () => {
    copyDirInTree(src, root, 'skills/s');
    expect(fs.readFileSync(path.join(root, 'skills/s/refs/a.md'), 'utf8')).toBe(
      'a',
    );
  });

  it('replaces a planted file link instead of writing through it', () => {
    fs.mkdirSync(path.join(root, 'skills/s'), { recursive: true });
    fs.symlinkSync(
      path.join(outside, 'secret.env'),
      path.join(root, 'skills/s/SKILL.md'),
    );
    copyDirInTree(src, root, 'skills/s');
    expect(fs.readFileSync(path.join(outside, 'secret.env'), 'utf8')).toBe(
      'KEEP=1\n',
    );
    expect(fs.lstatSync(path.join(root, 'skills/s/SKILL.md')).isFile()).toBe(
      true,
    );
  });

  it('refuses a linked destination directory', () => {
    fs.mkdirSync(path.join(root, 'skills'));
    fs.symlinkSync(outside, path.join(root, 'skills/s'));
    expect(() => copyDirInTree(src, root, 'skills/s')).toThrow(/refused/);
    expect(fs.readdirSync(outside)).toEqual(['secret.env']);
  });
});

describe('readFileInTreeAsync', () => {
  it('reads a regular file and returns null when absent', async () => {
    fs.writeFileSync(path.join(root, 'a.json'), '[]');
    expect(await readFileInTreeAsync(root, 'a.json')).toBe('[]');
    expect(await readFileInTreeAsync(root, 'missing.json')).toBeNull();
  });

  it('refuses to read through a symlink', async () => {
    fs.symlinkSync(path.join(outside, 'secret.env'), path.join(root, 'a.json'));
    await expect(readFileInTreeAsync(root, 'a.json')).rejects.toThrow(
      /refused/,
    );
  });

  it('does not block on a planted FIFO', async () => {
    execFileSync('mkfifo', [path.join(root, 'fifo.json')]);
    await expect(readFileInTreeAsync(root, 'fifo.json')).rejects.toThrow(
      /refused/,
    );
  });
});

describe('listFilesInTree and unlinkFileInTree', () => {
  it('lists and deletes a plain file, and reports a missing one', () => {
    fs.mkdirSync(path.join(root, 'old'));
    fs.writeFileSync(path.join(root, 'old', 'a.md'), 'a');
    expect(listFilesInTree(root, 'old')?.map((f) => f.name)).toEqual(['a.md']);
    expect(unlinkFileInTree(root, 'old/a.md')).toBe(true);
    expect(unlinkFileInTree(root, 'old/a.md')).toBe(false);
    expect(listFilesInTree(root, 'old')).toEqual([]);
  });

  it('creates no folder when the folder is absent', () => {
    expect(listFilesInTree(root, 'absent')).toBeNull();
    expect(unlinkFileInTree(root, 'absent/a.md')).toBe(false);
    expect(fs.existsSync(path.join(root, 'absent'))).toBe(false);
  });

  it('refuses a linked folder and leaves the files behind it', () => {
    fs.symlinkSync(outside, path.join(root, 'old'));
    expect(() => listFilesInTree(root, 'old')).toThrow(/not a real directory/);
    expect(() => unlinkFileInTree(root, 'old/secret.env')).toThrow(
      /not a real directory/,
    );
    expect(fs.readFileSync(path.join(outside, 'secret.env'), 'utf8')).toBe(
      'KEEP=1\n',
    );
  });

  it('leaves a link, a folder and a hard link out of the list, and refuses to delete them', () => {
    fs.symlinkSync(path.join(outside, 'secret.env'), path.join(root, 'l.md'));
    fs.mkdirSync(path.join(root, 'd.md'));
    fs.linkSync(path.join(outside, 'secret.env'), path.join(root, 'h.md'));
    expect(listFilesInTree(root)).toEqual([]);
    for (const name of ['l.md', 'd.md', 'h.md']) {
      expect(() => unlinkFileInTree(root, name)).toThrow(
        /not a single-link regular file/,
      );
      expect(fs.lstatSync(path.join(root, name))).toBeTruthy();
    }
    expect(fs.readFileSync(path.join(outside, 'secret.env'), 'utf8')).toBe(
      'KEEP=1\n',
    );
  });

  it('refuses a path that leaves the tree', () => {
    expect(() => unlinkFileInTree(root, '../../outside/secret.env')).toThrow(
      /outside/,
    );
    expect(fs.existsSync(path.join(outside, 'secret.env'))).toBe(true);
  });
});
