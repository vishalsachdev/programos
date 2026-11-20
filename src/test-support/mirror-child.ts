/**
 * Run by src/repo-reader-git-stderr.test.ts in a process of its own, so the
 * test can read everything that process writes to its stderr.
 * argv[2]: the mirror path. Starts the read mirror and refreshes it once.
 */
import { RepoReader } from '../repo-reader.js';

const reader = new RepoReader(process.argv[2]);
reader.init();
reader.refresh({ force: true });
