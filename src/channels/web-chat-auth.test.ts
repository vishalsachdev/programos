/**
 * Issue 55, the web chat listener: WEBCHAT_SECRET is checked with a
 * constant-time comparison. Right secret passes; wrong, empty, missing and
 * different-length headers get 401.
 */
import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const SECRET = 'web-chat-test-secret';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const routes = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }));
const onMessage = vi.fn();

vi.mock('../env.js', () => ({
  readEnvFile: () => ({ WEBCHAT_SECRET: 'web-chat-test-secret' }),
}));

vi.mock('./http-routes.js', () => ({
  registerHttpRoute: (route: string, handler: unknown) => {
    routes.handlers.set(route, handler);
  },
}));

import './web-chat.js';
import { getChannelFactory } from './registry.js';

/** Send one POST with this body to the /chat handler; resolves with its answer. */
function chat(
  authorization: string | undefined,
  body: string,
): Promise<{ status: number; body: string }> {
  const handler = routes.handlers.get('/chat') as Handler | undefined;
  if (!handler) throw new Error('/chat is not registered');
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers: authorization === undefined ? {} : { authorization },
  });
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      setHeader: () => undefined,
      writeHead: (code: number) => {
        status = code;
      },
      end: (text = '') => resolve({ status, body: String(text) }),
    };
    handler(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    // Past the secret check the handler reads the body.
    if (status === 0) {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    }
  });
}

beforeAll(async () => {
  const channel = getChannelFactory('web-chat')?.({
    onMessage,
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('web-chat channel not registered');
  await channel.connect();
});

describe('web chat: the WEBCHAT_SECRET check', () => {
  it('lets the right secret past the check (the body is then read and judged)', async () => {
    // An empty message is refused by the step after the check, with 400.
    expect(
      await chat(`Bearer ${SECRET}`, JSON.stringify({ message: ' ' })),
    ).toEqual({
      status: 400,
      body: JSON.stringify({ error: 'Empty message' }),
    });
  });

  it.each([
    [
      'a wrong secret of the same length',
      `Bearer ${'x'.repeat(SECRET.length)}`,
    ],
    ['a shorter secret', 'Bearer web'],
    ['a longer secret', `Bearer ${SECRET}-and-more`],
    ['the secret without "Bearer"', SECRET],
    ['an empty header', ''],
    ['a missing header', undefined],
  ])('answers 401 to %s and passes nothing on', async (_name, header) => {
    expect(await chat(header, JSON.stringify({ message: 'hello' }))).toEqual({
      status: 401,
      body: JSON.stringify({ error: 'Unauthorized' }),
    });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
