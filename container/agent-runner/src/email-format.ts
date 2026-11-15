// CommonMark underscore delimiters cannot open/close inside a word. In
// particular, advisor_@ is closing-only and other_person is neither: they
// must never pair with underscores in a different address or host note.
function stripUnderscoreEmphasis(text: string): string {
  const delimiters: Array<{ start: number; end: number; remove: boolean }> = [];
  const openers = new Map<number, Array<(typeof delimiters)[number]>>();
  const whitespace = (char: string | undefined) =>
    char === undefined || /\s/u.test(char);
  const punctuation = (char: string | undefined) =>
    char !== undefined && /[\p{P}\p{S}]/u.test(char);
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '_') {
      i++;
      continue;
    }
    const start = i;
    while (text[i] === '_') i++;
    const length = i - start;
    if (length !== 1 && length !== 2) continue;
    const before = text[start - 1];
    const after = text[i];
    const leftFlanking =
      !whitespace(after) &&
      (!punctuation(after) || whitespace(before) || punctuation(before));
    const rightFlanking =
      !whitespace(before) &&
      (!punctuation(before) || whitespace(after) || punctuation(after));
    const canOpen = leftFlanking && (!rightFlanking || punctuation(before));
    const canClose = rightFlanking && (!leftFlanking || punctuation(after));
    const delimiter = { start, end: i, remove: false };
    delimiters.push(delimiter);
    const stack = openers.get(length) ?? [];
    openers.set(length, stack);
    if (canClose && stack.length) {
      stack.pop()!.remove = true;
      delimiter.remove = true;
    } else if (canOpen) stack.push(delimiter);
  }
  const parts: string[] = [];
  let last = 0;
  for (const delimiter of delimiters) {
    if (!delimiter.remove) continue;
    parts.push(text.slice(last, delimiter.start));
    last = delimiter.end;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

// Match the legacy link grammar without retrying overlapping label suffixes.
// A label ends at the first ]; its destination ends at the first ). Both
// must be nonempty. Nested opening brackets remain literal label text.
function stripMarkdownLinks(text: string): string {
  const parts: string[] = [];
  let labelStart = -1;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && labelStart === -1) labelStart = i;
    if (text[i] !== ']') continue;
    if (labelStart !== -1 && i > labelStart + 1 && text[i + 1] === '(') {
      const destinationStart = i + 2;
      const destinationEnd = text.indexOf(')', destinationStart);
      // No later link can complete either: there is no remaining ).
      if (destinationEnd === -1) break;
      if (destinationEnd > destinationStart) {
        parts.push(
          text.slice(last, labelStart),
          text.slice(labelStart + 1, i),
          ' (',
          text.slice(destinationStart, destinationEnd),
          ')',
        );
        last = destinationEnd + 1;
        i = destinationEnd;
      }
    }
    // A ] disqualifies every preceding opener, even on a malformed link.
    labelStart = -1;
  }
  parts.push(text.slice(last));
  return parts.join('');
}

// Strip Markdown syntax so the body reads cleanly as plain text.
// Used for outgoing email until example.org domain reputation is
// good enough that HTML emails clear EXU Proofpoint without being
// flagged as phishing.
export function stripMarkdown(text: string): string {
  return stripMarkdownLinks(
    stripUnderscoreEmphasis(
      text
        .replace(/^#{1,6}\s+/gm, '') // headers
        .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
        .replace(/\*([^*]+)\*/g, '$1'),
    ) // italic
      .replace(/`{3}[\s\S]*?`{3}/g, '') // fenced code blocks
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/^\s*[-*+]\s+/gm, '- ') // bullets → dashes
      .replace(/^\s*>\s?/gm, ''), // blockquotes
  ).trim();
}
