import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  ensureDirInTree,
  readFileInTree,
  writeFileInTree,
} from './host-fs-safety.js';
import { logger } from './logger.js';

const GROUP_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidGroupFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!GROUP_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidGroupFolder(folder: string): void {
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid group folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveGroupFolderPath(folder: string): string {
  assertValidGroupFolder(folder);
  const groupPath = path.resolve(GROUPS_DIR, folder);
  ensureWithinBase(GROUPS_DIR, groupPath);
  return groupPath;
}

export function resolveGroupIpcPath(folder: string): string {
  assertValidGroupFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}

/**
 * Create a newly registered group's folder (with logs/) and seed CLAUDE.md
 * from `template` unless the group already has one.
 */
export function seedGroupFolder(
  groupDir: string,
  template: string | null,
): boolean {
  // The folder is agent-writable once the group has run: a planted link is
  // refused (logs/) or replaced (CLAUDE.md), never followed.
  ensureDirInTree(groupDir, 'logs');
  let hasMd = false;
  try {
    hasMd = fs.lstatSync(path.join(groupDir, 'CLAUDE.md')).isFile();
  } catch {
    // absent
  }
  if (template === null || hasMd) return false;
  writeFileInTree(groupDir, 'CLAUDE.md', template);
  return true;
}

/** The CLAUDE.md template a new group is seeded from, or null if absent. */
export function readGroupTemplate(isMain: boolean): string | null {
  const templateFile = path.join(
    GROUPS_DIR,
    isMain ? 'main' : 'global',
    'CLAUDE.md',
  );
  // groups/global (and main's folder) are agent-writable: a linked template
  // would copy a host file such as .env into every new group.
  try {
    return readFileInTree(path.dirname(templateFile), 'CLAUDE.md');
  } catch (err) {
    logger.warn({ templateFile, err }, 'Refused group CLAUDE.md template');
    return null;
  }
}
