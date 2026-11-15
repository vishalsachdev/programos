import { describe, expect, it } from 'vitest';

import { buildRecentWorkSection } from './recent-work.js';
import type { NewMessage } from './types.js';

function message(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: 'message-1',
    chat_jid: 'webhook-email:thread-1',
    sender: 'person@example.edu',
    sender_name: 'Person',
    content: 'Current message',
    timestamp: '2026-09-09T12:00:00.000Z',
    ...overrides,
  };
}

describe('buildRecentWorkSection', () => {
  it('builds a scoped recovery index with quoted anchors and audit pointers', () => {
    const section = buildRecentWorkSection({
      chatJid: 'webhook-email:thread-1',
      repoRevision: 'abc123',
      currentMessages: [
        message({
          id: 'current-1',
          content: 'Yes',
          reply_to_message_id: 'prior-bot',
          reply_to_message_content: 'Should I send the SAS welcome reply now?',
          reply_to_sender_name: 'Coordinator',
        }),
      ],
      history: [
        message({
          id: 'prior-user',
          content: 'Can you draft the SAS welcome reply?',
          timestamp: '2026-09-09T11:55:00.000Z',
        }),
        message({
          id: 'prior-bot',
          sender: 'Coordinator',
          sender_name: 'Coordinator',
          content: 'Draft ready. Should I send it now?',
          timestamp: '2026-09-09T11:56:00.000Z',
          is_from_me: true,
          is_bot_message: true,
        }),
      ],
    });

    expect(section).toContain('<recent_work_index>');
    expect(section).toContain('Chat/thread: webhook-email:thread-1');
    expect(section).toContain('KB/allowlist pinned revision now: abc123');
    expect(section).toContain(
      'reply_to=prior-bot from=Coordinator text="Should I send the SAS welcome reply now?"',
    );
    expect(section).toContain(
      'outbound id=prior-bot at=2026-09-09T11:56:00.000Z sender=Coordinator audit=discussions/audit-log/2026-09-09.md',
    );
    expect(section).toContain(
      'Do not read an entire recent day log by default.',
    );
  });

  it('returns null when there is no scoped recovery material', () => {
    expect(
      buildRecentWorkSection({
        chatJid: 'tg:1',
        currentMessages: [message({ chat_jid: 'tg:1' })],
        history: [],
      }),
    ).toBeNull();
  });
});
