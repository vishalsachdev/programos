import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { stripMarkdown } from './email-format.js';
const { stripMarkdown: stripRunnerMarkdown } = (await import(
  new URL('../container/agent-runner/src/email-format.ts', import.meta.url).href
)) as { stripMarkdown: typeof stripMarkdown };

for (const [name, format] of [
  ['host', stripMarkdown],
  ['runner', stripRunnerMarkdown],
] as const) {
  describe(`${name} outgoing Markdown links`, () => {
    it.each([
      [
        'Read [guide](https://example.com).',
        'Read guide (https://example.com).',
      ],
      ['[a](x)[b](y)', 'a (x)b (y)'],
      ['[[label](url)', '[label (url)'],
      ['[](url) [label]()', '[](url) [label]()'],
      ['[label] (url) [label](unfinished', '[label] (url) [label](unfinished'],
      ['[bad] then [good](url)', '[bad] then good (url)'],
      ['[bad]( [good](url)', 'bad ( [good](url)'],
      ['[label](a(b)c)', 'label (a(b)c)'],
      ['[line\nbreak](multi\nline)', 'line\nbreak (multi\nline)'],
      [
        'Plain text, Unicode α🙂 and [brackets].',
        'Plain text, Unicode α🙂 and [brackets].',
      ],
      [
        '# Title\n**Bold** and *italic*, _word_ and `code`\n- [guide](url)',
        'Title\nBold and italic, word and code\n- guide (url)',
      ],
    ])('preserves existing output for %j', (input, expected) => {
      expect(format(input)).toBe(expected);
    });

    it('matches the legacy link grammar on bounded generated strings', () => {
      const alphabet = '[]()ab';
      // Exhaust short delimiter combinations; never run the old regex on
      // the large performance fixtures.
      for (let length = 0; length <= 6; length++) {
        for (let value = 0; value < alphabet.length ** length; value++) {
          let remaining = value;
          let input = '';
          for (let i = 0; i < length; i++) {
            input += alphabet[remaining % alphabet.length];
            remaining = Math.floor(remaining / alphabet.length);
          }
          expect(format(input)).toBe(
            input.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)'),
          );
        }
      }
    });

    it.each([
      ['opening brackets', '['.repeat(128_000)],
      ['unterminated label', '['.repeat(128_000) + 'label](url'],
      ['unterminated destinations', '[label]('.repeat(16_000)],
      ['empty destinations', '[label]()'.repeat(16_000)],
    ])('formats long %s within a generous event-loop budget', (_, input) => {
      const start = performance.now();
      const output = format(input);
      const elapsed = performance.now() - start;
      expect(output).toBe(input);
      // Loose enough for CI, but rejects the multi-second quadratic baseline.
      expect(elapsed).toBeLessThan(500);
    });
  });
}
