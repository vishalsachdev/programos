import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import {
  ackDeferredDeliveryNotes,
  ackDeliveryNotes,
  deferDeliveryNoteAck,
  deliveryNotesSection,
  formatDeliveryNote,
  MAX_DELIVERY_NOTES_PER_RUN,
  purgeDeliveryNotesOlderThan,
  recordDeliveryNote,
  type DeliveryNoteInput,
} from './delivery-notes.js';

const ccDrop: DeliveryNoteInput = {
  deliveryId: 'd-1',
  sourceGroup: 'program-telegram',
  context: 'LAB 513 — weekly update',
  sent: ['srivera@example.edu'],
  missed: ['morgan@example.edu'],
  reason:
    'cc-recipient-not-allowlisted: morgan@example.edu (sender not on allowlist)',
};

describe('formatDeliveryNote', () => {
  it('names every missed address as NOT sent, with the gate reason', () => {
    const note = formatDeliveryNote(ccDrop);
    expect(note).toContain('srivera@example.edu');
    expect(note).toContain('morgan@example.edu');
    expect(note).toMatch(/NOT sent/);
    expect(note).toContain('cc-recipient-not-allowlisted');
  });

  it('says nobody when nothing was sent', () => {
    expect(formatDeliveryNote({ ...ccDrop, sent: [] })).toMatch(/nobody/i);
  });

  it('an unknown outcome is not reported as NOT sent', () => {
    const note = formatDeliveryNote({
      ...ccDrop,
      sent: [],
      missed: [],
      unknown: ['srivera@example.edu'],
      reason: 'outbox-item-expired',
    });
    expect(note).toMatch(/unconfirmed|unknown/i);
    expect(note).toContain('srivera@example.edu');
    expect(note).not.toMatch(/NOT sent/);
  });
});

describe('recordDeliveryNote + deliveryNotesSection', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('a recorded note is injected for its group and stays until acknowledged', () => {
    recordDeliveryNote(ccDrop);
    const first = deliveryNotesSection(['program-telegram']);
    expect(first).not.toBeNull();
    expect(first!.section).toContain('morgan@example.edu');
    expect(first!.section).toMatch(/do not (say|describe|report)/i);
    // Not consumed on read: a failed run must not lose the record.
    expect(deliveryNotesSection(['program-telegram'])).not.toBeNull();
    ackDeliveryNotes(first!.ids);
    expect(deliveryNotesSection(['program-telegram'])).toBeNull();
  });

  it('recording the same delivery id twice yields one note (latest wins)', () => {
    recordDeliveryNote(ccDrop);
    recordDeliveryNote({ ...ccDrop, sent: [], reason: 'send-exception: x' });
    const { section } = deliveryNotesSection(['program-telegram'])!;
    expect(section.match(/\[DELIVERY RESULT\]/g)).toHaveLength(1);
    expect(section).toContain('send-exception: x');
  });

  it('notes are scoped to the requesting key (group folder or thread jid)', () => {
    recordDeliveryNote(ccDrop);
    recordDeliveryNote({
      ...ccDrop,
      deliveryId: 'd-2',
      sourceGroup: 'webhook-email:thread-abc',
    });
    expect(deliveryNotesSection(['program-email'])).toBeNull();
    expect(deliveryNotesSection(['webhook-email:thread-abc'])).not.toBeNull();
    // A run may ask for several keys at once (its chat jid + main folder).
    const both = deliveryNotesSection([
      'webhook-email:thread-abc',
      'program-telegram',
    ])!;
    expect(both.ids).toHaveLength(2);
  });

  it('a note without a source group is not recorded', () => {
    recordDeliveryNote({ ...ccDrop, sourceGroup: undefined });
    expect(deliveryNotesSection(['program-telegram'])).toBeNull();
  });

  it('an unread note survives the consumed-note retention window', () => {
    recordDeliveryNote({ ...ccDrop, sourceGroup: 'program-email' });
    purgeDeliveryNotesOlderThan(0, 60_000);
    expect(deliveryNotesSection(['program-email'])).not.toBeNull();
  });

  it('notes nobody ever read are purged after the longer orphan window', () => {
    recordDeliveryNote({ ...ccDrop, sourceGroup: 'program-email' });
    purgeDeliveryNotesOlderThan(0, 0);
    expect(deliveryNotesSection(['program-email'])).toBeNull();
  });

  it('a consumed note is purged after the retention window', () => {
    recordDeliveryNote(ccDrop);
    const loaded = deliveryNotesSection(['program-telegram'])!;
    ackDeliveryNotes(loaded.ids);
    purgeDeliveryNotesOlderThan(0, 60_000);
    expect(deliveryNotesSection(['program-telegram'])).toBeNull();
  });

  it('the courtesy-reply path (no agent) records nothing', () => {
    recordDeliveryNote({ ...ccDrop, sourceGroup: 'webhook-access-closed' });
    expect(deliveryNotesSection(['webhook-access-closed'])).toBeNull();
  });

  it('a deferred ack is applied only when the caller confirms the reply was accepted', () => {
    recordDeliveryNote(ccDrop);
    const loaded = deliveryNotesSection(['program-telegram'])!;
    deferDeliveryNoteAck('tg-program@program', loaded.ids);
    // Not acked yet: a repair run or retry still sees the record.
    expect(deliveryNotesSection(['program-telegram'])).not.toBeNull();
    ackDeferredDeliveryNotes('tg-program@program');
    expect(deliveryNotesSection(['program-telegram'])).toBeNull();
    // Idempotent: a second confirm is a no-op.
    ackDeferredDeliveryNotes('tg-program@program');
  });

  it('injects at most MAX_DELIVERY_NOTES_PER_RUN notes and leaves the rest pending', () => {
    for (let i = 0; i < MAX_DELIVERY_NOTES_PER_RUN + 3; i++) {
      recordDeliveryNote({ ...ccDrop, deliveryId: `d-${i}` });
    }
    const first = deliveryNotesSection(['program-telegram'])!;
    expect(first.ids).toHaveLength(MAX_DELIVERY_NOTES_PER_RUN);
    expect(first.section).toMatch(/3 more/);
    ackDeliveryNotes(first.ids);
    expect(deliveryNotesSection(['program-telegram'])!.ids).toHaveLength(3);
  });

  it('truncates an oversized note so one bad subject cannot blow up the prompt', () => {
    recordDeliveryNote({ ...ccDrop, context: 'x'.repeat(5000) });
    const { section } = deliveryNotesSection(['program-telegram'])!;
    expect(section.length).toBeLessThan(2000);
  });
});
