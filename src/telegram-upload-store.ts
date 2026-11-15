import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { isSafeAttachmentName } from './attachment-safety.js';
import { DATA_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';

export const TELEGRAM_UPLOAD_CONTAINER_PATH = '/workspace/telegram-uploads';

/** Outside every agent-writable mount; exposed only to its group, read-only. */
export function getTelegramUploadDir(groupFolder: string): string {
  resolveGroupFolderPath(groupFolder); // Validate the group folder segment.
  return path.join(DATA_DIR, 'telegram-uploads', groupFolder);
}

async function ensureHostDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o755 });
  const stat = await fs.promises.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.promises.realpath(directory)) !== path.resolve(directory)
  )
    throw new Error('Upload staging directory is not a trusted host directory');
}

/** Publish complete bytes without following or replacing an existing target. */
export async function saveTelegramSource(
  directory: string,
  filename: string,
  content: Buffer | string,
): Promise<void> {
  if (!isSafeAttachmentName(filename))
    throw new Error('Unsafe upload filename');
  // The application's data directory is trusted. Neither this root nor the
  // per-group directory is under a writable curriculum/group/session mount.
  await ensureHostDirectory(path.dirname(directory));
  await ensureHostDirectory(directory);
  const temporary = path.join(directory, `.upload-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, content, {
      flag: 'wx',
      mode: 0o644,
    });
    // link() publishes atomically with no-replace semantics. In particular,
    // an existing symlink fails with EEXIST instead of following its target.
    await fs.promises.link(temporary, path.join(directory, filename));
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}
