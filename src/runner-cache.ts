/**
 * Per-group agent-runner source cache: decide whether the cached copy under
 * data/sessions/<group>/agent-runner-src is stale.
 *
 * Comparing only `index.ts` mtimes would let a deploy that changes any
 * OTHER runner file (ipc-mcp-stdio.ts, a new module) leave every existing
 * group running the old code until someone wipes the cache by hand
 * (RC-018). The check walks the whole source tree.
 */
import fs from 'fs';
import path from 'path';

class WalkLimitExceeded extends Error {}

function walk(dir: string, rel: string, budget: { left: number }): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (--budget.left < 0) throw new WalkLimitExceeded();
    const relPath = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...walk(path.join(dir, entry.name), relPath, budget));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * The cache is agent-writable and persistent, so its size is not under host
 * control. Inspection is bounded: a tree over the budget is not walked
 * further, it is simply refreshed (wiped and recopied) — the safe outcome.
 */
export const DEFAULT_MAX_CACHE_ENTRIES = 5000;

/**
 * True when the cache is missing, forced, lacks a source file, or has any
 * file older than its source counterpart.
 */
export function runnerSourceNeedsCopy(
  srcDir: string,
  cachedDir: string,
  force: boolean,
  opts: { maxCacheEntries?: number } = {},
): boolean {
  if (force) return true;
  if (!fs.existsSync(cachedDir)) return true;
  const limit = opts.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  // The source tree is host-controlled and small; only the cache is bounded.
  const srcFiles = walk(srcDir, '', { left: Number.POSITIVE_INFINITY });
  const srcSet = new Set(srcFiles);
  let cachedFiles: string[];
  try {
    cachedFiles = walk(cachedDir, '', { left: limit });
  } catch (err) {
    if (err instanceof WalkLimitExceeded) return true;
    throw err;
  }
  // A file deleted or renamed upstream must not linger in the cache: the
  // runner compiles src/**/* and a stale module can break startup.
  if (cachedFiles.some((rel) => !srcSet.has(rel))) return true;
  for (const rel of srcFiles) {
    const cached = path.join(cachedDir, rel);
    if (!fs.existsSync(cached)) return true;
    if (
      fs.statSync(path.join(srcDir, rel)).mtimeMs > fs.statSync(cached).mtimeMs
    ) {
      return true;
    }
  }
  return false;
}
