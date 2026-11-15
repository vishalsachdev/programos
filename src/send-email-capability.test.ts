import { describe, expect, it } from 'vitest';

import { parseOutreachBatch } from './send-email-capability.js';

const BATCH = JSON.stringify({
  emails: [
    {
      to: 'owner@example.edu',
      subject: 'Program Action Items — Weekly Check-in',
      body: 'Hi Owner,\n\nYou have 3 open action items.\n',
    },
  ],
  summary: 'Nudged 1 owner.',
});

describe('parseOutreachBatch', () => {
  it('parses a bare JSON batch', () => {
    const batch = parseOutreachBatch(BATCH);
    expect(batch?.emails).toHaveLength(1);
    expect(batch?.summary).toBe('Nudged 1 owner.');
  });

  it('parses a fenced JSON batch', () => {
    const batch = parseOutreachBatch('```json\n' + BATCH + '\n```');
    expect(batch?.emails).toHaveLength(1);
  });

  it('returns null for prose with no batch', () => {
    expect(parseOutreachBatch('I emailed everyone, all good!')).toBeNull();
  });

  // Regression: a run wrapped its narration and self-eval in the
  // group's <internal>…</internal> convention around a bare, unfenced batch —
  // a valid batch was composed and then discarded as unparseable.
  it('parses a bare batch surrounded by <internal> blocks (2026-08-03 shape)', () => {
    const result = [
      '<internal>',
      'Reading complete. Now tallying open items per recipient and composing the batch JSON.',
      'Open item counts:',
      '- Owner: 3 open',
      '</internal>',
      '',
      BATCH,
      '',
      '<internal><eval>{"confidence":"high","has_citation":true,"category":"outreach"}</eval></internal>',
    ].join('\n');
    const batch = parseOutreachBatch(result);
    expect(batch?.emails).toHaveLength(1);
    expect(batch?.emails[0].to).toBe('owner@example.edu');
    expect(batch?.summary).toBe('Nudged 1 owner.');
  });

  it('does not mistake a self-eval JSON object for a batch', () => {
    const result = [
      '<internal>All owners current — no nudges needed this week.</internal>',
      '<internal><eval>{"confidence":"high","category":"outreach"}</eval></internal>',
    ].join('\n');
    expect(parseOutreachBatch(result)).toBeNull();
  });

  it('finds an embedded batch even amid surrounding prose', () => {
    const result = `Here is the batch you asked for.\n\n${BATCH}\n\nLet me know if anything should change.`;
    const batch = parseOutreachBatch(result);
    expect(batch?.emails).toHaveLength(1);
  });
});
