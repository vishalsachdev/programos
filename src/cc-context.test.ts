import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  analyzeCcContext,
  botAddresses,
  detectDirectRequest,
  extractAddresses,
  mergeSuppressDecision,
  type CcContextResult,
} from './cc-context.js';

const tempFiles: string[] = [];

function writeEml(lines: string[]): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cc-context-test-')),
    'mail.eml',
  );
  fs.writeFileSync(file, lines.join('\r\n'));
  tempFiles.push(path.dirname(file));
  return file;
}

function eml(headers: Record<string, string>, body: string): string {
  return writeEml([
    'From: Avery Morgan <avery@example.edu>',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    'Subject: test',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ]);
}

afterEach(() => {
  for (const dir of tempFiles.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('extractAddresses', () => {
  it('pulls bare lowercased addresses out of display-form lists', () => {
    expect(
      extractAddresses(
        '"Stone, Felix" <fstone@example.edu>, Coordinator <PROGRAM@example.org>',
      ),
    ).toEqual(['fstone@example.edu', 'program@example.org']);
  });

  it('returns empty for undefined', () => {
    expect(extractAddresses(undefined)).toEqual([]);
  });

  it('ignores email-like substrings in quoted display names', () => {
    // A crafted display name must not smuggle a third party into the
    // G58 mirrored audience (or spoof bot detection for G56).
    expect(
      extractAddresses('"dean@example.edu" <program@example.org>'),
    ).toEqual(['program@example.org']);
  });

  it('ignores email-like substrings in comments', () => {
    expect(extractAddresses('(was dean@example.edu) real@example.edu')).toEqual(
      ['real@example.edu'],
    );
  });

  it('unquoted display name text next to an angle address is not a recipient', () => {
    expect(extractAddresses('dean@example.edu <program@example.org>')).toEqual([
      'program@example.org',
    ]);
  });

  it('handles semicolon-separated lists', () => {
    expect(
      extractAddresses(
        'Chen <lchen12@example.edu>; Coordinator <program@example.org>',
      ),
    ).toEqual(['lchen12@example.edu', 'program@example.org']);
  });
});

describe('detectDirectRequest', () => {
  it('third-person mentions are not requests (primer replay)', () => {
    // Body text of a campaign mail — the
    // exact mail class whose acks R2 exists to silence. It mentions Coordinator
    // twice, both third-person.
    const primer = [
      'The site page carries the full research base behind the design, and',
      'Coordinator can walk anyone through the decision history on request.',
      'The primer also framed the program in the context of the',
      'draft priorities and invited faculty to ask Coordinator about the',
      'research behind the framework and to send it articles they read.',
      'Copying Omar and Dana for visibility, and Coordinator so this lands in the',
      'program memory.',
    ].join('\n');
    expect(detectDirectRequest(primer)).toBe(false);
  });

  it('a question naming Coordinator is a request', () => {
    expect(
      detectDirectRequest(
        'Coordinator, can you summarize where CRS 554 stands?',
      ),
    ).toBe(true);
    expect(
      detectDirectRequest(
        'Could Coordinator pull the decision history for this?',
      ),
    ).toBe(true);
  });

  it('address-form imperative is a request even without a question mark', () => {
    expect(
      detectDirectRequest('Coordinator, could you add wren on the allowlist.'),
    ).toBe(true);
    expect(
      detectDirectRequest('Hi Coordinator: please file this thread.'),
    ).toBe(true);
  });

  it('unpunctuated imperatives naming Coordinator are requests (codex R1 P1)', () => {
    expect(detectDirectRequest('Coordinator please file this update')).toBe(
      true,
    );
    expect(
      detectDirectRequest('Coordinator could you log this for the record.'),
    ).toBe(true);
    expect(
      detectDirectRequest('Coordinator you should record this decision.'),
    ).toBe(true);
  });

  it('third-person "can/will" without "you" is not a request', () => {
    expect(
      detectDirectRequest(
        'Coordinator can walk anyone through the decision history.',
      ),
    ).toBe(false);
    expect(
      detectDirectRequest('Coordinator will pick this up from the Cc.'),
    ).toBe(false);
    expect(detectDirectRequest('Coordinator is copied for the record.')).toBe(
      false,
    );
  });

  it('questions not involving Coordinator are not requests', () => {
    expect(
      detectDirectRequest(
        'Felix, could you confirm the timeline? Coordinator is copied for the record.',
      ),
    ).toBe(false);
  });
});

describe('analyzeCcContext', () => {
  it('defaults to ack when no .eml is available', async () => {
    const result = await analyzeCcContext(null);
    expect(result.suppressAck).toBe(false);
    expect(result.ccOnly).toBe(false);
  });

  it('acks when the bot is in To (direct mail)', async () => {
    const file = eml(
      {
        To: 'Coordinator <program@example.org>, "Stone, Felix" <fstone@example.edu>',
      },
      'Coordinator, could you add wren on the allowlist',
    );
    const result = await analyzeCcContext(file);
    expect(result.ccOnly).toBe(false);
    expect(result.suppressAck).toBe(false);
    expect(result.realTo).toContain('program@example.org');
  });

  it('suppresses for cc-only context mail (ELC 550 incident shape)', async () => {
    // Shape of an ELC 550 outreach: To two faculty, bot in Cc,
    // body about the faculty (mentions Coordinator only in third person). The old
    // pipeline had Coordinator compose an audience-facing self-intro that
    // `to: meta.from` silently redirected to Avery.
    const file = eml(
      {
        To: 'Lin Chen <lchen12@example.edu>, Jonas Berg <berg@example.edu>',
        Cc: 'Coordinator <program@example.org>',
      },
      [
        'Hi Lin and Jonas,',
        'A heads-up on ELC 550 production timelines. Coordinator is copied so this',
        'lands in the program memory. T&L will follow up on studio slots.',
      ].join('\n'),
    );
    const result = await analyzeCcContext(file);
    expect(result.ccOnly).toBe(true);
    expect(result.suppressAck).toBe(true);
    expect(result.realTo).toContain('lchen12@example.edu');
    expect(result.realCc).toContain('program@example.org');
  });

  it('acks cc-only mail that directly asks Coordinator something', async () => {
    const file = eml(
      {
        To: '"Stone, Felix" <fstone@example.edu>',
        Cc: 'program@example.org',
      },
      'Felix, looping you in. Coordinator, can you pull the assessment decision history?',
    );
    const result = await analyzeCcContext(file);
    expect(result.ccOnly).toBe(true);
    expect(result.suppressAck).toBe(false);
  });

  it('acks when the bot appears in neither header (alias/bcc delivery)', async () => {
    const file = eml(
      { To: '"Stone, Felix" <fstone@example.edu>' },
      'FYI only.',
    );
    const result = await analyzeCcContext(file);
    expect(result.ccOnly).toBe(false);
    expect(result.suppressAck).toBe(false);
  });

  it('ignores quoted Cc: lines in the body (codex R1 P1)', async () => {
    // A reply whose real headers have no Cc at all, but whose quoted chain
    // contains "Cc: program@example.org" verbatim (standard Outlook quoting)
    // — must NOT classify as cc-only.
    const file = eml(
      { To: '"Stone, Felix" <fstone@example.edu>' },
      [
        'Sounds good, will do.',
        '',
        'From: Morgan, Avery <avery@example.edu>',
        'To: Stone, Felix <fstone@example.edu>',
        'Cc: Coordinator <program@example.org>',
        'Subject: Re: assessment primer',
        '',
        'Original message text here.',
      ].join('\n'),
    );
    const result = await analyzeCcContext(file);
    expect(result.ccOnly).toBe(false);
    expect(result.suppressAck).toBe(false);
    expect(result.realCc).toBeUndefined();
  });

  it('handles folded multi-line Cc headers', async () => {
    const file = eml(
      {
        To: '"Stone, Felix" <fstone@example.edu>',
        Cc: '"Haddad, Omar Lee" <ohaddad@example.edu>,\r\n "program@example.org" <program@example.org>',
      },
      'Status update for the record. No questions.',
    );
    const result = await analyzeCcContext(file);
    expect(result.ccOnly).toBe(true);
    expect(result.suppressAck).toBe(true);
  });
});

describe('detectDirectRequest — bot addressed by email address (codex R2 P1)', () => {
  it('imperative via the address is a request', () => {
    expect(detectDirectRequest('program@example.org, please file this')).toBe(
      true,
    );
    expect(
      detectDirectRequest('program@example.org can you log the decision'),
    ).toBe(true);
  });

  it('a bare address mention is not a request', () => {
    expect(
      detectDirectRequest('Copying program@example.org for the record.'),
    ).toBe(false);
  });
});

describe('analyzeCcContext — truncated .eml (codex P2, eml_file_path review)', () => {
  it('cc-only mail in a truncated .eml acks on ambiguity — the direct request may be past the cut', async () => {
    const file = eml(
      {
        To: 'Lin Chen <lchen12@example.edu>',
        Cc: 'Coordinator <program@example.org>',
      },
      [
        'Long thread body, Coordinator is copied for the record.',
        '[truncated by email-inbox worker]',
      ].join('\r\n'),
    );
    const result = await analyzeCcContext(file);
    expect(result.ccOnly).toBe(true);
    expect(result.suppressAck).toBe(false);
    expect(result.reason).toContain('truncated');
  });

  it('truncation does not disturb direct-mail header recovery (headers precede the cut)', async () => {
    const file = eml(
      {
        To: 'Coordinator <program@example.org>',
        Cc: 'Lin Chen <lchen12@example.edu>',
      },
      'Question body\r\n[truncated by email-inbox worker]',
    );
    const result = await analyzeCcContext(file);
    expect(result.botInTo).toBe(true);
    expect(result.suppressAck).toBe(false);
  });
});

describe('analyzeCcContext — botInTo (G58 reply-CC mirror precondition)', () => {
  it('true when the bot is in the real To header', async () => {
    const file = eml(
      {
        To: 'Coordinator <program@example.org>, "Stone, Felix" <fstone@example.edu>',
        Cc: 'Rowan User110b <user110@example.edu>',
      },
      'Coordinator, could you summarize where CRS 554 stands?',
    );
    const result = await analyzeCcContext(file);
    expect(result.botInTo).toBe(true);
  });

  it('false when the bot is cc-only', async () => {
    const file = eml(
      {
        To: 'Lin Chen <lchen12@example.edu>',
        Cc: 'Coordinator <program@example.org>',
      },
      'Heads-up on ELC 550. Coordinator is copied for the record.',
    );
    const result = await analyzeCcContext(file);
    expect(result.botInTo).toBe(false);
  });

  it('falsy on every ambiguity path (no eml, no headers)', async () => {
    expect((await analyzeCcContext(null)).botInTo).toBeFalsy();
    const noHeaders = writeEml(['X-Nothing: here', '', 'body only']);
    expect((await analyzeCcContext(noHeaders)).botInTo).toBeFalsy();
  });
});

describe('mergeSuppressDecision (thread-slot race, codex R2 P1)', () => {
  const suppress: CcContextResult = {
    ccOnly: true,
    suppressAck: true,
    reason: 'cc-only, no direct request — context mail, ack suppressed',
  };
  const ack: CcContextResult = {
    ccOnly: false,
    suppressAck: false,
    reason: 'bot in To — direct mail',
  };

  it('a cc-only copy cannot silence a thread that had direct mail', () => {
    const merged = mergeSuppressDecision(ack, suppress, true);
    expect(merged.suppressAck).toBe(false);
    expect(merged.reason).toContain('previously required an ack');
  });

  it('pre-feature metadata (no ccContext) also forces ack', () => {
    expect(mergeSuppressDecision(undefined, suppress, true).suppressAck).toBe(
      false,
    );
  });

  it('fresh thread keeps the suppress decision', () => {
    expect(mergeSuppressDecision(undefined, suppress, false).suppressAck).toBe(
      true,
    );
  });

  it('a direct message always overwrites to ack', () => {
    expect(mergeSuppressDecision(suppress, ack, true).suppressAck).toBe(false);
  });

  it('a later cc-only copy does not clobber the direct mail audience', () => {
    const direct: CcContextResult = {
      realTo: 'program@example.org, fstone@example.edu',
      realCc: 'user110@example.edu',
      ccOnly: false,
      botInTo: true,
      suppressAck: false,
      reason: 'bot in To — direct mail',
    };
    const ccCopy: CcContextResult = {
      realTo: 'someone@example.edu',
      realCc: 'program@example.org',
      ccOnly: true,
      botInTo: false,
      suppressAck: true,
      reason: 'cc-only, no direct request — context mail, ack suppressed',
    };
    const merged = mergeSuppressDecision(direct, ccCopy, true);
    expect(merged.suppressAck).toBe(false);
    // The batched reply answers the direct mail too — its witnesses must
    // survive the merge or the reply silently ships sender-only.
    expect(merged.botInTo).toBe(true);
    expect(merged.realTo).toBe(direct.realTo);
    expect(merged.realCc).toBe(direct.realCc);
  });

  it('an ambiguity result does NOT inherit the direct mail audience (codex r5 P1)', () => {
    const direct: CcContextResult = {
      realTo: 'program@example.org, fstone@example.edu',
      realCc: 'user110@example.edu',
      ccOnly: false,
      botInTo: true,
      suppressAck: false,
      reason: 'bot in To — direct mail',
    };
    // Shape of every analyzeCcContext ambiguity path (no .eml, unreadable,
    // headers missing): not positively parsed, must stay sender-only.
    const ambiguous: CcContextResult = {
      ccOnly: false,
      suppressAck: false,
      reason: '.eml unreadable — acking',
    };
    const merged = mergeSuppressDecision(direct, ambiguous, true);
    expect(merged.suppressAck).toBe(false);
    expect(merged.botInTo).toBeFalsy();
    expect(merged.realTo).toBeUndefined();
  });

  it('consecutive context copies stay suppressed', () => {
    expect(mergeSuppressDecision(suppress, suppress, true).suppressAck).toBe(
      true,
    );
  });
});

describe('botAddresses', () => {
  it('always includes the canonical address', () => {
    expect(botAddresses()).toContain('program@example.org');
  });
});
