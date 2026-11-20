import fs from 'fs';
import path from 'path';

/**
 * The path as the file system knows it. A part that does not exist yet
 * cannot be resolved, so the nearest folder above it that does exist is
 * resolved and the rest is put back: a link higher up still counts when the
 * last folders are yet to be created.
 */
export function realPathOfNearestExisting(target: string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
