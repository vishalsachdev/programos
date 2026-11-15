import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AttachmentResult,
  extractDocument,
  extractEmailAttachments,
  saveExtraction,
} from './document-extractor.js';

/**
 * Build a tiny but well-formed PDF containing the given text. Used by the
 * pdf extraction tests so we don't need a binary fixture on disk.
 */
function buildMinimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const stream = `<</Length ${content.length}>>\nstream\n${content}\nendstream`;
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    stream,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body));
    body += `${i + 1} 0 obj${obj}endobj\n`;
  });
  const xrefStart = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    body += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-extractor-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git')); // checkout-fs refuses a non-checkout
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// extractDocument
// ---------------------------------------------------------------------------

describe('extractDocument — txt passthrough', () => {
  it('returns utf-8 decoded text for .txt files', async () => {
    const content = 'Hello, world! This is plain text.';
    const result = await extractDocument(
      Buffer.from(content, 'utf-8'),
      'notes.txt',
    );
    expect(result.fullText).toBe(content);
    expect(result.preview).toBe(content);
    expect(result.sheets).toBeUndefined();
  });

  it('handles empty .txt file', async () => {
    const result = await extractDocument(Buffer.from(''), 'empty.txt');
    expect(result.fullText).toBe('');
    expect(result.preview).toBe('');
  });
});

describe('extractDocument — csv passthrough', () => {
  it('returns raw text for .csv files', async () => {
    const csv = 'name,age\nalice,30\nbob,25\n';
    const result = await extractDocument(Buffer.from(csv, 'utf-8'), 'data.csv');
    expect(result.fullText).toBe(csv);
    expect(result.preview).toBe(csv);
  });
});

describe('extractDocument — md passthrough', () => {
  it('returns raw text for .md files', async () => {
    const md = '# Hello\n\nThis is **markdown**.';
    const result = await extractDocument(Buffer.from(md, 'utf-8'), 'readme.md');
    expect(result.fullText).toBe(md);
    expect(result.preview).toBe(md);
  });
});

describe('extractDocument — preview truncation', () => {
  it('truncates preview at ~2KB with ellipsis marker', async () => {
    // Create a text > 2048 bytes
    const longText = 'A'.repeat(3000);
    const result = await extractDocument(
      Buffer.from(longText, 'utf-8'),
      'big.txt',
    );
    expect(result.fullText).toBe(longText);
    expect(result.preview.length).toBeLessThan(longText.length);
    expect(result.preview).toContain('…[truncated]');
    expect(result.preview.startsWith('A')).toBe(true);
  });

  it('does not truncate when text is exactly at the limit', async () => {
    const text = 'B'.repeat(2048);
    const result = await extractDocument(
      Buffer.from(text, 'utf-8'),
      'exact.txt',
    );
    expect(result.preview).toBe(text);
    expect(result.preview).not.toContain('[truncated]');
  });
});

describe('extractDocument — 20MB size limit', () => {
  it('returns size error for files over 20MB', async () => {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 'x');
    const result = await extractDocument(big, 'toobig.txt');
    expect(result.fullText).toContain('[File too large for extraction:');
    expect(result.fullText).toContain('limit 20MB]');
    expect(result.preview).toBe(result.fullText);
  });

  it('accepts files exactly at 20MB limit', async () => {
    const text = 'x'.repeat(20 * 1024 * 1024);
    const result = await extractDocument(Buffer.from(text), 'exactly20mb.txt');
    // Should not return the size error
    expect(result.fullText).not.toContain('[File too large');
  });
});

describe('extractDocument — pdf', () => {
  it('extracts text from a real PDF', async () => {
    // Tiny inline PDF with the text "Hello PDF". Built once and committed
    // here so the test does not depend on any fixture file on disk.
    const minimalPdf = buildMinimalPdf('Hello PDF');
    const result = await extractDocument(minimalPdf, 'tiny.pdf');
    expect(result.fullText).toContain('Hello PDF');
    expect(result.preview).toContain('Hello PDF');
  });

  it('returns a graceful placeholder when the PDF has no extractable text', async () => {
    const garbage = Buffer.from('%PDF-1.4\n% no actual content\n');
    const result = await extractDocument(garbage, 'empty.pdf');
    // Either the parser throws (caught -> "[Could not parse:") or it
    // returns no text (-> "[Could not extract text from PDF"). Both are
    // acceptable graceful fallbacks; the channel layer treats them the same.
    expect(
      result.fullText.startsWith('[Could not extract text from PDF') ||
        result.fullText.startsWith('[Could not parse:'),
    ).toBe(true);
  });
});

