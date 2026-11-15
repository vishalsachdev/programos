import path from 'path';

/**
 * Is `name` safe to use as the last segment of a path inside an
 * attachment-staging directory? Filenames originate from untrusted sources —
 * chat-platform message attachments, parsed email MIME parts, agent-to-agent
 * forwards — and land in `path.join(dir, name)` sinks on the host. Without
 * this guard, a `..`-laden name escapes the inbox and writes anywhere the
 * host process has filesystem permission. See Signal Desktop's Nov 2025
 * attachment-fileName advisory for the same archetype.
 *
 * Rejects:
 *   - non-string / empty
 *   - `.` / `..` (traversal sentinels that path.basename returns as-is)
 *   - anything containing a path separator (`/` or `\`) or NUL
 *   - any value where `path.basename(name) !== name`, catching OS-specific
 *     separators and covering drives/prefixes on Windows runtimes
 *
 * Ported from upstream qwibitai/nanoclaw 7e37b13.
 */
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}

/**
 * Sanitize a filename for safe use in path.join. Returns the input if safe,
 * otherwise a timestamped fallback. Logs the rejection if a logger is given.
 */
export function safeAttachmentName(
  name: string | undefined,
  fallbackPrefix = 'attachment',
  logRejection?: (rawName: string, replacement: string) => void,
): string {
  const fallback = `${fallbackPrefix}-${Date.now()}`;
  if (!name) return fallback;
  if (isSafeAttachmentName(name)) return name;
  logRejection?.(name, fallback);
  return fallback;
}
