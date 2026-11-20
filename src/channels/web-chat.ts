/**
 * Web Chat channel.
 * Provides a REST API at /chat for a browser-based chat widget.
 *
 * POST /chat
 * Body: { "message": "user text", "session_id": "optional" }
 * Headers: Authorization: Bearer <WEBCHAT_SECRET>
 *
 * Response: Waits for agent, returns { "reply": "agent text", "session_id": "..." }
 * Uses CORS headers for cross-origin embedding on the Program site.
 */
import { registerChannel } from './registry.js';
import { registerHttpRoute } from './http-routes.js';
import { chatProfile } from '../delivery-gate.js';
import {
  deriveWebChatChatJid,
  isDerivedWebChatJid,
  normalizeWebChatSessionId,
} from './web-chat-session.js';
import { logger } from '../logger.js';
import { readEnvFile } from '../env.js';
import { bearerMatches } from '../secret-compare.js';
import { Channel, PreparedDelivery } from '../types.js';

registerChannel('web-chat', (opts) => {
  const env = readEnvFile(['WEBCHAT_SECRET']);
  const secret = env.WEBCHAT_SECRET;

  if (!secret) {
    logger.info('Web Chat channel: WEBCHAT_SECRET not set, skipping');
    return null;
  }

  let connected = false;
  const WEB_CHAT_JID = 'web-chat-program@program';

  // Pending response resolvers per session chat.
  const pendingReplies = new Map<string, Map<string, (text: string) => void>>();

  const channel: Channel = {
    name: 'web-chat',
    gateProfile: chatProfile,

    async connect() {
      connected = true;
      registerHttpRoute('/chat', handleRequest);
      logger.info('Web Chat channel ready (route: /chat)');
    },

    async prepareDelivery(jid: string, text: string, deliveryId: string) {
      return {
        status: 'prepared' as const,
        delivery: {
          channel: 'web-chat',
          deliveryId,
          jid,
          payload: { text },
        },
      };
    },

    async deliverPrepared(delivery: PreparedDelivery) {
      if (
        delivery.channel !== 'web-chat' ||
        !delivery.payload ||
        typeof delivery.payload !== 'object' ||
        typeof (delivery.payload as { text?: unknown }).text !== 'string'
      ) {
        return {
          status: 'failed' as const,
          reason: 'invalid-web-chat-delivery',
          retryable: false,
        };
      }
      const text = (delivery.payload as { text: string }).text;
      const jid = delivery.jid;
      const pendingForChat = pendingReplies.get(jid);
      const first = pendingForChat?.entries().next().value;
      if (first) {
        const [id, resolve] = first;
        pendingForChat!.delete(id);
        if (pendingForChat!.size === 0) {
          pendingReplies.delete(jid);
        }
        resolve(text);
        return { status: 'sent' as const };
      } else {
        logger.warn({ jid }, 'Web chat reply with no pending request');
        return {
          status: 'failed' as const,
          reason: 'no-pending-web-request',
          retryable: false,
        };
      }
    },

    isConnected() {
      return connected;
    },

    ownsJid(jid: string) {
      return jid === WEB_CHAT_JID || isDerivedWebChatJid(jid);
    },

    async disconnect() {
      connected = false;
    },
  };

  function handleRequest(
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
  ): void {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    // Check auth
    const authHeader = (req.headers['authorization'] || '') as string;
    if (!bearerMatches(authHeader, secret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const message = body.message || body.text || '';
        const senderName = body.name || 'Web User';
        const sessionId = normalizeWebChatSessionId(body.session_id);
        const chatJid = deriveWebChatChatJid(sessionId);

        if (!message.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Empty message' }));
          return;
        }

        const messageId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

        // Create a promise that resolves when the agent replies
        const replyPromise = new Promise<string>((resolve) => {
          let pendingForChat = pendingReplies.get(chatJid);
          if (!pendingForChat) {
            pendingForChat = new Map<string, (text: string) => void>();
            pendingReplies.set(chatJid, pendingForChat);
          }
          pendingForChat.set(messageId, resolve);

          // Timeout after 120 seconds
          setTimeout(() => {
            const currentPending = pendingReplies.get(chatJid);
            if (currentPending?.has(messageId)) {
              currentPending.delete(messageId);
              if (currentPending.size === 0) {
                pendingReplies.delete(chatJid);
              }
              resolve('Sorry, the request timed out. Please try again.');
            }
          }, 120000);
        });

        // Deliver to NanoClaw
        opts.onChatMetadata(
          chatJid,
          new Date().toISOString(),
          `Web Chat (${senderName})`,
          'web-chat',
          false,
        );
        opts.onMessage(chatJid, {
          id: messageId,
          chat_jid: chatJid,
          sender: `web:${sessionId}`,
          sender_name: senderName,
          content: message,
          timestamp: new Date().toISOString(),
        });

        logger.info(
          { senderName, message: message.slice(0, 100) },
          'Web chat message received',
        );

        // Wait for agent reply and return it
        replyPromise.then((reply) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ reply, session_id: sessionId }));
        });
      } catch (err: any) {
        logger.error({ err }, 'Web chat parse error');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });
  }

  return channel;
});
