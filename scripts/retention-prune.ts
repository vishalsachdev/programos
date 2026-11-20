/**
 * Show, or run by hand, the retention prune (src/retention.ts).
 *
 *   npx tsx scripts/retention-prune.ts              dry run: deletes nothing
 *   npx tsx scripts/retention-prune.ts --dry-run    the same, said out loud
 *   npx tsx scripts/retention-prune.ts --apply      delete now
 *
 * It reads the same RETENTION_*_DAYS settings as the host, from the process
 * environment and `.env`, and prints one line per store with counts only.
 * Run it from the install folder as the user the bot runs as. A setting at 0
 * (the default) is reported as "off" and nothing in that store is counted.
 * To see what a value would delete before you set it for the host, pass it
 * for this one command:
 *
 *   RETENTION_MESSAGES_DAYS=180 npx tsx scripts/retention-prune.ts
 *
 * The running host does the same prune once a day when a setting is above 0;
 * --apply is for a prune you do not want to wait for. Exit code 1 when a
 * setting is invalid or the database cannot be opened.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import { assertSafeDbPath } from '../src/host-fs-safety.js';
import {
  readRetentionConfig,
  RETENTION_SETTINGS,
  runRetention,
  type RetentionStore,
} from '../src/retention.js';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--dry-run' && a !== '--apply');
  if (
    unknown.length > 0 ||
    (args.includes('--dry-run') && args.includes('--apply'))
  ) {
    console.error(
      'Usage: npx tsx scripts/retention-prune.ts [--dry-run | --apply]',
    );
    return 1;
  }
  const dryRun = !args.includes('--apply');

  let config;
  try {
    config = readRetentionConfig();
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }

  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}; nothing to prune.`);
    return 1;
  }
  assertSafeDbPath(dbPath);
  const db = new Database(dbPath, { fileMustExist: true, readonly: dryRun });
  db.pragma('busy_timeout = 5000');
  try {
    const report = await runRetention(config, { db }, { dryRun });
    console.log(dryRun ? 'DRY RUN: nothing was deleted.' : 'APPLIED.');
    for (const store of Object.keys(RETENTION_SETTINGS) as RetentionStore[]) {
      const key = RETENTION_SETTINGS[store];
      const result = report[store];
      if (!result) {
        console.log(`${key}=0  off, everything kept`);
        continue;
      }
      const parts = [
        `${dryRun ? 'would delete' : 'deleted'} ${result.deleted}`,
        ...(result.keptNeeded
          ? [`kept ${result.keptNeeded} still needed`]
          : []),
        ...(result.refused
          ? [`refused ${result.refused} (link or unsafe path)`]
          : []),
        ...(result.skipped ? [`skipped: ${result.skipped}`] : []),
      ];
      console.log(`${key}=${config[store]}  ${parts.join('; ')}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
