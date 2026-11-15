import { describe, expect, it, vi } from 'vitest';
import { resolveEmailGateContext } from './email-gate-context.js';
import { processDelivery } from './delivery-processor.js';
import type { DeliveryState } from './delivery-state.js';
import { getChannelFactory } from './channels/registry.js';
import './channels/webhook.js';

vi.mock('./env.js', () => ({
  readEnvFile: () => ({
    WEBHOOK_SECRET: 'test-secret',
    RESEND_API_KEY: 're_test',
    SEND_FROM_EMAIL: 'program@example.org',
  }),
}));
vi.mock('./program-repo.js', () => ({
  CHECKOUT_OWNER: { uid: 1000, gid: 1000 },
  checkoutGitOptions: () => ({}),
  getProgramRepoPath: () => '/tmp/missing-body-gate-repo',
}));
vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({
    refresh: vi.fn(),
    readFile: () =>
      '| Person | person@example.edu |\n| Added advisor | advisor@example.org |',
    readFileAsync: async () =>
      '| Person | person@example.edu |\n| Added advisor | advisor@example.org |',
  }),
}));

const admitted = {
  type: 'webhook-email-v1',
  from: 'person@example.edu',
  subject: 'Question',
  messageId: '',
  kbConflictSnapshot: { files: {} },
  allowlistSnapshot: {
    available: true,
    source: 'admission',
    senders: ['person@example.edu'],
  },
};

// R1-4: catches current-list validation followed by old-list preparation terminalizing a legitimate turn.
describe('one email body allowlist snapshot across a turn', () => {
  it.each([false, true])(
    'repairs an added-advisor body instead of terminal preparation failure (resumed=%s)',
    async (resumed) => {
      const channel = getChannelFactory('webhook')?.({
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
        registeredGroups: () => ({}),
      });
      if (!channel) throw new Error('missing webhook');
      const jid = 'webhook-email:snapshot-race';
      channel.restoreDeliveryContext?.(jid, admitted);
      // The mirror now includes the advisor. A saved repair still carries the admission list.
      const context = { channelData: admitted, sender: admitted.from };
      const timestamp = '2026-10-07T15:00:00.000Z';
      let stored: DeliveryState | undefined = resumed
        ? {
            version: 1,
            phase: 'repair-required',
            chatJid: jid,
            targetTimestamp: timestamp,
            previousCursor: '',
            context,
            outcomeId: 'outcome',
            trustedBodyAddresses: [],
            gateReason: 'missing-reply-block',
            rejectedOutput: 'Completed work',
            attempt: 1,
            createdAt: timestamp,
          }
        : undefined;
      const gateContext = await resolveEmailGateContext(
        [],
        stored?.context.channelData ?? admitted,
      );
      let cursorWrites = 0;
      let preparations = 0;
      let businessRuns = 0;
      const result = await processDelivery(
        {
          chatJid: jid,
          prompt: 'Question',
          inboundText: 'Question',
          targetTimestamp: timestamp,
          previousCursor: '',
          context,
        },
        {
          loadState: () =>
            stored ? { status: 'valid', state: stored } : { status: 'none' },
          saveState: (state) => {
            stored = state;
            return { status: 'saved' };
          },
          clearState: () => {
            stored = undefined;
          },
          runBusinessAgent: async () => {
            businessRuns++;
            return {
              status: 'success',
              raw: '<reply>Contact advisor@example.org</reply>',
            };
          },
          runRepairAgent: async () => ({
            status: 'success',
            raw: '<reply>Contact advisor@example.org</reply>',
          }),
          validateOutput: (raw) =>
            channel.gateProfile.validate(raw, gateContext),
          prepareDelivery: (text, id, savedContext) => {
            preparations++;
            channel.restoreDeliveryContext?.(jid, savedContext.channelData);
            return channel.prepareDelivery(jid, text, id, gateContext);
          },
          deliverPrepared: async () => ({
            status: 'sent',
            providerId: 'must-not-send',
          }),
          writeCursor: () => {
            cursorWrites++;
          },
          auditSent: () => 'written',
          auditSuppressed: () => 'written',
          auditCcContext: () => 'written',
          auditDeadLetter: () => 'written',
          closeContainer: () => undefined,
          alertDeadLetter: async () => undefined,
          now: () => new Date(timestamp),
          newDeliveryId: () => 'delivery-race',
        },
      );
      expect(result).toEqual({ status: 'retry', attempt: resumed ? 2 : 1 });
      expect(stored).toMatchObject({
        phase: 'repair-required',
        gateReason: 'unverified-email-address: advisor@example.org',
      });
      expect(cursorWrites).toBe(0);
      expect(preparations).toBe(0);
      expect(businessRuns).toBe(resumed ? 0 : 1);
    },
  );
});
