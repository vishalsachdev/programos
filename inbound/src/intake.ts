// The two entry points, without the Workers runtime around them:
// `receive` for one new message, `retryPending` for the cron run.

import {
  backoffMs,
  clear,
  listPending,
  markFailed,
  parkForCommit,
  readRaw,
  savePending,
  type PendingRecord,
} from './buffer.js';
import { commitFiles, type FetchLike } from './github.js';
import { postToHost } from './host.js';
import {
  buildIntake,
  sha256Hex,
  type Envelope,
  type HostPayload,
} from './mail.js';
import {
  DEFAULT_MAX_ATTEMPTS,
  maxAttempts,
  maxMessageBytes,
  readSettings,
  type Env,
  type Settings,
} from './settings.js';

/** What this worker uses of the message Cloudflare hands an Email Worker. */
export interface InboundMessage {
  readonly from: string;
  readonly to: string;
  /** The platform's parsed headers. Absent in older test doubles. */
  readonly headers?: { get(name: string): string | null };
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface Deps {
  fetch: FetchLike;
  now: () => Date;
}

export type ReceiveOutcome =
  | 'delivered'
  | 'rejected-too-large'
  | 'parked-commit'
  | 'parked-post'
  | 'refused-by-host'
  | 'rejected-buffer-unavailable';

/** One cron run handles at most this many records (subrequest limits). */
const MAX_PER_RUN = 5;

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function commit(
  settings: Settings,
  raw: Uint8Array,
  envelope: Envelope,
  receivedAt: Date,
  deps: Deps,
): Promise<HostPayload> {
  const intake = await buildIntake(
    raw,
    envelope,
    receivedAt,
    settings.inboxDir,
    settings.authTrust,
  );
  await commitFiles(
    settings,
    [
      // The `.eml` first: its presence is what "already committed" means.
      { path: intake.emlPath, bytes: raw },
      {
        path: intake.markdownPath,
        bytes: new TextEncoder().encode(intake.markdown),
      },
    ],
    `Inbound email: ${intake.payload.filename}`,
    receivedAt,
    deps.fetch,
  );
  return intake.payload;
}

export async function receive(
  message: InboundMessage,
  env: Env,
  deps: Deps,
): Promise<ReceiveOutcome> {
  const limit = maxMessageBytes(env);
  const tooLarge = `Message too large. The limit is ${limit} bytes.`;
  if (message.rawSize > limit) {
    message.setReject(tooLarge);
    return 'rejected-too-large';
  }
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  if (raw.byteLength > limit) {
    message.setReject(tooLarge);
    return 'rejected-too-large';
  }

  const receivedAt = deps.now();
  const envelope: Envelope = {
    from: message.from,
    to: message.to,
    authenticationResults:
      message.headers?.get('authentication-results') ?? null,
  };
  const record: PendingRecord = {
    id: await sha256Hex(raw),
    stage: 'commit',
    receivedAt: receivedAt.toISOString(),
    envelope,
    attempts: 1,
    nextAttemptAt: receivedAt.getTime() + backoffMs(1),
    lastError: '',
  };

  // If the buffer cannot take the message either, refuse it at SMTP, so the
  // sending server reports the failure. The message is never dropped quietly.
  const park = async (outcome: ReceiveOutcome): Promise<ReceiveOutcome> => {
    try {
      if (record.stage === 'commit')
        await parkForCommit(env.PENDING, record, raw);
      else await savePending(env.PENDING, record);
      return outcome;
    } catch (err) {
      console.error(
        `inbound: buffer write failed for ${record.id}: ${errorText(err)}`,
      );
      message.setReject(
        'Temporary failure storing the message. Please send it again later.',
      );
      return 'rejected-buffer-unavailable';
    }
  };

  let settings: Settings;
  let payload: HostPayload;
  try {
    // A wrong setting lands here too: the message waits in the buffer while
    // a person fixes the setting.
    settings = readSettings(env);
    payload = await commit(settings, raw, envelope, receivedAt, deps);
  } catch (err) {
    record.lastError = errorText(err);
    console.error(
      `inbound: commit failed for ${record.id}: ${record.lastError}`,
    );
    return park('parked-commit');
  }

  const posted = await postToHost(settings, payload, deps.fetch);
  if (posted.kind === 'delivered') return 'delivered';
  console.error(`inbound: host POST for ${record.id}: ${posted.reason}`);
  record.stage = 'post';
  record.payload = payload;
  record.lastError = posted.reason;
  if (posted.kind === 'refused') {
    // Committed, and the host will not take this payload. Keep the record
    // for a person; a retry would get the same answer.
    try {
      await markFailed(env.PENDING, record);
    } catch (err) {
      console.error(
        `inbound: could not record refusal for ${record.id}: ${errorText(err)}`,
      );
    }
    return 'refused-by-host';
  }
  return park('parked-post');
}

export interface RetrySummary {
  delivered: number;
  waiting: number;
  failed: number;
}

/**
 * Count one failed attempt: schedule the next one, or give up.
 * `record.attempts` is the number of attempts made so far at this stage.
 */
async function reschedule(
  env: Env,
  record: PendingRecord,
  reason: string,
  limit: number,
  now: number,
  summary: RetrySummary,
): Promise<void> {
  record.attempts += 1;
  record.lastError = reason;
  if (record.attempts >= limit) {
    console.error(
      `inbound: giving up on ${record.id} at stage "${record.stage}" after ${record.attempts} attempts: ${reason}`,
    );
    await markFailed(env.PENDING, record);
    summary.failed += 1;
    return;
  }
  record.nextAttemptAt = now + backoffMs(record.attempts);
  await savePending(env.PENDING, record);
  summary.waiting += 1;
}

export async function retryPending(
  env: Env,
  deps: Deps,
): Promise<RetrySummary> {
  const summary: RetrySummary = { delivered: 0, waiting: 0, failed: 0 };
  const now = deps.now().getTime();
  const due = (await listPending(env.PENDING))
    .filter((r) => r.nextAttemptAt <= now)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)
    .slice(0, MAX_PER_RUN);

