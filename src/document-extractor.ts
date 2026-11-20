import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { Worker } from 'worker_threads';
import { writeToCheckout } from './checkout-fs.js';

import { logger } from './logger.js';

export interface ExtractionResult {
  preview: string;
  fullText: string;
  sheets?: string[];
}

export interface AttachmentResult {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

const MAX_SIZE_BYTES = 20 * 1024 * 1024; // 20MB (matches Telegram bot file-download cap)
const PREVIEW_SIZE = 2048; // ~2KB

const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  '.docx',
  '.xlsx',
  '.xls',
  '.pdf',
  '.txt',
  '.csv',
  '.md',
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
]);

export function makePreview(text: string): string {
  if (text.length <= PREVIEW_SIZE) return text;
  return text.slice(0, PREVIEW_SIZE) + '…[truncated]';
}

function formatBytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

interface MammothModule {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  convertToHtml: (input: { buffer: Buffer }) => Promise<{ value: string }>;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  // mammoth ships as CJS; the dynamic import gives us the namespace,
  // but the @types/mammoth typedefs don't include convertToMarkdown.
  // We cast via unknown to work around the missing type.
  const mod = await import('mammoth');
  const mammoth = mod as unknown as MammothModule;
  const result = await mammoth.convertToMarkdown({ buffer });
  return result.value;
}

// The registry has no fixed release of `xlsx` (GHSA-4r6h-8v6p-xvw6, prototype
// pollution when reading a crafted file; GHSA-5pgg-2g8v-p4x9, ReDoS). Mail and
// chat attachments are untrusted, so the parse runs in a worker thread: a
// polluted Object.prototype stays in the worker's own realm and cannot change
// objects in the host (the delivery gate, allowlists, config), and a slow parse
// does not block the host's event loop. The worker gets an empty environment.
// The output for a valid file is the same as parsing in the host.
// See docs/dependency-audit.md.
const XLSX_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const XLSX = require(workerData.xlsxPath);
const u8 = workerData.data;
const buffer = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
const workbook = XLSX.read(buffer, { type: 'buffer' });
const sheets = workbook.SheetNames.map((n) => String(n));
const parts = [];
for (const name of sheets) {
  const sheet = workbook.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  if (rows.length === 0) {
    parts.push('## Sheet: ' + name + '\\n\\n(empty)');
    continue;
  }
  const header = rows[0].map((c) => String(c ?? ''));
  const separator = header.map(() => '---');
  const body = rows
    .slice(1)
    .map((row) => header.map((_, i) => String(row[i] ?? '')));
  const table = [
    '| ' + header.join(' | ') + ' |',
    '| ' + separator.join(' | ') + ' |',
    ...body.map((row) => '| ' + row.join(' | ') + ' |'),
  ].join('\\n');
  parts.push('## Sheet: ' + name + '\\n\\n' + table);
}
parentPort.postMessage({ fullText: parts.join('\\n\\n'), sheets });
`;

const requireFromHere = createRequire(import.meta.url);

async function extractXlsx(
  buffer: Buffer,
): Promise<{ fullText: string; sheets: string[] }> {
  const xlsxPath = requireFromHere.resolve('xlsx');
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(XLSX_WORKER_SOURCE, {
      eval: true,
      env: {},
      workerData: { xlsxPath, data: new Uint8Array(buffer) },
    });
    worker.once('message', (msg: { fullText: unknown; sheets: unknown }) => {
      settled = true;
      void worker.terminate();
      if (
        typeof msg?.fullText !== 'string' ||
        !Array.isArray(msg.sheets) ||
        !msg.sheets.every((n) => typeof n === 'string')
      ) {
        reject(new Error('spreadsheet worker returned an unexpected result'));
        return;
      }
      resolve({ fullText: msg.fullText, sheets: msg.sheets as string[] });
    });
    worker.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`spreadsheet worker exited with code ${code}`));
    });
  });
}

function extractText(buffer: Buffer): string {
  return buffer.toString('utf-8');
}

interface PdfParseModule {
  PDFParse: new (opts: { data: Buffer }) => {
    getText: () => Promise<{ text: string }>;
    destroy?: () => Promise<void> | void;
  };
}

async function extractPdf(buffer: Buffer): Promise<string> {
  // pdf-parse v2 exposes a PDFParse class (not a default function).
  // Dynamic-import keeps it lazy — consistent with mammoth/xlsx above.
  const mod = (await import('pdf-parse')) as unknown as PdfParseModule;
  const parser = new mod.PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return (result.text ?? '').trim();
  } finally {
    try {
      await parser.destroy?.();
    } catch {
      /* best-effort cleanup */
    }
  }
}

export async function extractDocument(
  buffer: Buffer,
  filename: string,
): Promise<ExtractionResult> {
  const sizeBytes = buffer.length;

  if (sizeBytes > MAX_SIZE_BYTES) {
    const msg = `[File too large for extraction: ${formatBytes(sizeBytes)}MB, limit 20MB]`;
    return { preview: msg, fullText: msg };
  }

  const ext = path.extname(filename).toLowerCase();

  try {
    if (ext === '.docx') {
      const fullText = await extractDocx(buffer);
      return { preview: makePreview(fullText), fullText };
    }

    if (ext === '.xlsx' || ext === '.xls') {
      const { fullText, sheets } = await extractXlsx(buffer);
      const indexLine = `Sheets: ${sheets.join(', ')}`;
      const fullWithIndex = `${indexLine}\n\n${fullText}`;
      return {
        preview: makePreview(fullWithIndex),
        fullText: fullWithIndex,
        sheets,
      };
    }

    if (ext === '.txt' || ext === '.csv' || ext === '.md') {
      const fullText = extractText(buffer);
      return { preview: makePreview(fullText), fullText };
    }

    if (ext === '.pdf') {
      const fullText = await extractPdf(buffer);
      if (!fullText) {
        const msg = `[Could not extract text from PDF: ${filename} — file may be scanned/image-based]`;
        return { preview: msg, fullText: msg };
      }
      return { preview: makePreview(fullText), fullText };
    }

    const msg = `[Unsupported file type: ${ext}]`;
    return { preview: msg, fullText: msg };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, filename }, 'document-extractor: parse failed');
    const msg = `[Could not parse: ${filename} — ${errMsg}]`;
    return { preview: msg, fullText: msg };
  }
}

export async function extractEmailAttachments(
  emlPath: string,
): Promise<AttachmentResult[]> {
  const { simpleParser } = await import('mailparser');
  const raw = await fs.promises.readFile(emlPath);
  const parsed = await simpleParser(raw);

  const results: AttachmentResult[] = [];

  for (const attachment of parsed.attachments ?? []) {
    const fname = attachment.filename ?? 'unknown';
    const ext = path.extname(fname).toLowerCase();
    if (!SUPPORTED_ATTACHMENT_EXTENSIONS.has(ext)) continue;

    results.push({
      filename: fname,
      contentType: attachment.contentType,
      buffer: attachment.content,
    });
  }

  return results;
}

/**
 * Save extracted text. With `root` (the container-writable checkout), the
 * write runs as the checkout owner, never root.
 */
export async function saveExtraction(
  fullText: string,
  savePath: string,
  root?: string,
): Promise<void> {
  if (root) {
    writeToCheckout(root, savePath, fullText);
    return;
  }
  const dir = path.dirname(savePath);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(savePath, fullText, 'utf-8');
}
