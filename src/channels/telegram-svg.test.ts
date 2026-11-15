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

const SVG_BYTES = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
  'utf-8',
);

function stubTelegram(document: Record<string, unknown>, fileBytes: Buffer) {
  let updatesServed = false;
  const fetchMock = vi.fn(async (input: string) => {
    if (input.includes('/getMe')) return okJson({ username: 'ProgramBot' });
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
              document,
            },
          },
        ]);
      }
      return new Promise((resolve) =>
        setTimeout(() => resolve(okJson([])), 25),
      );
    }
    if (input.includes('/getFile')) return okJson({ file_path: 'docs/upload' });
    if (input.includes('/file/bottest-token/docs/upload')) {
      return okBuffer(fileBytes);
    }
    if (input.includes('/sendChatAction')) return okJson(true);
    throw new Error(`unexpected fetch: ${input}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function receiveOne(): Promise<string> {
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
  return content;
}

describe('telegram SVG handling (CVE-2026-96889)', () => {
  it('declines an SVG document without downloading or decoding it', async () => {
    const fetchMock = stubTelegram(
      {
        file_id: 'file-svg',
        file_name: 'diagram.svg',
        mime_type: 'image/svg+xml',
        file_size: SVG_BYTES.length,
      },
      SVG_BYTES,
    );

    const content = await receiveOne();

    expect(content).toContain('[User sent SVG file: diagram.svg.');
    expect(content).toContain('SVG images are not supported');
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/getFile')),
    ).toBe(false);
  });

  it('refuses SVG bytes disguised as a PNG before they reach the image decoder', async () => {
    stubTelegram(
      {
        file_id: 'file-fake-png',
        file_name: 'photo.png',
        mime_type: 'image/png',
        file_size: SVG_BYTES.length,
      },
      SVG_BYTES,
    );

    const content = await receiveOne();

    expect(content).toContain(
      '[User sent an image that could not be processed',
    );
    expect(content).toContain('unsupported image format');
  });
});
