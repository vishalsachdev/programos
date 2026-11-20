import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildIntake, slug } from '../src/mail.js';
import { DEFAULT_INBOX_DIR } from '../src/settings.js';
import { FIXTURES, contract, fixture } from './helpers.js';

const receivedAt = new Date(contract.receivedAt);
const build = (name: string) =>
  buildIntake(
    fixture(`${name}.eml`),
    contract.envelope,
    receivedAt,
    contract.inboxDir,
  );
const eml = (lines: string[]) => new TextEncoder().encode(lines.join('\r\n'));

describe('shared fixtures', () => {
  // The host test feeds these same expected files to the real webhook
  // handler, so this is the worker's half of the payload contract.
  // UPDATE_FIXTURES=1 rewrites them after an intended format change.
  for (const name of contract.cases) {
    it(`${name}: the worker builds exactly the expected Markdown and payload`, async () => {
      const intake = await build(name);
      const mdFile = path.join(FIXTURES, `${name}.expected.md`);
      const jsonFile = path.join(FIXTURES, `${name}.expected.json`);
      if (process.env.UPDATE_FIXTURES === '1') {
        fs.writeFileSync(mdFile, intake.markdown);
        fs.writeFileSync(
          jsonFile,
          JSON.stringify(intake.payload, null, 2) + '\n',
        );
      }
      expect(intake.markdown).toBe(fs.readFileSync(mdFile, 'utf-8'));
      expect(intake.payload).toEqual(
        JSON.parse(fs.readFileSync(jsonFile, 'utf-8')),
      );
    });
  }

  it('the fixture folder is the folder the host reads', () => {
    expect(contract.inboxDir).toBe(DEFAULT_INBOX_DIR);
  });
});

