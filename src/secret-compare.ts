/**
 * Compare a secret that a request presented with the one the host expects.
 *
 * A plain `===` stops at the first byte that differs, so how long it takes
 * tells a caller how much of a guess was right. Here both values are run
 * through HMAC-SHA256 with a key made when the process starts, and the two
 * digests (always 32 bytes) are compared with `timingSafeEqual`. So:
 *
 *  - the time taken does not depend on where the values differ;
 *  - a value of another length is handled the same way as one of the right
 *    length (no early return, nothing thrown);
 *  - a missing or non-string value is compared as the empty string and then
 *    refused, after the same work.
 *
 * An empty expected secret never matches: a listener without a secret must
 * not be opened by an empty header.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const PROCESS_KEY = randomBytes(32);

function digest(value: string): Buffer {
  return createHmac('sha256', PROCESS_KEY).update(value, 'utf8').digest();
}

export function secretsEqual(presented: unknown, expected: string): boolean {
  const given = typeof presented === 'string' ? presented : '';
  const same = timingSafeEqual(digest(given), digest(expected));
  return same && typeof presented === 'string' && expected.length > 0;
}

/** True when `header` is exactly "Bearer <secret>". */
export function bearerMatches(header: unknown, secret: string): boolean {
  const same = secretsEqual(header, `Bearer ${secret}`);
  return same && secret.length > 0;
}
