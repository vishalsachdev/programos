import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Host-side filesystem helpers for directories that agent containers can
 * write to (IPC, sessions, group folders, working context).
 *
 * The host runs as root. A container can plant a symlink anywhere in a
 * writable mount, and Node's chown/writeFile/copyFile follow symlinks, so a
 * plain host write or chown there reaches any path on the host (/etc,
 * .env, ~/.ssh). Every host mutation inside such a tree goes through these
 * helpers.
 *
 * Residual limit: Node has no openat(), so a container racing to swap a
 * directory between the component check and the write is not excluded.
 * The final component is always safe (exclusive temp + rename).
 */

/**
 * Refuse unless every component from root to `dir` is a real directory,
 * creating missing ones. `root` is the mount root the container sees; its
 * ancestors are host-owned and created with a plain recursive mkdir.
 */
function assertRealDirChain(root: string, dir: string): void {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const rel = path.relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error(`refused: ${dir} is outside ${root}`);
  let current = root;
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      fs.mkdirSync(current); // non-recursive: parent was just verified
      st = fs.lstatSync(current);
    }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new Error(`refused: ${current} is not a real directory`);
  }
}

/**
 * Who should own files the host creates in the tree. Applied only when the
 * host runs as root (in dev and tests there is nothing to hand over).
 * `fchown` is injectable for tests.
 */
export interface TreeOwner {
  uid: number;
  gid: number;
  fchown?: (fd: number, uid: number, gid: number) => void;
}

function applyOwner(fd: number, owner?: TreeOwner): void {
  if (!owner) return;
  if (owner.fchown) return owner.fchown(fd, owner.uid, owner.gid);
  if (process.getuid?.() === 0) fs.fchownSync(fd, owner.uid, owner.gid);
}

const { O_NOFOLLOW, O_NONBLOCK } = fs.constants;

/**
 * Open `root/relPath` without following a symlink at any component, and
 * only if it is a regular file with a single link (no hard link to a file
 * elsewhere). O_NONBLOCK keeps a planted FIFO from hanging the host.
 */
function openRegularInTree(
  root: string,
  relPath: string,
  flags: number,
): number {
  const target = path.resolve(root, relPath);
  assertRealDirChain(path.resolve(root), path.dirname(target));
  let fd: number;
  try {
    fd = fs.openSync(target, flags | O_NOFOLLOW | O_NONBLOCK, 0o644);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw err;
    throw new Error(`refused: cannot open ${target} safely (${code})`, {
      cause: err,
    });
  }
  const st = fs.fstatSync(fd);
  if (!st.isFile() || st.nlink > 1) {
    fs.closeSync(fd);
    throw new Error(`refused: ${target} is not a single-link regular file`);
  }
  return fd;
}

/** Append to `root/relPath`, creating it; never through a link or FIFO. */
export function appendFileInTree(
  root: string,
  relPath: string,
  content: string,
  owner?: TreeOwner,
): void {
  const { O_WRONLY, O_APPEND, O_CREAT } = fs.constants;
  const fd = openRegularInTree(root, relPath, O_WRONLY | O_APPEND | O_CREAT);
  try {
    fs.writeFileSync(fd, content); // loops until every byte is written
    applyOwner(fd, owner);
  } finally {
    fs.closeSync(fd);
  }
}

/** Create `root/relDir` (and root) without following a link anywhere. */
export function ensureDirInTree(root: string, relDir = ''): string {
  const dir = path.resolve(root, relDir);
  assertRealDirChain(path.resolve(root), dir);
  return dir;
}

/**
 * Copy the host-owned directory `srcDir` to `root/relDst`, overlaying what
 * is there. Every destination component is checked and every file goes
 * through writeFileInTree, so a link planted in the destination is refused
 * (directories) or replaced (files), never written through. Files are
 * created 0644: source modes are not preserved.
 */
export function copyDirInTree(
  srcDir: string,
  root: string,
  relDst: string,
): void {
  ensureDirInTree(root, relDst);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const rel = path.join(relDst, entry.name);
    if (entry.isDirectory()) copyDirInTree(src, root, rel);
    else if (entry.isFile()) writeFileInTree(root, rel, fs.readFileSync(src));
  }
}