describe('extractDocument — unsupported type', () => {
  it('returns placeholder for unknown extensions', async () => {
    const result = await extractDocument(Buffer.from('data'), 'archive.zip');
    expect(result.fullText).toBe('[Unsupported file type: .zip]');
  });

  it('uses the actual extension in the message', async () => {
    const result = await extractDocument(Buffer.from('data'), 'weird.xyz');
    expect(result.fullText).toContain('.xyz');
  });
});

describe('extractDocument — xlsx multi-sheet', () => {
  it('extracts sheets with index line and ## Sheet headers', async () => {
    // Build a real xlsx buffer using xlsx library
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([
      ['Name', 'Score'],
      ['Alice', 95],
      ['Bob', 87],
    ]);
    const ws2 = XLSX.utils.aoa_to_sheet([
      ['Item', 'Qty'],
      ['Widget', 10],
    ]);
    XLSX.utils.book_append_sheet(wb, ws1, 'Grades');
    XLSX.utils.book_append_sheet(wb, ws2, 'Inventory');
    const buffer = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;

    const result = await extractDocument(Buffer.from(buffer), 'report.xlsx');
    expect(result.sheets).toEqual(['Grades', 'Inventory']);
    expect(result.fullText).toContain('Sheets: Grades, Inventory');
    expect(result.fullText).toContain('## Sheet: Grades');
    expect(result.fullText).toContain('## Sheet: Inventory');
    expect(result.fullText).toContain('Name');
    expect(result.fullText).toContain('Alice');
  });

  it('handles single sheet xlsx', async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Col1'], ['Val1']]);
    XLSX.utils.book_append_sheet(wb, ws, 'Data');
    const buffer = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    }) as Buffer;

    const result = await extractDocument(Buffer.from(buffer), 'simple.xlsx');
    expect(result.sheets).toEqual(['Data']);
    expect(result.fullText).toContain('Sheets: Data');
    expect(result.fullText).toContain('## Sheet: Data');
  });
});

describe('extractDocument — docx error handling', () => {
  it('returns error message for invalid docx content', async () => {
    const garbage = Buffer.from('This is not a valid docx file at all!');
    const result = await extractDocument(garbage, 'bad.docx');
    expect(result.fullText).toContain('[Could not parse: bad.docx');
    expect(result.preview).toBe(result.fullText);
  });
});

// ---------------------------------------------------------------------------
// extractEmailAttachments
// ---------------------------------------------------------------------------

