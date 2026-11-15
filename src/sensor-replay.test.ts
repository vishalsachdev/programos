import { describe, expect, it } from 'vitest';

import {
  extractReplayReply,
  readReplaySource,
  selectReplayCases,
  scoreReplayCase,
} from './sensor-replay.js';

describe('scoreReplayCase', () => {
  it('passes when two of three verdicts are allowed', () => {
    expect(scoreReplayCase(['pass', 'flag'], ['fail', 'pass', 'flag'])).toEqual(
      { passed: true, matches: 2, runs: 3 },
    );
  });

  it('fails when fewer than two verdicts are allowed', () => {
    expect(scoreReplayCase(['pass'], ['pass', 'fail', 'error'])).toEqual({
      passed: false,
      matches: 1,
      runs: 3,
    });
  });

  it('rejects a replay result that does not contain exactly three runs', () => {
    expect(() => scoreReplayCase(['pass'], ['pass', 'pass'])).toThrow(
      'exactly three',
    );
  });
});

describe('extractReplayReply', () => {
  const triage = `## 10:00:00 — factual

### Outbound response under review

First historical response.

### Citation check

\`\`\`
(none)
\`\`\`

---
## 11:00:00 — citation

### Outbound response under review

Second historical response.

### Citation check
`;

  it('extracts the exact response under the requested triage heading', () => {
    expect(extractReplayReply(triage, '11:00:00')).toBe(
      'Second historical response.',
    );
  });

  it('fails loudly when the historical heading is absent', () => {
    expect(() => extractReplayReply(triage, '12:00:00')).toThrow('12:00:00');
  });
});

describe('readReplaySource', () => {
  it('follows an active triage file when weekly cleanup moves it to done', () => {
    const files = new Map([
      [
        'discussions/kb-triage/done/2026-08-17-response-error.md',
        'archived triage',
      ],
    ]);

    expect(
      readReplaySource(
        'discussions/kb-triage/2026-08-17-response-error.md',
        (file) => files.get(file) ?? null,
      ),
    ).toBe('archived triage');
  });

  it('does not invent fallback locations for unrelated files', () => {
    expect(() => readReplaySource('program/CURRICULUM.md', () => null)).toThrow(
      'program/CURRICULUM.md',
    );
  });
});

describe('selectReplayCases', () => {
  const cases = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('keeps the complete suite when no case filter is supplied', () => {
    expect(selectReplayCases(cases)).toEqual(cases);
  });

  it('selects requested case ids and rejects unknown ids', () => {
    expect(selectReplayCases(cases, ['c', 'a'])).toEqual([
      { id: 'a' },
      { id: 'c' },
    ]);
    expect(() => selectReplayCases(cases, ['missing'])).toThrow('missing');
  });
});
