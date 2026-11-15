import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveTelegramSource } from './telegram-upload-store.js';

let root: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(
    // realpath: macOS tmpdir is under the /var -> /private/var symlink, which
    // the store rightly refuses as an untrusted directory.
    path.join(fs.realpathSync(os.tmpdir()), 'tg-store-'),
  );
});
afterEach(async () => {
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('host-owned Telegram source storage', () => {
  it('publishes complete files and refuses to overwrite a source', async () => {
    const dir = path.join(root, 'uploads', 'group');
    await saveTelegramSource(dir, 'notes.txt', 'original');
    await expect(
      saveTelegramSource(dir, 'notes.txt', 'replacement'),
    ).rejects.toThrow();
    expect(
      await fs.promises.readFile(path.join(dir, 'notes.txt'), 'utf8'),
    ).toBe('original');
    expect(await fs.promises.readdir(dir)).toEqual(['notes.txt']);
  });
  it.each(['notes.txt', 'notes.txt.extracted.md'])(
    'refuses a symlink target for %s',
    async (name) => {
      const dir = path.join(root, 'uploads', 'group');
      await fs.promises.mkdir(dir, { recursive: true });
      const victim = path.join(root, 'victim');
      await fs.promises.writeFile(victim, 'unchanged');
      await fs.promises.symlink(victim, path.join(dir, name));
      await expect(
        saveTelegramSource(dir, name, 'attacker bytes'),
      ).rejects.toThrow();
      expect(await fs.promises.readFile(victim, 'utf8')).toBe('unchanged');
      expect(await fs.promises.readdir(dir)).toEqual([name]);
    },
  );
  it('refuses a symlink staging root before creating a group or writing files', async () => {
    const victim = path.join(root, 'victim');
    await fs.promises.mkdir(victim);
    await fs.promises.symlink(victim, path.join(root, 'uploads'));
    await expect(
      saveTelegramSource(
        path.join(root, 'uploads', 'group'),
        'notes.txt',
        'bytes',
      ),
    ).rejects.toThrow('trusted host directory');
    expect(await fs.promises.readdir(victim)).toEqual([]);
  });
  it('refuses a staging directory writable by other users', async () => {
    const dir = path.join(root, 'uploads', 'group');
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.chmod(dir, 0o777);
    await expect(saveTelegramSource(dir, 'notes.txt', 'bytes')).rejects.toThrow(
      'trusted host directory',
    );
  });
});
