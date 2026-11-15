import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';

let repoPath = '';
vi.mock('../env.js', () => ({
  readEnvFile: () => ({ TELEGRAM_BOT_TOKEN: 'test-token' }),
}));
vi.mock('../program-repo.js', () => ({ getProgramRepoPath: () => repoPath }));
vi.mock('./telegram-allowlist.js', () => ({
  canProcessTelegramSender: () => ({ allowed: true }),
  loadTelegramAllowlistFrom: () => ({
    available: true,
    handles: new Set(['tester']),
  }),
  normalizeTelegramAllowlistFallbackMode: () => 'closed',
}));
vi.mock('../telegram-upload-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../telegram-upload-store.js')>();
  return {
    ...actual,
    getTelegramUploadDir: () =>
      path.join(repoPath, 'host-uploads', 'program-telegram'),
  };
});
import './telegram.js';
import { getChannelFactory } from './registry.js';

beforeEach(() => {
  repoPath = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'tg-regression-'),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

interface Upload {
  chat: number;
  message: number;
  name: string;
  body: Buffer;
  mime?: string;
}
async function ingest(uploads: Upload[]): Promise<string[]> {
  let served = false;
  const ok = (result: unknown) => ({
    ok: true,
    json: async () => ({ ok: true, result }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/getMe')) return ok({ username: 'ProgramBot' });
      if (url.endsWith('/getUpdates')) {
        if (served) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ok([]);
        }
        served = true;
        return ok(
          uploads.map((upload, i) => ({
            update_id: i + 1,
            message: {
              message_id: upload.message,
              date: 1725881600,
              chat: { id: upload.chat, type: 'private' },
              from: { id: 7, first_name: 'Test', username: 'tester' },
              document: {
                file_id: String(i),
                file_name: upload.name,
                mime_type: upload.mime ?? 'text/plain',
                file_size: upload.body.length,
              },
            },
          })),
        );
      }
      if (url.endsWith('/getFile')) {
        const { file_id } = JSON.parse(String(init?.body));
        // Telegram storage paths need not carry the original extension.
        return ok({ file_path: `documents/${file_id}` });
      }
      if (url.includes('/file/')) {
        const body = uploads[Number(url.split('/').pop())].body;
        return {
          ok: true,
          arrayBuffer: async () => Uint8Array.from(body).buffer,
        };
      }
      return ok(true);
    }),
  );
  const messages: string[] = [];
  const channel = getChannelFactory('telegram')!({
    onMessage: (_jid, msg) => {
      messages.push(msg.content);
    },
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      'tg-program@program': {
        name: 'Telegram',
        folder: 'program-telegram',
        trigger: '',
        added_at: '2026-09-01',
        isMain: true,
      },
    }),
  })!;
  try {
    await channel.connect();
    await vi.waitFor(() => expect(messages).toHaveLength(uploads.length));
    return messages;
  } finally {
    await channel.disconnect();
  }
}
function saved(content: string, kind: 'original' | 'extraction'): string {
  const pointer = content.match(
    new RegExp(`\\*\\*Saved ${kind}:\\*\\* (.+)`),
  )?.[1];
  expect(pointer).toBeTruthy();
  return path.join(
    repoPath,
    'host-uploads',
    'program-telegram',
    path.basename(pointer!),
  );
}

