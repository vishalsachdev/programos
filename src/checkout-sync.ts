/**
 * The host keeps the program-repo checkout in step with its remote.
 *
 * The agent container holds no git credential, and with the default
 * restricted network (CONTAINER_NETWORK) it has no route to the git host:
 * `git pull` and `git push` inside it fail. So the host does both, with its
 * own credential:
 *
 *   before a turn  pull --ff-only, so the agent reads the current state;
 *   after a turn   push the commits the agent made, before the reply is
 *                  handed on. If the remote moved, rebase and push again
 *                  (the same sequence as the audit-log commit).
 *
 * A push that fails is reported to the operator through the alert path
 * (setCheckoutPushAlerter), once per unpushed HEAD.
 *
 * Git runs as the checkout owner, never as root, like every other host git
 * call here (see program-repo.ts). The checkout's .git/config and hooks are
 * writable by the agent, and host git obeys them: this is an existing limit
 * of the design, recorded in SPEC.md section 11, not a new one.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { queueCheckoutGit } from './audit-log.js';
import { logger } from './logger.js';
import { checkoutGitOptions, getProgramRepoPath } from './program-repo.js';

export type GitRunner = (args: string[]) => Promise<string>;

function gitAsCheckoutOwner(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, checkoutGitOptions(), (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stderr })) : resolve(String(stdout)),
    );
  });
}

function hasCheckout(): boolean {
  return fs.existsSync(path.join(getProgramRepoPath(), '.git'));
}

function errorText(err: unknown): string {
  const e = err as { message?: string; stderr?: string };
  return (e.stderr || e.message || String(err)).trim().slice(0, 500);
}

let pushAlerter: ((text: string) => Promise<void>) | null = null;
let lastAlertedHead: string | null = null;

/** Wired at startup to the operator alert channel. */
export function setCheckoutPushAlerter(
  fn: ((text: string) => Promise<void>) | null,
): void {
  pushAlerter = fn;
  lastAlertedHead = null;
}

/**
 * Fast-forward the checkout before a turn. Best effort: a failure (remote
 * down, local commits not yet pushed, a file in the way) is logged and the
 * turn runs on the state it has. Never rebases or stashes here, because
 * another group's agent may be editing the working tree.
 */
export function syncCheckoutBeforeTurn(
  run: GitRunner = gitAsCheckoutOwner,
): Promise<'pulled' | 'skipped' | 'failed'> {
  if (!hasCheckout()) return Promise.resolve('skipped');
  return queueCheckoutGit(async () => {
    try {
      await run(['pull', '--ff-only']);
      return 'pulled' as const;
    } catch (err) {
      logger.warn(
        { err: errorText(err) },
        'Checkout sync: pull before the turn failed; the agent reads the local state',
      );
      return 'failed' as const;
    }
  });
}

/** The push sequence, with an injectable runner. Throws if nothing got out. */
export async function runCheckoutPush(run: GitRunner): Promise<void> {
  try {
    await run(['push']);
    return;
  } catch {
    // The remote moved (a person pushed): rebase on top and push again.
  }
  try {
    await run(['pull', '--rebase', '--autostash']);
    await run(['push']);
  } catch (err) {
    await run(['rebase', '--abort']).catch(() => {});
    throw err;
  }
}

export type PushOutcome = 'nothing' | 'pushed' | 'failed' | 'skipped';

/**
 * Push commits that are in the checkout and not on its upstream. Called
 * after each agent result. Never throws: a failure is logged and alerted,
 * and the commits stay local for the next attempt (the next turn, or the
 * next audit-log commit, which pushes the same branch).
 */
export function pushCheckoutAfterTurn(
  run: GitRunner = gitAsCheckoutOwner,
): Promise<PushOutcome> {
  if (!hasCheckout()) return Promise.resolve('skipped');
  return queueCheckoutGit(async () => {
    let head = '';
    try {
      const ahead = parseInt(
        await run(['rev-list', '--count', '@{upstream}..HEAD']),
        10,
      );
      if (ahead === 0) return 'nothing' as const;
      head = (await run(['rev-parse', 'HEAD'])).trim();
      await runCheckoutPush(run);
      logger.info({ head, commits: ahead }, 'Checkout sync: pushed');
      lastAlertedHead = null;
      return 'pushed' as const;
    } catch (err) {
      const reason = errorText(err);
      logger.error(
        { head, err: reason },
        'Checkout sync: push failed; commits stay on the host',
      );
      if (pushAlerter && (!head || head !== lastAlertedHead)) {
        lastAlertedHead = head || null;
        await pushAlerter(
          `Knowledge-base push failed. Commits made on this host are not on the remote` +
            (head ? ` (HEAD ${head.slice(0, 12)})` : '') +
            `. The host retries after the next turn. Reason: ${reason}`,
        ).catch((alertErr) =>
          logger.error(
            { err: errorText(alertErr) },
            'Checkout sync: push failure alert was not delivered',
          ),
        );
      }
      return 'failed' as const;
    }
  });
}
