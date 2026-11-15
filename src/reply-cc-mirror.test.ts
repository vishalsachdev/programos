import { describe, expect, it } from 'vitest';

import { mirrorReplyCc } from './reply-cc-mirror.js';
import type { CcContextResult } from './cc-context.js';
import type { EmailAllowlistState } from './channels/webhook-allowlist.js';

const state = (senders: string[], available = true): EmailAllowlistState => ({
  available,
  senders: new Set(senders),
  source: 'program/EMAIL_ALLOWLIST.md',
});

const directCtx = (over: Partial<CcContextResult> = {}): CcContextResult => ({
  realTo: 'Coordinator <program@example.org>, Avery Morgan <avery@example.edu>',
  realCc: '"Stone, Felix" <fstone@example.edu>, Someone <stranger@gmail.com>',
  ccOnly: false,
  botInTo: true,
  suppressAck: false,
  reason: 'bot in To — direct mail',
  ...over,
});

describe('mirrorReplyCc (G58)', () => {
  it('CCs allowlisted thread audience, drops the rest with a body note', () => {
    const result = mirrorReplyCc({
      ccContext: directCtx(),
      sender: 'avery@example.edu',
      allowlistState: state(['avery@example.edu', 'fstone@example.edu']),
      fallbackMode: 'closed',
    });
    expect(result.cc).toEqual(['fstone@example.edu']);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].address).toBe('stranger@gmail.com');
    expect(result.note).toContain('stranger@gmail.com');
    expect(result.note).toContain('not copied');
  });

  it('no note when nobody is dropped', () => {
    const result = mirrorReplyCc({
      ccContext: directCtx({ realCc: 'Felix <fstone@example.edu>' }),
      sender: 'avery@example.edu',
      allowlistState: state(['avery@example.edu', 'fstone@example.edu']),
      fallbackMode: 'closed',
    });
    expect(result.cc).toEqual(['fstone@example.edu']);
    expect(result.dropped).toEqual([]);
    expect(result.note).toBeUndefined();
  });

  it('empty when botInTo is not true (cc-only, ambiguity, pre-G58 metadata)', () => {
    for (const ctx of [
      undefined,
      directCtx({ botInTo: false }),
      directCtx({ botInTo: undefined }),
    ]) {
      const result = mirrorReplyCc({
        ccContext: ctx,
        sender: 'avery@example.edu',
        allowlistState: state(['fstone@example.edu']),
        fallbackMode: 'closed',
      });
      expect(result).toEqual({ cc: [], dropped: [] });
    }
  });

  it('excludes the sender and every bot address, case-insensitively', () => {
    const result = mirrorReplyCc({
      ccContext: directCtx({
        realTo: 'Coordinator <PROGRAM@example.org>, AVERY@example.edu',
        realCc: 'Avery Morgan <avery@example.edu>',
      }),
      sender: 'Avery@example.edu',
      allowlistState: state(['avery@example.edu']),
      fallbackMode: 'closed',
    });
    expect(result.cc).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('excludes a display-form sender ("Name <addr>")', () => {
    const result = mirrorReplyCc({
      ccContext: directCtx({ realCc: 'avery@example.edu' }),
      sender: 'Avery Morgan <Avery@example.edu>',
      allowlistState: state(['avery@example.edu']),
      fallbackMode: 'closed',
    });
    expect(result.cc).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('dedupes addresses appearing in both To and Cc', () => {
    const result = mirrorReplyCc({
      ccContext: directCtx({
        realTo: 'program@example.org, fstone@example.edu',
        realCc: '"Stone, Felix" <fstone@example.edu>',
      }),
      sender: 'avery@example.edu',
      allowlistState: state(['fstone@example.edu']),
      fallbackMode: 'closed',
    });
    expect(result.cc).toEqual(['fstone@example.edu']);
  });

  it('fails closed when the allowlist is unavailable, even in permissive mode', () => {
    // Permissive fallback exists so a reply to the SENDER is not refused;
    // it must never widen third-party CC reach when the list is unreadable.
    const result = mirrorReplyCc({
      ccContext: directCtx({ realCc: 'fstone@example.edu' }),
      sender: 'avery@example.edu',
      allowlistState: state([], false),
      fallbackMode: 'permissive',
    });
    expect(result.cc).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain('unavailable');
    expect(result.note).toContain('fstone@example.edu');
  });
});
