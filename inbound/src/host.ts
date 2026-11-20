// The POST to the host webhook.

import type { FetchLike } from './github.js';
import type { HostPayload } from './mail.js';
import type { Settings } from './settings.js';

export type PostResult =
  /** The host answered 2xx. It processed the message or chose to skip it. */
  | { kind: 'delivered'; status: number }
  /** Worth another try later: host down, busy, or wrongly configured. */
  | { kind: 'retry'; reason: string }
  /** The host refused the payload itself. The same bytes will fail again. */
  | { kind: 'refused'; reason: string };

const POST_TIMEOUT_MS = 30_000;

/**
 * A repeated POST is safe only as far as the host makes it so. The host
 * keeps the Message-ID of each message it handled (the last 500, in memory)
 * and answers a repeat with 200 "duplicate"; while a message is in progress
 * it answers 503, which lands here as "retry". That memory is lost when the
 * host restarts, so this worker repeats a POST only when it did not see a
 * 2xx answer.
 */
export async function postToHost(
  settings: Settings,
  payload: HostPayload,
  fetchFn: FetchLike,
): Promise<PostResult> {
  let res: Response;
  try {
    res = await fetchFn(settings.hostWebhookUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.webhookSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      kind: 'retry',
      reason: `host unreachable: ${err instanceof Error ? err.name : 'error'}`,
    };
  }
  if (res.ok) return { kind: 'delivered', status: res.status };
  // 400: missing field, bad path or bad JSON. 413 and 422: the body itself.
  if (res.status === 400 || res.status === 413 || res.status === 422) {
    return { kind: 'refused', reason: `host answered HTTP ${res.status}` };
  }
  // Everything else, 401 included: a wrong secret or a proxy fault is fixed
  // by a person, and the message should still be there when it is.
  return { kind: 'retry', reason: `host answered HTTP ${res.status}` };
}
