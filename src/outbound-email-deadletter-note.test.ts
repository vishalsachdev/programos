import { describe, it, expect } from 'vitest';
import { partitionDeadLetterRecipients } from './outbound-email.js';

const allowlist = {
  available: true,
  senders: new Set(['srivera@example.edu', 'avery@example.edu']),
  source: 'program/EMAIL_ALLOWLIST.md',
};

describe('partitionDeadLetterRecipients', () => {
  it('keeps an allowlist-rejected CC as NOT sent even after provider attempts', () => {
    const out = partitionDeadLetterRecipients(
      {
        to: 'srivera@example.edu',
        cc: 'morgan@example.edu, avery@example.edu',
      },
      ['srivera@example.edu', 'morgan@example.edu', 'avery@example.edu'],
      2,
      allowlist,
    );
    expect(out.missed).toEqual(['morgan@example.edu']);
    expect(out.unknown).toEqual(['srivera@example.edu', 'avery@example.edu']);
  });

  it('with no provider attempt, every intended recipient is NOT sent', () => {
    const out = partitionDeadLetterRecipients(
      { to: 'srivera@example.edu', cc: 'morgan@example.edu' },
      ['srivera@example.edu', 'morgan@example.edu'],
      0,
      allowlist,
    );
    expect(out.unknown).toEqual([]);
    expect(out.missed).toEqual(['srivera@example.edu', 'morgan@example.edu']);
  });
});