describe('MIME parsing', () => {
  it('reads a multipart message with an attachment and a non-ASCII subject', async () => {
    const { payload, markdown, markdownPath, emlPath } = await build(
      'multipart-attachment',
    );
    expect(payload.subject).toBe('Réunion du comité — budget 2027');
    expect(payload.from).toBe('zmuller@example.edu');
    expect(payload.to).toBe('program@example.org');
    expect(payload.cc).toBe('praman@example.edu, dean-office@example.edu');
    expect(payload.date).toBe('2026-11-19T15:12:00.000Z');
    expect(payload.message_id).toBe('<multi-1119@example.edu>');
    // The file name is ASCII, dated by receipt, and ends in a hash of the bytes.
    expect(payload.filename).toMatch(
      /^2026-11-19-reunion-du-comite-budget-2027-[0-9a-f]{8}\.md$/,
    );
    expect(markdownPath).toBe(`discussions/raw/${payload.filename}`);
    expect(payload.raw_file_path).toBe(markdownPath);
    expect(emlPath).toBe(markdownPath.replace(/\.md$/, '.eml'));
    expect(payload.eml_file_path).toBe(emlPath);

    // The inline logo is listed but not counted.
    expect(payload.attachment_count).toBe(1);
    expect(payload.attachment_state).toBe('ready');
    expect(markdown).toContain('1. `logo.png` (image/png, 17 bytes, inline)');
    expect(markdown).toContain(
      '2. `budget_2027_résumé.pdf` (application/pdf, 58 bytes)',
    );

    // Quoted-printable body with a soft line break, decoded as UTF-8.
    expect(markdown).toContain(
      'Le comité se réunit le 3 décembre. Le budget 2027 est en pièce jointe.',
    );
    expect(markdown).toContain('From: "Zoë Müller" <zmuller@example.edu>');
    expect(markdown).toContain(
      'Cc: "Raman, Priya" <praman@example.edu>, dean-office@example.edu',
    );
    expect(markdown).toContain(
      'References: <first-1117@example.edu> <earlier-1118@example.org>',
    );
    expect(markdown).toContain(`Original message: \`${emlPath}\``);
  });

  it('sends exactly the fields the host handler reads, and no message body', async () => {
    const { payload } = await build('plain-question');
    expect(Object.keys(payload).sort()).toEqual([
      'attachment_count',
      'attachment_state',
      'auth',
      'cc',
      'date',
      'eml_file_path',
      'filename',
      'from',
      'message_id',
      'raw_file_path',
      'subject',
      'to',
    ]);
    expect(payload.attachment_count).toBe(0);
    expect(JSON.stringify(payload)).not.toContain(
      'capstone proposal due this term',
    );
  });

  it('copies the headers the host loop guard checks into the Markdown copy', async () => {
    const { markdown } = await build('auto-reply');
    const headerBlock = markdown.split('\n\n')[0];
    expect(headerBlock).toContain('Auto-Submitted: auto-replied');
  });

  it('builds the same result on a retry', async () => {
    expect(await build('routed-approval')).toEqual(
      await build('routed-approval'),
    );
  });

  it('uses the From header address, not the envelope sender', async () => {
    const { payload } = await build('plain-question');
    expect(contract.envelope.from).not.toBe('praman@example.edu');
    expect(payload.from).toBe('praman@example.edu');
  });

  it('falls back to the envelope and a placeholder subject when headers are missing', async () => {
    const { payload, markdown } = await buildIntake(
      eml(['MIME-Version: 1.0', '', 'Body only.', '']),
      { from: 'Sender@Example.EDU', to: 'program@example.org' },
      receivedAt,
      'discussions/raw',
    );
    expect(payload.from).toBe('sender@example.edu');
    expect(payload.to).toBe('program@example.org');
    expect(payload.subject).toBe('(no subject)');
    expect(payload.date).toBe(contract.receivedAt);
    expect(payload).not.toHaveProperty('message_id');
    expect(payload.filename).toMatch(/^2026-11-19-no-subject-[0-9a-f]{8}\.md$/);
    expect(markdown).toContain('Body only.');
  });

  it('keeps a subject with an encoded line break from adding a header line', async () => {
    const { payload, markdown } = await buildIntake(
      eml([
        'From: a@example.edu',
        'Subject: =?UTF-8?Q?Hello=0D=0AAuto-Submitted:_auto-replied?=',
        '',
        'x',
      ]),
      contract.envelope,
      receivedAt,
      'discussions/raw',
    );
    expect(payload.subject).not.toMatch(/[\r\n]/);
    expect(
      markdown.split('\n').filter((l) => l.startsWith('Auto-Submitted')),
    ).toEqual([]);
  });

  it('different bytes never share a file name', async () => {
    const a = await buildIntake(
      eml(['Subject: Same', '', 'one']),
      contract.envelope,
      receivedAt,
      'discussions/raw',
    );
    const b = await buildIntake(
      eml(['Subject: Same', '', 'two']),
      contract.envelope,
      receivedAt,
      'discussions/raw',
    );
    expect(a.payload.filename).not.toBe(b.payload.filename);
  });

  it('does not report one From mailbox when from is the envelope sender', async () => {
    // Input class: a From header the parser reads no address from (an empty
    // group first, a control character), with one address in its text. The
    // envelope sender, which the sender chooses, becomes `from`.
    for (const from of [
      'From: x:;, a@attacker.example.net',
      'From: a@attacker.example.net\u0001',
    ]) {
      const { payload } = await buildIntake(
        eml([from, 'Subject: Approve', '', 'Approved.', '']),
        { from: 'dlee@example.edu', to: 'program@example.org' },
        receivedAt,
        'discussions/raw',
      );
      expect(payload.from).toBe('dlee@example.edu');
      expect(payload.auth.from_headers).toBe(1);
      expect(payload.auth.from_mailboxes).not.toBe(1);
    }
  });

  it('does not report one From mailbox when the parser read another address than the one counted', async () => {
    // Input class: a quoted local part; the parser keeps the quotes, the
    // count drops one.
    const quoted = await buildIntake(
      eml(['From: <"dlee"@example.edu>', 'Subject: s', '', 'Body.', '']),
      { from: 'a@attacker.example.net', to: 'program@example.org' },
      receivedAt,
      'discussions/raw',
    );
    expect(quoted.payload.from).toBe('"dlee"@example.edu');
    expect(quoted.payload.auth.from_mailboxes).toBe(2);
    // Input class: a comment inside the address; the parser drops what is
    // before it.
    const comment = await buildIntake(
      eml(['From: <dl(x)ee@example.edu>', 'Subject: s', '', 'Body.', '']),
      { from: 'a@attacker.example.net', to: 'program@example.org' },
      receivedAt,
      'discussions/raw',
    );
    expect(comment.payload.from).toBe('ee@example.edu');
    expect(comment.payload.auth.from_mailboxes).toBe(2);
    // An ordinary header still counts 1.
    const { payload } = await buildIntake(
      eml([
        'From: "Lee, Dana" <DLee@example.edu>',
        'Subject: s',
        '',
        'Body.',
        '',
      ]),
      { from: 'bounce@mail.example.edu', to: 'program@example.org' },
      receivedAt,
      'discussions/raw',
    );
    expect(payload.from).toBe('dlee@example.edu');
    expect(payload.auth.from_mailboxes).toBe(1);
  });
});

describe('slug', () => {
  it('makes a safe ASCII name', () => {
    expect(slug('Re: Admissions updates')).toBe('re-admissions-updates');
    expect(slug('../../etc/passwd')).toBe('etc-passwd');
    expect(slug('日本語')).toBe('no-subject');
    expect(slug('a'.repeat(80))).toHaveLength(50);
  });
});
