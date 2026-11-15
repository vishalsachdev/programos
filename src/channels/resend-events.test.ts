import { describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { IncomingMessage, ServerResponse } from 'http';

import { handleResendWebhookRequest } from './resend-events.js';

const SECRET_BYTES = crypto.randomBytes(24);
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

function makeReq(body: string, sign = true): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  const id = 'msg_test';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign
    ? 'v1,' +
      crypto
        .createHmac('sha256', SECRET_BYTES)
        .update(`${id}.${timestamp}.${body}`)
        .digest('base64')
    : 'v1,invalid';
  req.headers = {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': signature,
  };
  process.nextTick(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function makeRes(): ServerResponse & {
  statusCode?: number;
  done: Promise<void>;
} {
  let resolve: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const res = {
    statusCode: undefined as number | undefined,
    done,
    writeHead(code: number) {
      this.statusCode = code;
    },
    end() {
      resolve();
    },
  };
  return res as unknown as ServerResponse & {
    statusCode?: number;
    done: Promise<void>;
  };
}

describe('handleResendWebhookRequest', () => {
  it('writes an audit-log delivery-problem entry and pings admin on bounce', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const logDeliveryProblem = vi.fn();
    const body = JSON.stringify({
      type: 'email.bounced',
      data: {
        email_id: 'abc-123',
        to: ['sam@example.edu'],
        subject: 'Test subject',
        bounce: {
          message: 'general bounce',
          subType: 'General',
          diagnosticCode: ['smtp; 550 5.7.0 Local Policy Violation'],
        },
      },
    });
    const res = makeRes();
    handleResendWebhookRequest(makeReq(body), res, {
      webhookSecret: SECRET,
      pingAdminViaTelegram: ping,
      logDeliveryProblem,
    });
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(logDeliveryProblem).toHaveBeenCalledWith({
      type: 'bounced',
      to: 'sam@example.edu',
      subject: 'Test subject',
      resendId: 'abc-123',
      reason: 'smtp; 550 5.7.0 Local Policy Violation',
    });
    expect(ping).toHaveBeenCalledOnce();
  });

  it('does not log delivery problems for non-problem events', async () => {
    const logDeliveryProblem = vi.fn();
    const body = JSON.stringify({
      type: 'email.delivered',
      data: { email_id: 'abc-123', to: ['sam@example.edu'], subject: 's' },
    });
    const res = makeRes();
    handleResendWebhookRequest(makeReq(body), res, {
      webhookSecret: SECRET,
      pingAdminViaTelegram: vi.fn().mockResolvedValue(undefined),
      logDeliveryProblem,
    });
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(logDeliveryProblem).not.toHaveBeenCalled();
  });

  it.each([
    ['email.delivered', 'delivered'],
    ['email.bounced', 'bounced'],
  ])('records %s for delivery tracking', async (eventType, recorded) => {
    const recordDeliveryEvent = vi.fn();
    const body = JSON.stringify({
      type: eventType,
      data: { email_id: 'abc-123', to: ['sam@example.edu'], subject: 's' },
    });
    const res = makeRes();
    handleResendWebhookRequest(makeReq(body), res, {
      webhookSecret: SECRET,
      pingAdminViaTelegram: vi.fn().mockResolvedValue(undefined),
      logDeliveryProblem: vi.fn(),
      recordDeliveryEvent,
    });
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(recordDeliveryEvent).toHaveBeenCalledWith({
      resendId: 'abc-123',
      type: recorded,
      recipients: ['sam@example.edu'],
    });
  });

  it('does not treat email.sent as a delivery event', async () => {
    const recordDeliveryEvent = vi.fn();
    const body = JSON.stringify({
      type: 'email.sent',
      data: { email_id: 'abc-123', to: ['sam@example.edu'], subject: 's' },
    });
    const res = makeRes();
    handleResendWebhookRequest(makeReq(body), res, {
      webhookSecret: SECRET,
      pingAdminViaTelegram: vi.fn().mockResolvedValue(undefined),
      recordDeliveryEvent,
    });
    await res.done;

    expect(res.statusCode).toBe(200);
    expect(recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature without logging anything', async () => {
    const logDeliveryProblem = vi.fn();
    const body = JSON.stringify({
      type: 'email.bounced',
      data: { email_id: 'abc-123' },
    });
    const res = makeRes();
    handleResendWebhookRequest(makeReq(body, false), res, {
      webhookSecret: SECRET,
      pingAdminViaTelegram: vi.fn().mockResolvedValue(undefined),
      logDeliveryProblem,
    });
    await res.done;

    expect(res.statusCode).toBe(401);
    expect(logDeliveryProblem).not.toHaveBeenCalled();
  });

  it('returns a retryable server error when the admin notification fails', async () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      data: { email_id: 'abc-123', to: ['sam@example.edu'], subject: 's' },
    });
    const res = makeRes();
    handleResendWebhookRequest(makeReq(body), res, {
      webhookSecret: SECRET,
      pingAdminViaTelegram: vi.fn().mockRejectedValue(new Error('offline')),
    });
    await res.done;

    expect(res.statusCode).toBe(500);
  });
});