describe('extractEmailAttachments', () => {
  function buildEml(
    attachments: Array<{ filename: string; content: string; mime?: string }>,
  ): string {
    const boundary = 'TEST_BOUNDARY_12345';
    let eml = [
      'From: sender@example.com',
      'To: recipient@example.com',
      'Subject: Test Email',
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain',
      '',
      'Email body text here.',
      '',
    ].join('\r\n');

    for (const att of attachments) {
      const mime = att.mime ?? 'application/octet-stream';
      const encoded = Buffer.from(att.content).toString('base64');
      eml += [
        `--${boundary}`,
        `Content-Type: ${mime}; name="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '',
        encoded,
        '',
      ].join('\r\n');
    }

    eml += `--${boundary}--\r\n`;
    return eml;
  }

  it('extracts text attachment from .eml file', async () => {
    const emlContent = buildEml([
      {
        filename: 'notes.txt',
        content: 'Hello from attachment',
        mime: 'text/plain',
      },
    ]);
    const emlPath = path.join(tmpDir, 'test.eml');
    fs.writeFileSync(emlPath, emlContent);

    const results = await extractEmailAttachments(emlPath);
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('notes.txt');
    expect(results[0].buffer.toString('utf-8')).toBe('Hello from attachment');
  });

  it('filters out unsupported attachment types', async () => {
    const emlContent = buildEml([
      {
        filename: 'report.docx',
        content: 'docx content',
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { filename: 'photo.jpg', content: 'fake jpg data', mime: 'image/jpeg' },
      { filename: 'archive.zip', content: 'fake zip', mime: 'application/zip' },
      { filename: 'data.csv', content: 'a,b\n1,2', mime: 'text/csv' },
    ]);
    const emlPath = path.join(tmpDir, 'mixed.eml');
    fs.writeFileSync(emlPath, emlContent);

    const results = await extractEmailAttachments(emlPath);
    const filenames = results.map((r) => r.filename);
    expect(filenames).toContain('report.docx');
    expect(filenames).toContain('data.csv');
    expect(filenames).toContain('photo.jpg'); // images now allowed (vision)
    expect(filenames).not.toContain('archive.zip');
  });

  it('returns empty array when no attachments', async () => {
    const emlContent = [
      'From: sender@example.com',
      'To: recipient@example.com',
      'Subject: Plain email',
      'Content-Type: text/plain',
      '',
      'Just a plain email body, no attachments.',
    ].join('\r\n');
    const emlPath = path.join(tmpDir, 'plain.eml');
    fs.writeFileSync(emlPath, emlContent);

    const results = await extractEmailAttachments(emlPath);
    expect(results).toHaveLength(0);
  });

  it('returns AttachmentResult with filename, contentType, and buffer', async () => {
    const emlContent = buildEml([
      {
        filename: 'summary.md',
        content: '# Summary\n\nContent here.',
        mime: 'text/markdown',
      },
    ]);
    const emlPath = path.join(tmpDir, 'typed.eml');
    fs.writeFileSync(emlPath, emlContent);

    const results: AttachmentResult[] = await extractEmailAttachments(emlPath);
    expect(results).toHaveLength(1);
    expect(results[0].filename).toBe('summary.md');
    expect(typeof results[0].contentType).toBe('string');
    expect(Buffer.isBuffer(results[0].buffer)).toBe(true);
    expect(results[0].buffer.toString()).toContain('Summary');
  });
});

// ---------------------------------------------------------------------------
// saveExtraction
// ---------------------------------------------------------------------------

describe('saveExtraction', () => {
  it('writes fullText to the specified path', async () => {
    const savePath = path.join(tmpDir, 'output.txt');
    await saveExtraction('Extracted content here.', savePath);
    const written = fs.readFileSync(savePath, 'utf-8');
    expect(written).toBe('Extracted content here.');
  });

  it('creates nested directories if they do not exist', async () => {
    const savePath = path.join(tmpDir, 'a', 'b', 'c', 'output.txt');
    await saveExtraction('Nested directory content.', savePath);
    expect(fs.existsSync(savePath)).toBe(true);
    const written = fs.readFileSync(savePath, 'utf-8');
    expect(written).toBe('Nested directory content.');
  });

  it('overwrites an existing file', async () => {
    const savePath = path.join(tmpDir, 'overwrite.txt');
    fs.writeFileSync(savePath, 'old content');
    await saveExtraction('new content', savePath);
    const written = fs.readFileSync(savePath, 'utf-8');
    expect(written).toBe('new content');
  });

  it('with a root, refuses a save path outside the checkout', async () => {
    await expect(
      saveExtraction('x', path.join(tmpDir, '..', 'escape.md'), tmpDir),
    ).rejects.toThrow(/refused/);
  });

  it('with a root, replaces a planted file symlink instead of writing through it', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'de-outside-'));
    const target = path.join(outside, 'secret.env');
    fs.writeFileSync(target, 'KEEP=1\n');
    const savePath = path.join(tmpDir, 'a.extracted.md');
    fs.symlinkSync(target, savePath);
    await saveExtraction('new', savePath, tmpDir);
    expect(fs.readFileSync(target, 'utf8')).toBe('KEEP=1\n');
    expect(fs.readFileSync(savePath, 'utf8')).toBe('new');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('handles empty string content', async () => {
    const savePath = path.join(tmpDir, 'empty.txt');
    await saveExtraction('', savePath);
    const written = fs.readFileSync(savePath, 'utf-8');
    expect(written).toBe('');
  });
});