describe('Telegram saved-source regressions', () => {
  it('keeps diagnostic text behind the preview limit instead of treating it as a parser error', async () => {
    const body = '[Could not parse: ' + 'diagnostic line\n'.repeat(5000);
    const [content] = await ingest([
      {
        chat: 42,
        message: 12,
        name: 'diagnostic.txt',
        body: Buffer.from(body),
      },
    ]);
    expect(content.length).toBeLessThan(5000);
    expect(content).not.toContain('**Extraction status:**');
    expect(
      await fs.promises.readFile(saved(content, 'extraction'), 'utf8'),
    ).toBe(body);
  });
  it('never follows source symlinks planted in the writable curriculum checkout', async () => {
    const victim = path.join(repoPath, 'host-victim');
    await fs.promises.writeFile(victim, 'keep me');
    const oldUploads = path.join(repoPath, 'discussions', 'uploads');
    await fs.promises.mkdir(oldUploads, { recursive: true });
    await fs.promises.symlink(
      victim,
      path.join(oldUploads, 'tg-42-13-notes.txt'),
    );
    const [content] = await ingest([
      {
        chat: 42,
        message: 13,
        name: 'notes.txt',
        body: Buffer.from('uploaded bytes'),
      },
    ]);
    expect(await fs.promises.readFile(victim, 'utf8')).toBe('keep me');
    expect(await fs.promises.readFile(saved(content, 'original'), 'utf8')).toBe(
      'uploaded bytes',
    );
  });
  it('preserves both uploads when different chats reuse a message ID and filename', async () => {
    const contents = await ingest([
      {
        chat: 42,
        message: 7,
        name: 'notes.txt',
        body: Buffer.from('first chat'),
      },
      {
        chat: 99,
        message: 7,
        name: 'notes.txt',
        body: Buffer.from('second chat'),
      },
    ]);
    expect(saved(contents[0], 'original')).not.toBe(
      saved(contents[1], 'original'),
    );
    expect(
      await fs.promises.readFile(saved(contents[0], 'original'), 'utf8'),
    ).toBe('first chat');
    expect(
      await fs.promises.readFile(saved(contents[1], 'original'), 'utf8'),
    ).toBe('second chat');
  });
  it('retains readable input when creating the upload directory fails', async () => {
    vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(
      new Error('storage unavailable'),
    );
    const [content] = await ingest([
      {
        chat: 42,
        message: 8,
        name: 'notes.txt',
        body: Buffer.from('recover this text'),
      },
    ]);
    expect(content).toContain('recover this text');
    expect(content).toContain('save failed');
    expect(content).not.toContain('**Saved original:**');
    expect(content).not.toContain('**Saved extraction:**');
    expect(content).not.toContain('could not be downloaded');
  });
  it('reports only the extraction as saved when the original write fails', async () => {
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      if (!String(target).endsWith('.extracted.md'))
        throw new Error('original write denied');
      return link(source, target);
    });
    const [content] = await ingest([
      {
        chat: 42,
        message: 9,
        name: 'notes.txt',
        body: Buffer.from('still readable'),
      },
    ]);
    expect(content).not.toContain('**Saved original:**');
    expect(
      await fs.promises.readFile(saved(content, 'extraction'), 'utf8'),
    ).toBe('still readable');
    expect(content).toContain('original save failed');
  });
  it.each(['headings', 'csv'])(
    'bounds the entire prompt even with oversized %s',
    async (kind) => {
      const body =
        kind === 'headings'
          ? ('# ' + 'a'.repeat(12000) + '\n').repeat(9)
          : 'column,'.repeat(12000) + '\nvalue';
      const [content] = await ingest([
        {
          chat: 42,
          message: 10,
          name: kind === 'csv' ? 'wide.csv' : 'notes.md',
          body: Buffer.from(body),
        },
      ]);
      expect(content.length).toBeLessThan(5000);
      expect(
        await fs.promises.readFile(saved(content, 'extraction'), 'utf8'),
      ).toBe(body);
    },
  );
  it('extracts an XLSX using its filename and MIME type instead of decoding the ZIP as text', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ['Name', 'Credits'],
        ['Smith, John', 4],
      ]),
      'Courses',
    );
    const body = XLSX.write(book, { bookType: 'xlsx', type: 'buffer' });
    const [content] = await ingest([
      {
        chat: 42,
        message: 11,
        name: 'courses.xlsx',
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        body,
      },
    ]);
    const text = await fs.promises.readFile(
      saved(content, 'extraction'),
      'utf8',
    );
    expect(text).toContain('| Name | Credits |');
    expect(text).toContain('| Smith, John | 4 |');
    expect(content).toContain('Sheets: Courses');
  });
});
