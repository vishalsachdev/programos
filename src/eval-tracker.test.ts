import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestEvalDb,
  extractEval,
  recordEval,
  getEvalSummary,
  exportEvalReport,
} from './eval-tracker.js';

beforeEach(() => {
  _initTestEvalDb();
});

describe('extractEval', () => {
  it('extracts valid eval from internal block', () => {
    const raw =
      'Hello user! <internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":["curriculum"],"notes":"found in CURRICULUM.md"}</eval></internal>';
    const result = extractEval(raw);
    expect(result).toEqual({
      confidence: 'high',
      has_citation: true,
      category: 'question',
      topics: ['curriculum'],
      eval_notes: 'found in CURRICULUM.md',
    });
  });

  it('returns null when no eval block present', () => {
    expect(extractEval('Hello user!')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    const raw = '<internal><eval>{not valid json}</eval></internal>';
    expect(extractEval(raw)).toBeNull();
  });

  it('requires <internal> wrapper — bare <eval> is ignored', () => {
    const raw = '<eval>{"confidence":"high"}</eval>';
    expect(extractEval(raw)).toBeNull();
  });

  it('uses last match when multiple eval blocks exist', () => {
    const raw = [
      'Here is an example: <internal><eval>{"confidence":"low","has_citation":false,"category":"question","topics":["example"]}</eval></internal>',
      'My actual response.',
      '<internal><eval>{"confidence":"high","has_citation":true,"category":"status_update","topics":["real"]}</eval></internal>',
    ].join('\n');
    const result = extractEval(raw);
    expect(result?.confidence).toBe('high');
    expect(result?.category).toBe('status_update');
    expect(result?.topics).toEqual(['real']);
  });

  it('defaults confidence to medium for invalid values', () => {
    const raw =
      '<internal><eval>{"confidence":"super","has_citation":true,"category":"question","topics":[]}</eval></internal>';
    const result = extractEval(raw);
    expect(result?.confidence).toBe('medium');
  });

  it('defaults category to question for invalid values', () => {
    const raw =
      '<internal><eval>{"confidence":"high","has_citation":true,"category":"invalid","topics":[]}</eval></internal>';
    const result = extractEval(raw);
    expect(result?.category).toBe('question');
  });

  it('parses has_citation strictly — string "false" is false', () => {
    const raw =
      '<internal><eval>{"confidence":"high","has_citation":"false","category":"question","topics":[]}</eval></internal>';
    const result = extractEval(raw);
    expect(result?.has_citation).toBe(false);
  });

  it('parses has_citation strictly — only boolean true counts', () => {
    const raw =
      '<internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":[]}</eval></internal>';
    const result = extractEval(raw);
    expect(result?.has_citation).toBe(true);
  });

  it('truncates topics to max 5 entries and 50 chars', () => {
    const topics = Array.from(
      { length: 10 },
      (_, i) => `topic-${i}-${'x'.repeat(60)}`,
    );
    const raw = `<internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":${JSON.stringify(topics)}}</eval></internal>`;
    const result = extractEval(raw);
    expect(result?.topics).toHaveLength(5);
    expect(result?.topics[0]).toHaveLength(50);
  });

  it('truncates notes to max 500 chars', () => {
    const notes = 'x'.repeat(1000);
    const raw = `<internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":[],"notes":"${notes}"}</eval></internal>`;
    const result = extractEval(raw);
    expect(result?.eval_notes).toHaveLength(500);
  });

  it('filters non-string topics', () => {
    const raw =
      '<internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":["valid",123,null,"also-valid"]}</eval></internal>';
    const result = extractEval(raw);
    expect(result?.topics).toEqual(['valid', 'also-valid']);
  });
});

describe('recordEval + getEvalSummary', () => {
  it('records and summarizes evals', () => {
    recordEval(
      'webhook-email@program',
      'Reply text <internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":["curriculum"]}</eval></internal>',
      100,
    );
    recordEval(
      'tg-program@program',
      'Reply <internal><eval>{"confidence":"low","has_citation":false,"category":"question","topics":["admissions"],"notes":"no info found"}</eval></internal>',
      50,
    );

    const since = new Date(Date.now() - 60000).toISOString();
    const summary = getEvalSummary(since);

    expect(summary.total).toBe(2);
    expect(summary.by_confidence['high']).toBe(1);
    expect(summary.by_confidence['low']).toBe(1);
    expect(summary.by_channel['email']).toBe(1);
    expect(summary.by_channel['telegram']).toBe(1);
    expect(summary.citation_rate).toBe(0.5);
    expect(summary.avg_response_length).toBe(75);
    expect(summary.low_confidence_entries).toHaveLength(1);
    expect(summary.low_confidence_entries[0].eval_notes).toBe('no info found');
    expect(summary.top_topics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: 'curriculum', count: 1 }),
        expect.objectContaining({ topic: 'admissions', count: 1 }),
      ]),
    );
  });

  it('returns empty summary for no data', () => {
    const summary = getEvalSummary('2099-01-01T00:00:00Z');
    expect(summary.total).toBe(0);
    expect(summary.citation_rate).toBe(0);
  });

  it('skips recording when no eval block present', () => {
    recordEval('webhook-email@program', 'Plain reply with no eval', 100);
    const summary = getEvalSummary(new Date(Date.now() - 60000).toISOString());
    expect(summary.total).toBe(0);
  });
});

describe('exportEvalReport', () => {
  it('produces markdown report', () => {
    recordEval(
      'webhook-email@program',
      'Reply <internal><eval>{"confidence":"high","has_citation":true,"category":"question","topics":["test"]}</eval></internal>',
      100,
    );

    const since = new Date(Date.now() - 60000).toISOString();
    const report = exportEvalReport(since);

    expect(report).toContain('# Quality Review Data');
    expect(report).toContain('**Total responses evaluated:** 1');
    expect(report).toContain('high: 1');
    expect(report).toContain('Citation rate: 100%');
    expect(report).toContain('test: 1 mentions');
  });

  it('handles empty data', () => {
    const report = exportEvalReport('2099-01-01T00:00:00Z');
    expect(report).toContain('**Total responses evaluated:** 0');
  });
});
