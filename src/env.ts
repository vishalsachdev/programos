import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

/** Where the host reads its secrets from. */
export function envFilePath(): string {
  return path.join(process.cwd(), '.env');
}

/**
 * Write `.env`. A new file is created readable by its owner only (0600),
 * whatever the umask; an existing file keeps the mode it has. For the setup
 * steps that create or rewrite the file.
 */
export function writeEnvFile(file: string, content: string): void {
  const isNew = !fs.existsSync(file);
  fs.writeFileSync(file, content, isNew ? { mode: 0o600 } : {});
  if (isNew) fs.chmodSync(file, 0o600);
}

export interface EnvFilePermissionProblem {
  file: string;
  /** The permission bits found, in octal ("644"). */
  mode: string;
  /** The command that fixes it. */
  fix: string;
}

/**
 * `.env` holds every secret of the host. This says whether another user of
 * the machine can read it: any permission bit for the group or for others.
 * Null when the file is private, missing, or on Windows (no such bits).
 */
export function envFilePermissionProblem(
  file = envFilePath(),
): EnvFilePermissionProblem | null {
  if (process.platform === 'win32') return null;
  let mode: number;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    return null;
  }
  if ((mode & 0o077) === 0) return null;
  return { file, mode: mode.toString(8), fix: `chmod 600 ${file}` };
}

/**
 * An on/off setting: `1`, `true`, `on` and `0`, `false`, `off`, in any case.
 * Empty or unset is `fallback`. Any other value throws: a setting somebody
 * wrote and the host cannot read must not count as "off".
 */
export function booleanSetting(
  name: string,
  value: string | undefined,
  fallback: boolean,
): boolean {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '') return fallback;
  if (text === '1' || text === 'true' || text === 'on') return true;
  if (text === '0' || text === 'false' || text === 'off') return false;
  throw new Error(
    `${name} must be "true" or "false" (also 1, on, 0, off); it is set to a value the host does not know`,
  );
}

/**
 * The startup check. With a `.env` that the group or others can read it logs
 * one error naming the file and the command to fix it. The host still
 * starts, so an upgrade does not stop a deployment that was running; set
 * REQUIRE_PRIVATE_ENV_FILE=true (in the process environment or in `.env`) to
 * make it refuse to start instead. The setting is read before the file's
 * mode is looked at, so a value the host does not know stops the start
 * whether or not the file is private today.
 */
export function checkEnvFilePermissions(file = envFilePath()): void {
  const strict = booleanSetting(
    'REQUIRE_PRIVATE_ENV_FILE',
    process.env.REQUIRE_PRIVATE_ENV_FILE ||
      readEnvFile(['REQUIRE_PRIVATE_ENV_FILE']).REQUIRE_PRIVATE_ENV_FILE,
    false,
  );
  const problem = envFilePermissionProblem(file);
  if (!problem) return;
  const text =
    `${problem.file} holds every secret of this host and is readable by other users of this machine ` +
    `(mode ${problem.mode}). Fix it with: ${problem.fix}`;
  if (strict)
    throw new Error(
      `${text} (refusing to start: REQUIRE_PRIVATE_ENV_FILE=true)`,
    );
  logger.error(
    { file: problem.file, mode: problem.mode, fix: problem.fix },
    `${text} (set REQUIRE_PRIVATE_ENV_FILE=true to make the host refuse to start in this state)`,
  );
}
