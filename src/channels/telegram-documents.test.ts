import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let repoPath = '';

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_ADMIN_CHAT_ID: '12345',
  }),
}));

vi.mock('../program-repo.js', () => ({
  CHECKOUT_OWNER: { uid: 1000, gid: 1000 },
  checkoutGitOptions: () => ({
    cwd: process.env.PROGRAM_REPO,
    env: process.env,
    timeout: 30_000,
  }),
  getProgramRepoPath: () => repoPath,
}));

vi.mock('./telegram-allowlist.js', () => ({
  canProcessTelegramSender: () => ({ allowed: true }),
  loadTelegramAllowlistFrom: () => ({
    available: true,
    handles: new Set(['tester']),
    source: 'program/EMAIL_ALLOWLIST.md',
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

function makeChannel(onMessage = vi.fn()) {
  const channel = getChannelFactory('telegram')?.({
    onMessage,
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
  });
  if (!channel) throw new Error('telegram channel not registered');
  return { channel, onMessage };
}

function okJson(result: unknown) {
  return {
    ok: true,
    json: async () => ({ ok: true, result }),
  };
}

function okBuffer(buffer: Buffer) {
  return {
    ok: true,
    arrayBuffer: async () =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
  };
}

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'telegram-docs-test-'),
  );
  repoPath = tmpDir;
  vi.restoreAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('telegram document ingestion', () => {
  it('stores large text files with message-specific source pointers and a bounded preview', async () => {
    const longText = [
      '# Overview',
      '',
      ...Array.from({ length: 450 }, (_, i) => `Line ${i + 1}: value ${i + 1}`),
    ].join('\n');
    let updatesServed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/getMe')) {
          return okJson({ username: 'ProgramBot' });
        }
        if (input.includes('/getUpdates')) {
          if (!updatesServed) {
            updatesServed = true;
            return okJson([
              {
                update_id: 1,
                message: {
                  message_id: 321,
                  date: 1_725_881_600,
                  chat: { id: 42, type: 'private' },
                  from: { id: 7, first_name: 'Test', username: 'tester' },
                  document: {
                    file_id: 'file-1',
                    file_name: 'notes.txt',
                    mime_type: 'text/plain',
                    file_size: Buffer.byteLength(longText),
                  },
                },
              },
            ]);
          }
          return new Promise((resolve) =>
            setTimeout(() => resolve(okJson([])), 25),
          );
        }
        if (input.includes('/getFile')) {
          return okJson({ file_path: 'docs/notes.txt' });
        }
        if (input.includes('/file/bottest-token/docs/notes.txt')) {
          return okBuffer(Buffer.from(longText, 'utf-8'));
        }
        if (input.includes('/sendChatAction')) {
          return okJson(true);
        }
        throw new Error(`unexpected fetch: ${input}`);
      }),
    );

    let resolveMessage: ((content: string) => void) | undefined;
    const received = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });
    const { channel } = makeChannel(
      vi.fn((_jid, message) => resolveMessage?.(message.content)),
    );

    await channel.connect();
    const content = await received;
    await channel.disconnect();

    expect(content).toContain('[User sent file: notes.txt]');
    expect(content).toContain(
      '**Saved original:** /workspace/telegram-uploads/tg-42-321-notes.txt',
    );
    expect(content).toContain(
      '**Saved extraction:** /workspace/telegram-uploads/tg-42-321-notes.txt.extracted.md',
    );
    expect(content).toContain(
      '**Preview scope:** This is only a bounded preview.',
    );
    expect(content).toContain('- Sections: Overview');
    expect(content).toContain('Readable ranges');
    expect(content).toContain('…[truncated]');
    expect(content).not.toContain(longText.slice(-120));

    expect(
      fs.readFileSync(
        path.join(tmpDir, 'host-uploads/program-telegram/tg-42-321-notes.txt'),
        'utf-8',
      ),
    ).toBe(longText);
    expect(
      fs.readFileSync(
        path.join(
          tmpDir,
          'host-uploads/program-telegram/tg-42-321-notes.txt.extracted.md',
        ),
        'utf-8',
      ),
    ).toBe(longText);
  });

  it('avoids filename collisions across Telegram messages with the same document name', async () => {
    const docText = 'short document';
    let updatesServed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/getMe')) {
          return okJson({ username: 'ProgramBot' });
        }
        if (input.includes('/getUpdates')) {
          if (!updatesServed) {
            updatesServed = true;
            return okJson([
              {
                update_id: 1,
                message: {
                  message_id: 111,
                  date: 1_725_881_600,
                  chat: { id: 42, type: 'private' },
                  from: { id: 7, first_name: 'Test', username: 'tester' },
                  document: {
                    file_id: 'file-a',
                    file_name: 'syllabus.txt',
                    mime_type: 'text/plain',
                    file_size: Buffer.byteLength(docText),
                  },
                },
              },
              {
                update_id: 2,
                message: {
                  message_id: 112,
                  date: 1_725_881_601,
                  chat: { id: 42, type: 'private' },
                  from: { id: 7, first_name: 'Test', username: 'tester' },
                  document: {
                    file_id: 'file-b',
                    file_name: 'syllabus.txt',
                    mime_type: 'text/plain',
                    file_size: Buffer.byteLength(docText),
                  },
                },
              },
            ]);
          }
          return new Promise((resolve) =>
            setTimeout(() => resolve(okJson([])), 25),
          );
        }
        if (input.includes('/getFile')) {
          return okJson({ file_path: 'docs/syllabus.txt' });
        }
        if (input.includes('/file/bottest-token/docs/syllabus.txt')) {
          return okBuffer(Buffer.from(docText, 'utf-8'));
        }
        if (input.includes('/sendChatAction')) {
          return okJson(true);
        }
        throw new Error(`unexpected fetch: ${input}`);
      }),
    );

    const seenContents: string[] = [];
    const received = new Promise<void>((resolve) => {
      const { channel } = makeChannel(
        vi.fn(async (_jid, message) => {
          seenContents.push(message.content);
          if (seenContents.length === 2) {
            await channel.disconnect();
            resolve();
          }
        }),
      );
      channel.connect();
    });

    await received;

    expect(seenContents[0]).toContain(
      '/workspace/telegram-uploads/tg-42-111-syllabus.txt',
    );
    expect(seenContents[1]).toContain(
      '/workspace/telegram-uploads/tg-42-112-syllabus.txt',
    );
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          'host-uploads/program-telegram/tg-42-111-syllabus.txt',
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          'host-uploads/program-telegram/tg-42-112-syllabus.txt',
        ),
      ),
    ).toBe(true);
  });

  it('keeps unreadable PDF extraction explicit while still saving source files', async () => {
    const badPdf = Buffer.from('%PDF-1.4\n% no text here\n');
    let updatesServed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('/getMe')) {
          return okJson({ username: 'ProgramBot' });
        }
        if (input.includes('/getUpdates')) {
          if (!updatesServed) {
            updatesServed = true;
            return okJson([
              {
                update_id: 1,
                message: {
                  message_id: 654,
                  date: 1_725_881_600,
                  chat: { id: 42, type: 'private' },
                  from: { id: 7, first_name: 'Test', username: 'tester' },
                  document: {
                    file_id: 'file-pdf',
                    file_name: 'paper.pdf',
                    mime_type: 'application/pdf',
                    file_size: badPdf.byteLength,
                  },
                },
              },
            ]);
          }
          return new Promise((resolve) =>
            setTimeout(() => resolve(okJson([])), 25),
          );
        }
        if (input.includes('/getFile')) {
          return okJson({ file_path: 'docs/paper.pdf' });
        }
        if (input.includes('/file/bottest-token/docs/paper.pdf')) {
          return okBuffer(badPdf);
        }
        if (input.includes('/sendChatAction')) {
          return okJson(true);
        }
        throw new Error(`unexpected fetch: ${input}`);
      }),
    );

    let resolveMessage: ((content: string) => void) | undefined;
    const received = new Promise<string>((resolve) => {
      resolveMessage = resolve;
    });
    const { channel } = makeChannel(
      vi.fn((_jid, message) => resolveMessage?.(message.content)),
    );

    await channel.connect();
    const content = await received;
    await channel.disconnect();

    expect(content).toContain('[User sent PDF: paper.pdf]');
    expect(content).toContain(
      '**Saved original:** /workspace/telegram-uploads/tg-42-654-paper.pdf',
    );
    expect(content).toContain(
      '**Saved extraction:** /workspace/telegram-uploads/tg-42-654-paper.pdf.extracted.md',
    );
    expect(content).toContain('**Extraction status:** [Could not');
    expect(content).toContain('Do not assume it was fully examined');

    expect(
      fs.existsSync(
        path.join(tmpDir, 'host-uploads/program-telegram/tg-42-654-paper.pdf'),
      ),
    ).toBe(true);
    expect(
      fs.readFileSync(
        path.join(
          tmpDir,
          'host-uploads/program-telegram/tg-42-654-paper.pdf.extracted.md',
        ),
        'utf-8',
      ),
    ).toContain('[Could not');
  });
});
