import { simpleParser } from 'mailparser';
import { describe, it, expect } from 'vitest';

import { checkParsedForLoop } from './email-loop-detection.js';

function withHeaders(headers: Record<string, string>) {
  return { headers: new Map(Object.entries(headers)) };
}

describe('checkParsedForLoop', () => {
  it('passes a normal human email through', () => {
    const result = checkParsedForLoop(
      withHeaders({
        from: 'paige@example.edu',
        subject: 'curriculum question',
      }),
    );
    expect(result.isAutoReply).toBe(false);
  });

  it('detects RFC 3834 Auto-Submitted: auto-replied', () => {
    const result = checkParsedForLoop(
      withHeaders({ 'Auto-Submitted': 'auto-replied' }),
    );
    expect(result.isAutoReply).toBe(true);
    expect(result.reason).toMatch(/Auto-Submitted/i);
  });

  it('detects Auto-Submitted: auto-generated', () => {
    const result = checkParsedForLoop(
      withHeaders({ 'auto-submitted': 'auto-generated' }),
    );
    expect(result.isAutoReply).toBe(true);
  });

  it('detects mailing-list traffic via List-Id', () => {
    const result = checkParsedForLoop(
      withHeaders({ 'List-Id': '<faculty.example.edu>' }),
    );
    expect(result.isAutoReply).toBe(true);
    expect(result.reason).toMatch(/List-Id/i);
  });

  it('detects Precedence: list', () => {
    const result = checkParsedForLoop(withHeaders({ Precedence: 'list' }));
    expect(result.isAutoReply).toBe(true);
  });

  it('detects Precedence: bulk', () => {
    const result = checkParsedForLoop(withHeaders({ precedence: 'bulk' }));
    expect(result.isAutoReply).toBe(true);
  });

  it('detects X-Autoreply marker', () => {
    const result = checkParsedForLoop(withHeaders({ 'X-Autoreply': 'yes' }));
    expect(result.isAutoReply).toBe(true);
  });

  it('detects vacation auto-responder via X-Mailer', () => {
    const result = checkParsedForLoop(
      withHeaders({ 'X-Mailer': 'Vacation 2.0 (Gmail)' }),
    );
    expect(result.isAutoReply).toBe(true);
  });

  it('does not flag a normal X-Mailer (Outlook)', () => {
    const result = checkParsedForLoop(
      withHeaders({ 'X-Mailer': 'Microsoft Outlook 16.0' }),
    );
    expect(result.isAutoReply).toBe(false);
  });

  it('handles structured header values from mailparser ({value} shape)', () => {
    const headers = new Map<string, unknown>([
      ['auto-submitted', { value: 'auto-replied', params: {} }],
    ]);
    const result = checkParsedForLoop({ headers });
    expect(result.isAutoReply).toBe(true);
  });

  it('handles array-shaped header values', () => {
    const headers = new Map<string, unknown>([
      ['list-unsubscribe', ['<mailto:unsub@x.com>', '<https://x.com/u>']],
    ]);
    const result = checkParsedForLoop({ headers });
    expect(result.isAutoReply).toBe(true);
  });

  it('returns false when headers map is missing', () => {
    expect(checkParsedForLoop({}).isAutoReply).toBe(false);
  });

  // Regression: the real ingest path parses with mailparser, which folds
  // List-Id / List-Unsubscribe into a single structured `list` header rather
  // than exposing them under their raw names. Surfaced by the S04 capability
  // scenario — the raw-name rules alone let real listserv traffic through.
  it('detects mailparser structured list header by id', () => {
    const headers = new Map<string, unknown>([
      ['list', { id: { name: 'Program Faculty', id: 'faculty.example.edu' } }],
    ]);
    const result = checkParsedForLoop({ headers });
    expect(result.isAutoReply).toBe(true);
    expect(result.reason).toMatch(/List-Id/i);
  });

  it('detects mailparser structured list header by unsubscribe', () => {
    const headers = new Map<string, unknown>([
      ['list', { unsubscribe: { mail: 'unsub@example.edu' } }],
    ]);
    expect(checkParsedForLoop({ headers }).isAutoReply).toBe(true);
  });
});

// With the SMTP provider a bounce arrives as mail to the sending mailbox.
// It must never start work or be answered.
describe('checkParsedForLoop: delivery reports (bounces)', () => {
  const DSN = [
    'Return-Path: <>',
    'From: Mail Delivery Subsystem <MAILER-DAEMON@example.edu>',
    'To: program@example.org',
    'Subject: Undeliverable: Test subject',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    'MIME-Version: 1.0',
    '',
    '--b1',
    'Content-Type: text/plain',
    '',
    'Your message could not be delivered.',
    '--b1',
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; person@example.edu',
    'Action: failed',
    'Status: 5.1.1',
    '--b1--',
    '',
  ].join('\r\n');

  it('drops a parsed RFC 3464 delivery report', async () => {
    const result = checkParsedForLoop(await simpleParser(DSN));
    expect(result.isAutoReply).toBe(true);
    expect(result.reason).toMatch(/multipart\/report/);
  });

  it('each bounce marker is enough on its own', async () => {
    const plainBody = '\r\n\r\nYour message could not be delivered.\r\n';
    const variants = [
      'Return-Path: <>\r\nFrom: Notices <notices@example.edu>',
      'From: Mail Delivery Subsystem <mailer-daemon@example.edu>',
      'From: postmaster@example.edu',
      'From: Notices <notices@example.edu>\r\nX-Failed-Recipients: person@example.edu',
    ];
    for (const head of variants) {
      const parsed = await simpleParser(
        `${head}\r\nTo: program@example.org\r\nSubject: Undeliverable${plainBody}`,
      );
      expect(checkParsedForLoop(parsed).isAutoReply, head).toBe(true);
    }
  });

  it('detects the markers in hand-built string headers too', () => {
    expect(
      checkParsedForLoop(
        withHeaders({
          'content-type': 'multipart/report; report-type=delivery-status',
        }),
      ).isAutoReply,
    ).toBe(true);
    expect(
      checkParsedForLoop(withHeaders({ 'return-path': '<>' })).isAutoReply,
    ).toBe(true);
    expect(
      checkParsedForLoop(
        withHeaders({ from: '"Mail System" <MAILER-DAEMON@example.edu>' }),
      ).isAutoReply,
    ).toBe(true);
  });

  it('does not flag ordinary mail: a real return path, a person, other content types', async () => {
    const parsed = await simpleParser(
      [
        'Return-Path: <paige@example.edu>',
        'From: Paige <paige@example.edu>',
        'To: program@example.org',
        'Subject: question about the postmaster@example.edu address',
        'Content-Type: multipart/mixed; boundary="b2"',
        '',
        '--b2',
        'Content-Type: text/plain',
        '',
        'Who reads postmaster@example.edu?',
        '--b2--',
        '',
      ].join('\r\n'),
    );
    expect(checkParsedForLoop(parsed).isAutoReply).toBe(false);
    expect(
      checkParsedForLoop(
        withHeaders({ from: 'not-the-postmaster@example.edu' }),
      ).isAutoReply,
    ).toBe(false);
  });
});