/** Async twin of readFileInTree for callers on the shared event loop. */
export async function readFileInTreeAsync(
  root: string,
  relPath: string,
): Promise<string | null> {
  const target = path.resolve(root, relPath);
  assertRealDirChain(path.resolve(root), path.dirname(target));
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      target,
      fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`refused: cannot open ${target} safely (${code})`, {
      cause: err,
    });
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink > 1)
      throw new Error(`refused: ${target} is not a single-link regular file`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Read `root/relPath` as UTF-8, or null if absent; never through a link. */
export function readFileInTree(root: string, relPath: string): string | null {
  let fd: number;
  try {
    fd = openRegularInTree(root, relPath, fs.constants.O_RDONLY);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write `content` to `root/relPath` without following a symlink at any
 * component. A symlink at the final name is replaced, not written through.
 */
export function writeFileInTree(
  root: string,
  relPath: string,
  content: string | Buffer,
  owner?: TreeOwner,
): void {
  const target = path.resolve(root, relPath);
  const dir = path.dirname(target);
  assertRealDirChain(path.resolve(root), dir);
  const tmp = path.join(dir, `.host-write-${randomUUID()}.tmp`);
  try {
    // 'wx' = O_CREAT|O_EXCL: fails on any existing entry, including a symlink.
    const fd = fs.openSync(tmp, 'wx', 0o644);
    try {
      fs.writeFileSync(fd, content);
      applyOwner(fd, owner);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target); // replaces a link at target, never its target
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * True when every component from `root` to `dir` is a real directory; false
 * when one is missing. Throws when one is a link or not a directory. Unlike
 * assertRealDirChain it creates nothing: a delete must not make folders.
 */
function realDirChainExists(root: string, dir: string): boolean {
  const rel = path.relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error(`refused: ${dir} is outside ${root}`);
  let current = root;
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new Error(`refused: ${current} is not a real directory`);
  }
  return true;
}

/** One entry found by listFilesInTree. */
export interface TreeFile {
  name: string;
  mtimeMs: number;
  size: number;
  /** False for a link or a hard-linked file; only with `includeUnsafe`. */
  plain: boolean;
}

/**
 * The single-link regular files directly inside `root/relDir`, or null when
 * the folder is absent. Links, folders, FIFOs and hard-linked files are left
 * out, so a caller that deletes from this list never acts on one. With
 * `includeUnsafe`, links and hard-linked files are listed too, marked
 * `plain: false`, so the caller can report them; unlinkFileInTree refuses
 * them either way. Throws when a component of the path is a link.
 */
export function listFilesInTree(
  root: string,
  relDir = '',
  opts: { includeUnsafe?: boolean } = {},
): TreeFile[] | null {
  const dir = path.resolve(root, relDir);
  if (!realDirChainExists(path.resolve(root), dir)) return null;
  const files: TreeFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(dir, name));
    } catch {
      continue; // removed meanwhile
    }
    const plain = st.isFile() && st.nlink === 1;
    const unsafe = st.isSymbolicLink() || (st.isFile() && st.nlink > 1);
    if (!plain && !(opts.includeUnsafe && unsafe)) continue;
    files.push({ name, mtimeMs: st.mtimeMs, size: st.size, plain });
  }
  return files;
}

/**
 * Delete the file `root/relPath` and nothing else. Every folder on the way
 * is checked to be a real folder, and the name itself must be a single-link
 * regular file: a link, a folder or a hard-linked file is refused. unlink()
 * removes a name and never follows a link at it. Returns false when the
 * file is already gone. The residual race in the header applies.
 */
export function unlinkFileInTree(root: string, relPath: string): boolean {
  const target = path.resolve(root, relPath);
  if (!realDirChainExists(path.resolve(root), path.dirname(target)))
    return false;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isFile() || st.nlink > 1)
    throw new Error(`refused: ${target} is not a single-link regular file`);
  fs.unlinkSync(target);
  return true;
}

/**
 * Change ownership of `root` and everything under it without following
 * symlinks: links are lchown'd themselves and never descended into.
 */
export function chownTreeNoFollow(
  root: string,
  uid: number,
  gid: number,
  lchown: (p: string, uid: number, gid: number) => void = fs.lchownSync,
): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch {
    return;
  }
  // A hard-linked file shares its inode with a name elsewhere; changing its
  // owner would change that file too.
  if (!st.isDirectory() && st.nlink > 1) return;
  lchown(root, uid, gid);
  if (st.isSymbolicLink() || !st.isDirectory()) return;
  for (const entry of fs.readdirSync(root)) {
    chownTreeNoFollow(path.join(root, entry), uid, gid, lchown);
  }
}

/**
 * Refuse to let SQLite open `dbPath` if it, or a sidecar SQLite creates
 * beside it (-wal, -shm, -journal), is a link, FIFO or hard link. SQLite
 * follows links and creates a missing target, so a planted dangling link
 * in an agent-writable store/ would have root create a file anywhere.
 * Race-free only while no container runs (startup opens); later opens
 * narrow the window rather than close it.
 */
export function assertSafeDbPath(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = dbPath + suffix;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isFile() || st.nlink > 1)
      throw new Error(`refused: ${p} is not a single-link regular file`);
  }
}
