import { expect, it } from 'vitest';
const { describeSendPrecheck } = await import(
  new URL('../container/agent-runner/src/allowlist-check.ts', import.meta.url)
    .href
);
const allowlistText = '| Name | Email |\n| Avery | avery@example.edu |';
// Catches a send_email tool result that promises delivery despite unverified body addresses.
it('warns that an untrusted body address refuses the whole send', () => {
  const warning = describeSendPrecheck({
    to: 'avery@example.edu',
    body: '<a href="mailto:AMORGAN@example.edu">Avery</a>',
    allowlistText,
  });
  // R5: preserve the complete raw attribute token in the warning, including its case.
  expect(warning).toContain('href="mailto:AMORGAN@example.edu"');
  expect(warning).toContain('WHOLE send');
});
// Catches exempting unverified quoted addresses from container warnings.
it('accepts trusted uppercase addresses and checks quoted addresses', () => {
  expect(
    describeSendPrecheck({
      to: 'avery@example.edu',
      body: 'AVERY@example.edu\n> avery@example.edu',
      allowlistText,
    }),
  ).toBe('');
});

// Catches the container warning check still mistaking web URL handles for email addresses.
it('ignores URL handles in the container precheck without hiding mailto targets', () => {
  const body =
    'https://medium.com/@jane.writer/post https://www.youtube.com/@handle.name www.youtube.com/@handle.name';
  expect(
    describeSendPrecheck({ to: 'avery@example.edu', body, allowlistText }),
  ).toBe('');
  expect(
    describeSendPrecheck({
      to: 'avery@example.edu',
      body: `${body} <a href="mailto:unknown@example.edu">Contact</a>`,
      allowlistText,
    }),
  ).toContain('unknown@example.edu');
});

// R6-1: a www. mailbox has no URL path and must be checked exactly.
it('warns on untrusted www. mailbox identities', () => {
  expect(
    describeSendPrecheck({
      to: 'avery@example.edu',
      body: 'www.contact@example.edu',
      allowlistText,
    }),
  ).toContain('www.contact@example.edu');
});

// R1-5: catches the container precheck checking wrappers the host formatter will remove.
it('checks formatter output for underscore, star, backtick and code-fence wrappers', () => {
  for (const body of [
    '__avery@example.edu__',
    '_avery@example.edu_',
    '**avery@example.edu**',
    '`avery@example.edu`',
    'Reminder.\n```\ninvented@example.org\n```',
  ]) {
    expect(
      describeSendPrecheck({ to: 'avery@example.edu', body, allowlistText }),
    ).toBe('');
  }
  expect(
    describeSendPrecheck({
      to: 'avery@example.edu',
      body: '__invented@example.org__',
      allowlistText,
    }),
  ).toContain('invented@example.org');
});
