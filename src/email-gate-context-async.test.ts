import { beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ order: [] as string[], forbid: false }));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./repo-reader.js', () => ({
  getRepoReader: () => ({
    readFile: () => {
      if (reads.forbid) throw new Error('retained snapshot must avoid Git');
      const finish = Date.now() + 200;
      while (Date.now() < finish) {
        /* controlled slow synchronous Git */
      }
      reads.order.push('read');
      return '| Person | person@example.edu |';
    },
    readFileAsync: async () => {
      if (reads.forbid) throw new Error('retained snapshot must avoid Git');
      await new Promise((resolve) => setTimeout(resolve, 200));
      reads.order.push('read');
      return '| Person | person@example.edu |';
    },
  }),
}));
import { resolveEmailGateContext } from './email-gate-context.js';

// R1-6: reproduces a 200ms policy read delaying a ready timer in ordinary and scheduled sends.
describe('email policy reads leave other work runnable', () => {
  beforeEach(() => {
    reads.order = [];
    reads.forbid = false;
  });

  it.each(['ordinary legacy reply', 'immediate scheduled email'])(
    '%s does not block a ready timer while reading the pinned list',
    async () => {
      const ready = new Promise<void>((resolve) =>
        setTimeout(() => {
          reads.order.push('timer');
          resolve();
        }, 0),
      );
      const context = await resolveEmailGateContext();
      await ready;
      expect(context.allowlist.senders.has('person@example.edu')).toBe(true);
      expect(reads.order).toEqual(['timer', 'read']);
    },
  );

  it('uses the retained turn list without any Git read', async () => {
    reads.forbid = true;
    const context = await resolveEmailGateContext([], {
      allowlistSnapshot: {
        available: true,
        source: 'admitted',
        senders: ['person@example.edu'],
      },
    });
    expect(context.allowlist.senders.has('person@example.edu')).toBe(true);
    expect(reads.order).toEqual([]);
  });
});
