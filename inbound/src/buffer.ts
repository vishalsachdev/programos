// The retry buffer, in Workers KV.
//
//   pending:<id>  a record waiting for its next attempt
//   raw:<id>      the raw message, kept only until its commit succeeds
//   failed:<id>   a record that used up its attempts, kept for a person

import type { Envelope, HostPayload } from './mail.js';
import type { KVStore } from './settings.js';

export interface PendingRecord {
  id: string;
  /** "commit": not in the repo yet. "post": committed, host not told. */
  stage: 'commit' | 'post';
  receivedAt: string;
  envelope: Envelope;
  payload?: HostPayload;
  attempts: number;
  nextAttemptAt: number;
  lastError: string;
}

const BASE_DELAY_MS = 5 * 60_000;
const MAX_DELAY_MS = 6 * 60 * 60_000;

/** 5, 10, 20, 40 minutes and so on, capped at 6 hours. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), MAX_DELAY_MS);
}

export async function parkForCommit(
  kv: KVStore,
  record: PendingRecord,
  raw: Uint8Array,
): Promise<void> {
  // Raw first: a record without its raw message could never be committed.
  await kv.put(`raw:${record.id}`, raw.slice().buffer);
  await kv.put(`pending:${record.id}`, JSON.stringify(record));
}

export async function savePending(
  kv: KVStore,
  record: PendingRecord,
): Promise<void> {
  await kv.put(`pending:${record.id}`, JSON.stringify(record));
}

export async function readRaw(
  kv: KVStore,
  id: string,
): Promise<Uint8Array | null> {
  const buf = await kv.get(`raw:${id}`, 'arrayBuffer');
  return buf ? new Uint8Array(buf) : null;
}

/** The message reached the host. Nothing of it stays in the buffer. */
export async function clear(kv: KVStore, id: string): Promise<void> {
  await kv.delete(`pending:${id}`);
  await kv.delete(`raw:${id}`);
}

/** Out of attempts. The record and any raw message stay until a person acts. */
export async function markFailed(
  kv: KVStore,
  record: PendingRecord,
): Promise<void> {
  await kv.put(`failed:${record.id}`, JSON.stringify(record));
  await kv.delete(`pending:${record.id}`);
}

export async function listPending(kv: KVStore): Promise<PendingRecord[]> {
  const records: PendingRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'pending:', cursor });
    for (const key of page.keys) {
      const text = await kv.get(key.name, 'text');
      if (!text) continue;
      try {
        records.push(JSON.parse(text) as PendingRecord);
      } catch {
        console.error(`inbound: unreadable buffer record ${key.name}`);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}