  for (const record of due) {
    // Read apart from the other settings, so a broken setting still counts
    // attempts and the record ends in "failed", not in a loop.
    let limit = DEFAULT_MAX_ATTEMPTS;
    try {
      limit = maxAttempts(env);
      const settings = readSettings(env);

      if (record.stage === 'commit') {
        const raw = await readRaw(env.PENDING, record.id);
        if (!raw) throw new Error('raw message missing from the buffer');
        record.payload = await commit(
          settings,
          raw,
          record.envelope,
          new Date(record.receivedAt),
          deps,
        );
        // Committed. Save that before the POST, so a crash here cannot lead
        // to a second commit attempt, and drop the raw copy.
        record.stage = 'post';
        record.attempts = 1;
        record.lastError = '';
        await savePending(env.PENDING, record);
        await env.PENDING.delete(`raw:${record.id}`);
      }

      const posted = await postToHost(settings, record.payload!, deps.fetch);
      if (posted.kind === 'delivered') {
        await clear(env.PENDING, record.id);
        summary.delivered += 1;
      } else if (posted.kind === 'refused') {
        record.lastError = posted.reason;
        console.error(`inbound: host refused ${record.id}: ${posted.reason}`);
        await markFailed(env.PENDING, record);
        summary.failed += 1;
      } else {
        await reschedule(env, record, posted.reason, limit, now, summary);
      }
    } catch (err) {
      const reason = errorText(err);
      console.error(`inbound: retry of ${record.id} failed: ${reason}`);
      try {
        await reschedule(env, record, reason, limit, now, summary);
      } catch (kvErr) {
        // The record stays as it was and is picked up by the next run.
        console.error(
          `inbound: buffer update failed for ${record.id}: ${errorText(kvErr)}`,
        );
      }
    }
  }
  return summary;
}
