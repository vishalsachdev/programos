/**
 * RC-018: host record of what an agent-requested email send
 * actually did, fed back to that agent on its next run.
 *
 * `send_email` is fire-and-forget from the container's point of view — the
 * tool returns "queued" before the host runs the allowlist gate. When the
 * gate drops a CC or refuses the send, the owner DM is alerted (G46) but the
 * agent that asked never learns of it, and its next reply narrates a
 * delivery that did not happen.
 *
 * Design constraints:
 * - Not a chat message: a stored message starts a main-group run by itself.
 *   Notes live in `delivery_notes` and are prepended to the next run's prompt.
 * - Recorded only at TERMINAL send outcomes (sent-with-drops, non-retryable
 *   refusal, dead-letter), never from the shortfall alerter, which also fires
 *   for retryable failures and alert replays.
 * - Keyed by delivery id, so a retry or replay updates rather than duplicates.
 */
import {
  ackDeliveryNotes as dbAckDeliveryNotes,
  peekDeliveryNotes,
  purgeDeliveryNotesOlderThan as dbPurgeDeliveryNotesOlderThan,
  upsertDeliveryNote,
} from './db.js';
import { logger } from './logger.js';

export interface DeliveryNoteInput {
  deliveryId: string;
  /** Group folder whose agent requested the send (e.g. `program-telegram`). */
  sourceGroup?: string;
  /** Subject or other short description of the send. */
  context: string;
  sent: string[];
  missed: string[];
  /**
   * Recipients whose outcome the host cannot vouch for either way (a
   * timeout after the provider may have accepted an attempt). Reported as
   * unconfirmed, never as NOT sent.
   */
  unknown?: string[];
  reason: string;
}

/**
 * Send paths whose `sourceGroup` is an attribution label with no agent run
 * behind it; a note there would never be read.
 */
const NO_AGENT_SOURCE_GROUPS = new Set([
  'webhook-access-closed',
  // Operator alert mail (ADMIN_ALERT_SOURCE_GROUP in admin-alert.ts).
  'admin-alert',
]);

/** Consumed notes are kept this long for inspection, then dropped. */
export const DELIVERY_NOTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Never-read notes (a source key no run queries, e.g. scheduled sends) are
 * dropped after this longer window; a conversational note for a quiet
 * thread survives well past a week.
 */
export const DELIVERY_NOTE_ORPHAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Prompt budget: a pile-up of failed sends must not make the run fail. */
export const MAX_DELIVERY_NOTES_PER_RUN = 8;
const MAX_NOTE_CHARS = 600;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export function formatDeliveryNote(input: DeliveryNoteInput): string {
  const sent = input.sent.length ? input.sent.join(', ') : 'nobody';
  return clip(
    [
      `[DELIVERY RESULT] ${input.context}`,
      `Sent to: ${sent}.`,
      ...(input.missed.length ? [`NOT sent: ${input.missed.join(', ')}.`] : []),
      ...(input.unknown?.length
        ? [
            `Delivery UNCONFIRMED for: ${input.unknown.join(', ')} (an attempt may have been accepted by the provider; say delivery is unconfirmed, not sent and not failed).`,
          ]
        : []),
      `Reason: ${input.reason}.`,
    ].join('\n'),
    MAX_NOTE_CHARS,
  );
}

export function recordDeliveryNote(input: DeliveryNoteInput): void {
  if (!input.sourceGroup || NO_AGENT_SOURCE_GROUPS.has(input.sourceGroup)) {
    return;
  }
  try {
    upsertDeliveryNote(
      input.deliveryId,
      input.sourceGroup,
      formatDeliveryNote(input),
    );
  } catch (err) {
    logger.error(
      { err, deliveryId: input.deliveryId },
      'Could not record delivery note for agent',
    );
  }
}

/**
 * Prompt section for the pending notes under any of `keys` (the run's chat
 * jid, plus the group folder for the main group), or null when there are
 * none. Does NOT consume: call `ackDeliveryNotes(ids)` after the run that
 * read them completed, so a failed run does not lose the record.
 */
export function deliveryNotesSection(
  keys: string[],
): { section: string; ids: string[] } | null {
  purgeDeliveryNotesOlderThan(
    DELIVERY_NOTE_RETENTION_MS,
    DELIVERY_NOTE_ORPHAN_RETENTION_MS,
  );
  const all = peekDeliveryNotes(keys);
  if (all.length === 0) return null;
  const notes = all.slice(0, MAX_DELIVERY_NOTES_PER_RUN);
  const remaining = all.length - notes.length;
  const section = [
    '<delivery_record>',
    'The host delivery gate produced these results for email you asked it to send earlier. This is the record of what actually left the machine.',
    "If you mention any of these emails, report the NOT-sent recipients as not sent. Do not say they were sent, CC'd, or delivered to a wrong address. Addresses come only from program/EMAIL_ALLOWLIST.md.",
    '',
    notes.map((n) => clip(n.note, MAX_NOTE_CHARS)).join('\n\n'),
    ...(remaining > 0
      ? [
          `(${remaining} more delivery record(s) pending; shown on a later run.)`,
        ]
      : []),
    '</delivery_record>',
  ].join('\n');
  return { section, ids: notes.map((n) => n.id) };
}

export function ackDeliveryNotes(ids: string[]): void {
  try {
    dbAckDeliveryNotes(ids);
  } catch (err) {
    logger.error({ err, ids }, 'Could not acknowledge delivery notes');
  }
}

export function purgeDeliveryNotesOlderThan(
  consumedMaxAgeMs: number,
  orphanMaxAgeMs: number,
): void {
  try {
    dbPurgeDeliveryNotesOlderThan(consumedMaxAgeMs, orphanMaxAgeMs);
  } catch (err) {
    logger.error({ err }, 'Could not purge old delivery notes');
  }
}

// Ack deferral: runAgent knows which notes it injected, but only the
// delivery processor knows whether the reply passed the delivery gate. A
// note is acknowledged when the caller confirms acceptance.
const deferredAcks = new Map<string, string[]>();

export function deferDeliveryNoteAck(chatJid: string, ids: string[]): void {
  if (ids.length === 0) return;
  const existing = deferredAcks.get(chatJid) ?? [];
  deferredAcks.set(chatJid, [...new Set([...existing, ...ids])]);
}

export function ackDeferredDeliveryNotes(chatJid: string): void {
  const ids = deferredAcks.get(chatJid);
  if (!ids) return;
  deferredAcks.delete(chatJid);
  ackDeliveryNotes(ids);
}
