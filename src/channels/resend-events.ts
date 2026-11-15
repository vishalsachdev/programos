import crypto from 'crypto';
import { IncomingMessage, ServerResponse } from 'http';
import { logger } from '../logger.js';

// Verify a Resend (Svix) webhook signature. Secret format: whsec_<base64>.
// Signature header format: "v1,<base64> v1,<base64>" (space-separated list).
function verifyResendSignature(
  headers: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  secret: string,
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const toSign = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secretBytes)
    .update(toSign)
    .digest('base64');
  // Header can list multiple signatures; any match is valid.
  const expectedBuf = Buffer.from(expected);
  return headers.signature
    .split(' ')
    .map((s) => s.split(',')[1])
    .some((sig) => {
      if (!sig) return false;
      const sigBuf = Buffer.from(sig);
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    });
}

// Route /resend/webhook — delivery events (bounced, delivered, etc.)
export function handleResendWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    webhookSecret: string | undefined;
    pingAdminViaTelegram: (text: string) => Promise<void>;
    logDeliveryProblem?: (args: {
      type: string;
      to?: string;
      subject?: string;
      resendId?: string;
      reason?: string;
    }) => void;
    recordDeliveryEvent?: (args: {
      resendId: string;
      type: string;
      recipients: string[];
    }) => void;
  },
): void {
  const { webhookSecret, pingAdminViaTelegram, logDeliveryProblem } = deps;
  if (!webhookSecret) {
    res.writeHead(503);
    res.end('Resend webhook not configured');
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString();
    const svixHeaders = {
      id: req.headers['svix-id'] as string | undefined,
      timestamp: req.headers['svix-timestamp'] as string | undefined,
      signature: req.headers['svix-signature'] as string | undefined,
    };
    if (!verifyResendSignature(svixHeaders, rawBody, webhookSecret)) {
      logger.warn(
        { svixId: svixHeaders.id },
        'Resend webhook signature invalid',
      );
      res.writeHead(401);
      res.end('Invalid signature');
      return;
    }
    try {
      const event = JSON.parse(rawBody) as {
        type: string;
        data: {
          email_id?: string;
          to?: string[];
          subject?: string;
          bounce?: {
            message?: string;
            subType?: string;
            diagnosticCode?: string[];
          };
        };
      };
      const to = event.data.to?.[0];
      const subject = event.data.subject;
      const emailId = event.data.email_id;
      const outcome = event.type.replace('email.', '');
      if (
        emailId &&
        ['delivered', 'bounced', 'complained', 'failed'].includes(outcome)
      ) {
        // One event per impacted recipient; apply it to those only.
        deps.recordDeliveryEvent?.({
          resendId: emailId,
          type: outcome,
          recipients: event.data.to ?? [],
        });
      }
      logger.info(
        {
          type: event.type,
          to,
          subject,
          emailId,
          bounce: event.data.bounce,
        },
        'Resend delivery event',
      );
      const problem =
        event.type === 'email.bounced' ||
        event.type === 'email.complained' ||
        event.type === 'email.failed';
      if (problem) {
        const reason = event.data.bounce?.message || event.type;
        // Durable record FIRST — it must survive a Telegram outage that
        // outlasts Svix's retry window. logDeliveryProblem is idempotent on
        // the Resend event id, so 5xx-driven retries cannot duplicate it.
        logDeliveryProblem?.({
          type: event.type.replace('email.', ''),
          to,
          subject,
          resendId: emailId,
          reason: event.data.bounce?.diagnosticCode?.[0] || reason,
        });
        await pingAdminViaTelegram(
          `⚠️ Email ${event.type.replace('email.', '')}\n` +
            `To: ${to}\n` +
            `Subject: ${subject}\n` +
            `Reason: ${reason}`,
        );
      }
      res.writeHead(200);
      res.end('ok');
    } catch (err) {
      logger.error({ err }, 'Failed to process Resend webhook');
      if (err instanceof SyntaxError) {
        res.writeHead(400);
        res.end('Bad request');
      } else {
        res.writeHead(500);
        res.end('Notification failed');
      }
    }
  });
}
