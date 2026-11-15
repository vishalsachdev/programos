import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// store/ is writable for the main group's container, and these scripts run
// on the VPS as root. Plain JS twins of src/host-fs-safety.ts, which .mjs
// scripts cannot import.

/** Refuse unless every component from `root` down to `dir` is a real dir. */
function ensureRealDirChain(root, dir) {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  let current = root;
  const rel = path.relative(root, dir);
  for (const part of ['', ...rel.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      fs.mkdirSync(current); // non-recursive: parent was just verified
      st = fs.lstatSync(current);
    }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new Error(`refused: ${current} is not a real directory`);
  }
}

/**
 * Write a script output (eval artifact, dashboard). Under `root` (default:
 * the project directory, which holds every agent-writable tree: store/,
 * groups/, data/) every directory component must be real, and the file is
 * published by exclusive temp + rename: a planted link at the name is
 * replaced, never written through.
 */
export function writeArtifactFile(out, content, root = process.cwd()) {
  const target = path.resolve(out);
  const dir = path.dirname(target);
  const rel = path.relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    fs.mkdirSync(dir, { recursive: true }); // outside every agent mount
  else ensureRealDirChain(root, dir);
  const tmp = path.join(dir, `.artifact-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o644 });
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Refuse a SQLite path (or its -wal/-shm/-journal) that is a link, FIFO or
 * hard link: SQLite follows links, even for a read-only open.
 */
export function assertSafeDbFile(dbPath) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    let st;
    try {
      st = fs.lstatSync(dbPath + suffix);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isFile() || st.nlink > 1)
      throw new Error(
        `refused: ${dbPath + suffix} is not a single-link regular file`,
      );
  }
}
