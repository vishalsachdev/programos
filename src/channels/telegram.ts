import { extname } from 'path';
import { registerChannel } from './registry.js';
import { TELEGRAM_OWNER_JID } from '../config.js';
import { chatProfile } from '../delivery-gate.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { Channel, PreparedDelivery } from '../types.js';
import {
  extractDocument,
  makePreview,
  type ExtractionResult,
} from '../document-extractor.js';
import { processImage } from '../image.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { safeAttachmentName } from '../attachment-safety.js';
import {
  canProcessTelegramSender,
  loadTelegramAllowlistFrom,
  normalizeTelegramAllowlistFallbackMode,
} from './telegram-allowlist.js';
import { makeTtlCachedAllowlist } from '../channel-utils.js';
import {
  getTelegramUploadDir,
  saveTelegramSource,
  TELEGRAM_UPLOAD_CONTAINER_PATH,
} from '../telegram-upload-store.js';

const TG_API = 'https://api.telegram.org/bot';

registerChannel('telegram', (opts) => {
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ADMIN_CHAT_ID']);
  const token = env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  // Avery's private DM chat id — the deterministic owner target. Used to route
  // internal/QA reports (e.g. the weekly FDE scan, daily/pilot digests) straight
  // to Avery regardless of who last messaged the bot. See TELEGRAM_OWNER_JID.
  const adminChatId =
    env.TELEGRAM_ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!token) {
    logger.info('Telegram channel: TELEGRAM_BOT_TOKEN not set, skipping');
    return null;
  }

  const api = `${TG_API}${token}`;
  let connected = false;
  let polling = false;
  let offset = 0;
  let botUsername = '';

  // Fixed JID for all Telegram messages — routes to registered group
  const TELEGRAM_JID = 'tg-program@program';
  const INLINE_DOCUMENT_LIMIT = 8000;
  const INDEX_RANGE_LINES = 200;
  const MAX_INDEX_ENTRIES = 8;
  const INDEX_ENTRY_LIMIT = 160;
  // Deterministic owner-DM JID (config.TELEGRAM_OWNER_JID). Outbound to this
  // JID always goes to Avery's private chat (TELEGRAM_ADMIN_CHAT_ID),
  // bypassing the last-messager replyTargets map. Scheduled internal reports
  // set chat_jid to this so they never leak to the group or get dropped
  // after a restart.

  // Telegram allowlist (handles from program/EMAIL_ALLOWLIST.md), served from
  // the pinned read-mirror SHA (RepoReader) and refreshed lazily every 5 min.
  // RepoReader keeps the last-good SHA on fetch failure, so a transient
  // problem serves a slightly stale allowlist instead of failing closed.
  const allowlistFallbackMode = normalizeTelegramAllowlistFallbackMode(
    process.env.TELEGRAM_ALLOWLIST_FALLBACK_MODE,
  );
  const getAllowlist = makeTtlCachedAllowlist(loadTelegramAllowlistFrom).get;

  // Map JID -> real Telegram chat_id for replies
  const replyTargets = new Map<string, string>();
  // Track active typing intervals per JID
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async function tgFetch(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<any> {
    const resp = await fetch(`${api}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await resp.json()) as {
      ok: boolean;
      result: any;
      description?: string;
    };
    if (!data.ok)
      throw new Error(`Telegram API error: ${method} — ${data.description}`);
    return data.result;
  }

  function isTextDocument(filePath?: string, mimeType?: string): boolean {
    return (
      !!mimeType?.match(/text|json|csv|markdown|xml/) ||
      !!filePath?.match(/\.(txt|md|csv|json|xml|py|js|ts|html|css)$/i)
    );
  }

  function isExtractionFailure(extraction: ExtractionResult): boolean {
    return (
      !extraction.fullText.trim() ||
      extraction.fullText.startsWith('[Could not extract text from PDF') ||
      extraction.fullText.startsWith('[Could not parse:') ||
      extraction.fullText.startsWith('[File too large') ||
      extraction.fullText.startsWith('[Unsupported file type')
    );
  }

  function formatReadableRanges(totalLines: number): string {
    const count = Math.ceil(totalLines / INDEX_RANGE_LINES);
    const range = (i: number): string => {
      const start = i * INDEX_RANGE_LINES + 1;
      const end = Math.min(totalLines, start + INDEX_RANGE_LINES - 1);
      return start === end ? `${start}` : `${start}-${end}`;
    };
    if (count <= MAX_INDEX_ENTRIES)
      return Array.from({ length: count }, (_, i) => range(i)).join(', ');
    return [
      ...Array.from({ length: MAX_INDEX_ENTRIES - 3 }, (_, i) => range(i)),
      '…',
      range(count - 2),
      range(count - 1),
    ].join(', ');
  }

  function indexEntry(value: string): string {
    return value.length <= INDEX_ENTRY_LIMIT
      ? value
      : `${value.slice(0, INDEX_ENTRY_LIMIT)}…`;
  }

  function buildDocumentIndex(
    filename: string,
    extraction: ExtractionResult,
  ): string[] {
    const indexLines: string[] = [];
    const headings: string[] = [];
    let firstLine = '';
    let totalLines = 0;
    // Count every line, but retain only bounded index entries. Avoid splitting
    // a large upload into millions of strings just to show a small index.
    const text = extraction.fullText;
    for (let start = 0; start <= text.length; ) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      const line = text
        .slice(start, Math.min(end, start + INDEX_ENTRY_LIMIT + 10))
        .trim();
      totalLines++;
      if (!firstLine && line) firstLine = indexEntry(line);
      if (headings.length < MAX_INDEX_ENTRIES && /^#{1,6}\s+/.test(line))
        headings.push(indexEntry(line.replace(/^#+\s*/, '')));
      if (newline < 0) break;
      start = newline + 1;
    }

    if (extraction.sheets?.length) {
      indexLines.push(
        `Sheets: ${extraction.sheets.slice(0, MAX_INDEX_ENTRIES).map(indexEntry).join(', ')}${extraction.sheets.length > MAX_INDEX_ENTRIES ? ' …' : ''}`,
      );
    }
    if (headings.length > 0) {
      indexLines.push(`Sections: ${headings.join(' • ')}`);
    }
    if (extname(filename).toLowerCase() === '.csv' && firstLine) {
      indexLines.push(`Header row (preview): ${firstLine}`);
    }
    indexLines.push(
      `Readable ranges (${totalLines} lines): ${formatReadableRanges(totalLines)}`,
    );
    return indexLines;
  }

  async function persistTelegramDocument(
    messageId: string,
    name: string,
    buffer: Buffer,
    extraction: ExtractionResult,
  ): Promise<{
    originalRelPath?: string;
    extractionRelPath?: string;
    failures: string[];
  }> {
    const baseName = `${messageId}-${name}`;
    const originalRelPath = `${TELEGRAM_UPLOAD_CONTAINER_PATH}/${baseName}`;
    const extractionRelPath = `${originalRelPath}.extracted.md`;
    const failures: string[] = [];

    let originalSaved = false;
    let extractionSaved = false;
    const group = opts.registeredGroups()[TELEGRAM_JID];
    if (!group)
      return {
        failures: ['source save failed: Telegram group is not registered'],
      };
    const uploadsDir = getTelegramUploadDir(group.folder);

    try {
      await saveTelegramSource(uploadsDir, baseName, buffer);
      originalSaved = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`original save failed: ${reason}`);
    }

    try {
      await saveTelegramSource(
        uploadsDir,
        `${baseName}.extracted.md`,
        extraction.fullText,
      );
      extractionSaved = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push(`extraction save failed: ${reason}`);
    }

    return {
      originalRelPath: originalSaved ? originalRelPath : undefined,
      extractionRelPath: extractionSaved ? extractionRelPath : undefined,
      failures,
    };
  }

  function savedSourceLines(saved: {
    originalRelPath?: string;
    extractionRelPath?: string;
    failures: string[];
  }): string[] {
    return [
      saved.originalRelPath
        ? `**Saved original:** ${saved.originalRelPath}`
        : '**Original:** not saved',
      saved.extractionRelPath
        ? `**Saved extraction:** ${saved.extractionRelPath}`
        : '**Extraction:** not saved',
      saved.failures.length
        ? `**Save status:** ${saved.originalRelPath || saved.extractionRelPath ? 'partial' : 'failed'} — ${saved.failures.join('; ')}`
        : '**Save status:** ready',
    ];
  }

  function formatSavedDocumentDescription(opts: {
    label: string;
    name: string;
    extraction: ExtractionResult;
    originalRelPath?: string;
    extractionRelPath?: string;
    failures: string[];
    inlineFullText: boolean;
    previewNotice: string;
  }): string {
    const indexLines = buildDocumentIndex(opts.name, opts.extraction);
    const lines = [
      `[${opts.label}: ${opts.name}]`,
      ``,
      ...savedSourceLines(opts),
      `**Index:**`,
      ...indexLines.map((line) => `- ${line}`),
    ];

    if (opts.inlineFullText) {
      lines.push(``, opts.extraction.fullText);
      return lines.join('\n');
    }

    lines.push(
      ``,
      `**Preview scope:** ${opts.previewNotice}`,
      ``,
      `---`,
      `**Preview:**`,
      opts.extraction.preview,
      `---`,
    );
    return lines.join('\n');
  }

  /** Download a file from Telegram and return its content as text description. */
  async function describeFile(
    fileId: string,
    messageId: string,
    fileName?: string,
    mimeType?: string,
    fileSize?: number,
  ): Promise<string> {
    // Telegram bot file downloads are capped at 20 MB. Bail early with a
    // friendly note instead of failing the getFile call.
    if (fileSize && fileSize > 20 * 1024 * 1024) {
      return `[User sent file: ${fileName || 'document'} (${(fileSize / (1024 * 1024)).toFixed(1)} MB). File is too large for me to download (>20 MB). Please paste the relevant section.]`;
    }

    try {
      const file = await tgFetch('getFile', { file_id: fileId });
      const filePath = file.file_path;
      const url = `https://api.telegram.org/file/bot${token}/${filePath}`;

      const isPdf =
        mimeType === 'application/pdf' ||
        !!filePath?.match(/\.pdf$/i) ||
        !!fileName?.match(/\.pdf$/i);
      const officeExtension = (fileName?.match(/\.(docx|xlsx|xls)$/i) ||
        filePath?.match(/\.(docx|xlsx|xls)$/i))?.[0];
      const officeDocument = !!officeExtension;
      // OOXML MIME types contain "xml" but their bodies are ZIP archives.
      const textDocument =
        !isPdf &&
        !officeDocument &&
        (isTextDocument(fileName, mimeType) ||
          isTextDocument(filePath, mimeType));
      if (textDocument || officeDocument || isPdf) {
        const resp = await fetch(url);
        if (resp.ok) {
          const arrayBuf = await resp.arrayBuffer();
          const buf = Buffer.from(arrayBuf);
          const rawName = fileName || filePath.split('/').pop() || 'document';
          const name = safeAttachmentName(rawName, 'tg-document', (raw, repl) =>
            logger.warn(
              { rawName: raw, replacement: repl },
              'telegram: refused unsafe attachment filename',
            ),
          );
          const extractionName = isPdf
            ? 'document.pdf'
            : officeExtension
              ? `document${officeExtension}`
              : name;
          const extraction = textDocument
            ? {
                fullText: buf.toString('utf-8'),
                preview: makePreview(buf.toString('utf-8')),
              }
            : await extractDocument(buf, extractionName);
          const saved = await persistTelegramDocument(
            messageId,
            name,
            buf,
            extraction,
          );

          // Graceful fallback: if extraction returned a placeholder/error,
          // keep the saved-source pointers explicit instead of pretending we
          // read the document.
          const failed = !textDocument && isExtractionFailure(extraction);
          if (failed) {
            const guidance = isPdf
              ? `I could not extract readable text from this PDF (it may be scanned/image-based). Do not assume it was fully examined; please paste the relevant text or point me to a readable source.`
              : `I could not extract a readable document body. Do not assume it was fully examined; inspect the saved source directly if needed.`;
            return [
              `[User sent ${isPdf ? 'PDF' : 'file'}: ${name}]`,
              ``,
              ...savedSourceLines(saved),
              `**Extraction status:** ${makePreview(extraction.fullText)}`,
              ``,
              guidance,
            ].join('\n');
          }

          if (
            (textDocument || isPdf) &&
            extraction.fullText.length <= INLINE_DOCUMENT_LIMIT
          ) {
            return formatSavedDocumentDescription({
              label: isPdf ? 'PDF' : 'User sent file',
              name,
              extraction,
              originalRelPath: saved.originalRelPath,
              extractionRelPath: saved.extractionRelPath,
              failures: saved.failures,
              inlineFullText: true,
              previewNotice: '',
            });
          }

          return formatSavedDocumentDescription({
            label: isPdf ? 'PDF' : 'User sent file',
            name,
            extraction,
            originalRelPath: saved.originalRelPath,
            extractionRelPath: saved.extractionRelPath,
            failures: saved.failures,
            inlineFullText: false,
            previewNotice: saved.extractionRelPath
              ? 'This is only a bounded preview. The index is not a complete section/sheet/header list. Use Read/Grep on the saved extraction for later sections, distant passages, full counts, or exhaustive review.'
              : 'This is only a bounded preview. The extraction was not saved; recover text from the saved original if available, or ask for the relevant text. Do not claim exhaustive review.',
          });
        }
      }

      // For other unsupported docs, note them
      return `[User sent document: ${fileName || filePath} (${mimeType || 'unknown type'}). Document parsing is not yet supported — please paste the relevant text or ask about it.]`;
    } catch (err: any) {
      logger.warn(
        { err: err.message, fileId },
        'Failed to download Telegram file',
      );
      return `[User sent a file that could not be downloaded.]`;
    }
  }

  /** Download an image, resize it into the group folder, return a content ref. */
  async function downloadImage(
    fileId: string,
    fileName: string | undefined,
    fileSize: number | undefined,
    caption: string,
  ): Promise<string> {
    if (fileSize && fileSize > 20 * 1024 * 1024) {
      return `[User sent image: ${fileName || 'image'} (${(fileSize / (1024 * 1024)).toFixed(1)} MB). Too large to download (>20 MB).]`;
    }

    const group = opts.registeredGroups()[TELEGRAM_JID];
    if (!group) {
      return `[User sent an image, but Telegram channel is not registered to a group yet.]`;
    }

    try {
      const file = await tgFetch('getFile', { file_id: fileId });
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

      const buffer = Buffer.from(await resp.arrayBuffer());
      const groupDir = resolveGroupFolderPath(group.folder);
      const processed = await processImage(buffer, groupDir, caption);
      if (!processed) return `[User sent an empty image.]`;

      logger.info(
        { fileId, relativePath: processed.relativePath },
        'Telegram image processed',
      );
      return processed.content;
    } catch (err: any) {
      logger.warn(
        { err: err.message, fileId },
        'Failed to download/process Telegram image',
      );
      return `[User sent an image that could not be processed: ${err.message}]`;
    }
  }

  async function poll() {
    while (polling) {
      try {
        const updates = await tgFetch('getUpdates', {
          offset,
          timeout: 30,
          allowed_updates: ['message'],
        });

        for (const update of updates) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg) continue;

          const chatId = String(msg.chat.id);
          const isGroup =
            msg.chat.type === 'group' || msg.chat.type === 'supergroup';
          const senderName =
            [msg.from?.first_name, msg.from?.last_name]
              .filter(Boolean)
              .join(' ') || 'Unknown';
          const chatName = msg.chat.title || senderName;

          // Allowlist enforcement: only authorized Telegram handles are
          // processed (closed mode by default). Senders not on the list — and
          // senders with no username — are silently dropped, no reply.
          const username = msg.from?.username as string | undefined;
          const access = canProcessTelegramSender(
            username,
            getAllowlist(),
            allowlistFallbackMode,
          );
          if (!access.allowed) {
            logger.warn(
              {
                username: username ? `@${username}` : '(none)',
                senderId: msg.from?.id,
                chatId,
                isGroup,
                reason: access.reason,
              },
              'Telegram allowlist: dropped message from unauthorized sender',
            );
            continue;
          }

          // In groups, only respond if bot is mentioned
          if (
            isGroup &&
            botUsername &&
            msg.text &&
            !msg.text.includes(`@${botUsername}`)
          )
            continue;

          // Build message content from text, documents, photos, etc.
          let content = msg.text || '';

          // Handle photos
          if (msg.photo && msg.photo.length > 0) {
            const largest = msg.photo[msg.photo.length - 1]; // highest resolution
            content = await downloadImage(
              largest.file_id,
              'photo.jpg',
              largest.file_size,
              msg.caption || '',
            );
          }

          // Handle documents
          if (msg.document) {
            const isSvgDoc =
              msg.document.mime_type === 'image/svg+xml' ||
              !!msg.document.file_name?.match(/\.svgz?$/i);
            const isImageDoc =
              !isSvgDoc &&
              (msg.document.mime_type?.startsWith('image/') ||
                !!msg.document.file_name?.match(/\.(jpg|jpeg|png|gif|webp)$/i));
            if (isSvgDoc) {
              // SVG is never decoded on the host (CVE-2026-96889, librsvg RCE).
              content =
                (msg.caption || '') +
                `\n[User sent SVG file: ${msg.document.file_name || 'image.svg'}. SVG images are not supported; ask them to send a PNG or JPEG instead.]`;
            } else if (isImageDoc) {
              content = await downloadImage(
                msg.document.file_id,
                msg.document.file_name,
                msg.document.file_size,
                msg.caption || '',
              );
            } else {
              const desc = await describeFile(
                msg.document.file_id,
                `tg-${chatId}-${msg.message_id}`,
                msg.document.file_name,
                msg.document.mime_type,
                msg.document.file_size,
              );
              content = (msg.caption || '') + '\n' + desc;
            }
          }

          // Handle voice/audio
          if (msg.voice || msg.audio) {
            content =
              (msg.caption || '') +
              '\n[User sent an audio message. Audio transcription is not yet supported — please type your question.]';
          }

          // Skip if no usable content
          if (!content.trim()) continue;

          // Track which real chat to reply to
          replyTargets.set(TELEGRAM_JID, chatId);

          // Send "thinking" indicator immediately
          try {
            await tgFetch('sendChatAction', {
              chat_id: chatId,
              action: 'typing',
            });
          } catch {
            /* ignore typing errors */
          }

          opts.onChatMetadata(
            TELEGRAM_JID,
            new Date(msg.date * 1000).toISOString(),
            chatName,
            'telegram',
            isGroup,
          );
          opts.onMessage(TELEGRAM_JID, {
            id: `tg-${msg.message_id}`,
            chat_jid: TELEGRAM_JID,
            sender: `tg:${msg.from?.id || 'unknown'}`,
            sender_name: senderName,
            content,
            timestamp: new Date(msg.date * 1000).toISOString(),
          });

          logger.info(
            {
              chatId,
              senderName,
              isGroup,
              hasDocument: !!msg.document,
              hasPhoto: !!msg.photo,
            },
            'Telegram message received',
          );
        }
      } catch (err: any) {
        if (polling) {
          logger.error(
            { err: err.message },
            'Telegram poll error, retrying in 5s',
          );
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }
  }

  const channel: Channel = {
    name: 'telegram',
    gateProfile: chatProfile,

    async connect() {
      const me = await tgFetch('getMe');
      botUsername = me.username;
      logger.info({ bot: botUsername }, 'Telegram bot connected');
      connected = true;
      polling = true;
      poll(); // Fire and forget
    },

    async prepareDelivery(jid: string, text: string, deliveryId: string) {
      // Owner-DM JID always resolves to Avery's private chat, independent of
      // the in-memory replyTargets (which tracks the last inbound chat).
      const chatId =
        jid === TELEGRAM_OWNER_JID ? adminChatId : replyTargets.get(jid);
      if (!chatId) {
        logger.warn(
          { jid },
          jid === TELEGRAM_OWNER_JID
            ? 'Owner-DM JID used but TELEGRAM_ADMIN_CHAT_ID is not set'
            : 'No Telegram chat target for JID',
        );
        return {
          status: 'failed' as const,
          reason: 'telegram-target-missing',
          retryable: false as const,
        };
      }

      // Defense-in-depth behind the orchestrator's chatProfile gate (G46):
      // callers that reach sendMessage directly must never put known
      // internal scaffolding on the wire. Host-composed alerts (dead-letter,
      // shortfall) do not match these signatures and pass untouched.
      const gate = chatProfile.validate(text);
      if (!gate.ok) {
        logger.error(
          { jid, reason: gate.reason, sample: text.slice(0, 160) },
          'telegram: refusing outbound message (scaffolding or malformed agent output)',
        );
        return {
          status: 'failed' as const,
          reason: `telegram-gate-refused: ${gate.reason}`,
          retryable: false as const,
        };
      }
      text = gate.text;
      if (!text) {
        return {
          status: 'failed' as const,
          reason: 'telegram-empty-message',
          retryable: false as const,
        };
      }

      // Telegram has 4096 char limit — split if needed
      const chunks: string[] = [];
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 4000));
        remaining = remaining.slice(4000);
      }

      return {
        status: 'prepared' as const,
        delivery: {
          channel: 'telegram',
          deliveryId,
          jid,
          payload: { chatId, chunks, textLength: text.length },
        },
      };
    },

    async deliverPrepared(delivery: PreparedDelivery) {
      if (
        delivery.channel !== 'telegram' ||
        !delivery.payload ||
        typeof delivery.payload !== 'object'
      ) {
        return {
          status: 'failed' as const,
          reason: 'invalid-telegram-delivery',
          retryable: false,
        };
      }
      const payload = delivery.payload as {
        chatId?: unknown;
        chunks?: unknown;
        textLength?: unknown;
      };
      if (
        (typeof payload.chatId !== 'string' &&
          typeof payload.chatId !== 'number') ||
        !Array.isArray(payload.chunks) ||
        payload.chunks.length === 0 ||
        !payload.chunks.every(
          (chunk) => typeof chunk === 'string' && chunk.length <= 4000,
        ) ||
        typeof payload.textLength !== 'number'
      ) {
        return {
          status: 'failed' as const,
          reason: 'invalid-telegram-delivery',
          retryable: false,
        };
      }

      try {
        for (const chunk of payload.chunks) {
          await tgFetch('sendMessage', {
            chat_id: payload.chatId,
            text: chunk,
          });
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          status: 'failed' as const,
          reason: `telegram-send-failed: ${reason}`,
          retryable: true,
        };
      }

      logger.info(
        { jid: delivery.jid, textLength: payload.textLength },
        'Telegram reply sent',
      );
      return { status: 'sent' as const };
    },

    async setTyping(jid: string, isTyping: boolean) {
      const chatId = replyTargets.get(jid);
      if (!chatId) return;

      if (!isTyping) {
        const interval = typingIntervals.get(jid);
        if (interval) {
          clearInterval(interval);
          typingIntervals.delete(jid);
        }
        return;
      }

      // Send immediately, then repeat every 4s (Telegram expires typing after ~5s)
      const sendTyping = () => {
        tgFetch('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(
          () => {},
        );
      };
      sendTyping();
      if (!typingIntervals.has(jid)) {
        typingIntervals.set(jid, setInterval(sendTyping, 4000));
      }
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return (
        jid === TELEGRAM_JID ||
        jid === TELEGRAM_OWNER_JID ||
        jid.startsWith('tg:')
      );
    },

    async disconnect() {
      polling = false;
      connected = false;
    },
  };

  return channel;
});
