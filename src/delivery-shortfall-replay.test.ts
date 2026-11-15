/**
 * Acknowledgement safety for persisted G46 delivery-shortfall alerts.
 *
 * Round 3 review, P1: the flush deleted the whole pending table BEFORE any
 * alerter promise settled, so a process that died mid-alert (or an alerter that
 * failed) lost the only human notification that mail was not delivered. A
 * pending alert may only leave the table once a channel has confirmed it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getPendingDeliveryShortfalls,
  storePendingDeliveryShortfall,
} from './db.js';
import {
  reportDeliveryShortfall,
  setDeliveryShortfallAlerter,
} from './delivery-gate.js';

const SHORTFALL = {
  channel: 'email',
  context: 'program-email: Weekly KB Update',
  intended: ['a@example.edu'],
  sent: [],
  missed: ['a@example.edu'],
  reason: 'outbox-item-expired',
};

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  setDeliveryShortfallAlerter(null);
  _closeDatabase();
});

describe('persisted shortfall alert replay', () => {
  it('keeps the alert until the channel confirms delivery', async () => {
    storePendingDeliveryShortfall(SHORTFALL);

    let release!: () => void;
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDeliveryShortfallAlerter(() => delivered);

    // Still in flight: the row must not have been removed yet.
    await new Promise((r) => setTimeout(r, 10));
    expect(getPendingDeliveryShortfalls()).toHaveLength(1);

    release();
    await vi.waitFor(() =>
      expect(getPendingDeliveryShortfalls()).toHaveLength(0),
    );
  });

  it('keeps the alert when the channel fails, and a later alerter re-sends it', async () => {
    storePendingDeliveryShortfall(SHORTFALL);

    setDeliveryShortfallAlerter(async () => {
      throw new Error('no alert channel');
    });
    await vi.waitFor(() =>
      expect(getPendingDeliveryShortfalls()).toHaveLength(1),
    );

    const seen: string[] = [];
    setDeliveryShortfallAlerter(async (s) => {
      seen.push(s.reason);
    });
    await vi.waitFor(() => expect(seen).toEqual(['outbox-item-expired']));
    expect(getPendingDeliveryShortfalls()).toHaveLength(0);
  });

  it('does not hand the same alert to a second alerter while the first is still trying', async () => {
    storePendingDeliveryShortfall(SHORTFALL);

    const first = vi.fn(
      () =>
        new Promise<void>(() => {
          /* still trying */
        }),
    );
    setDeliveryShortfallAlerter(first);
    await new Promise((r) => setTimeout(r, 10));

    const second = vi.fn(async () => {});
    setDeliveryShortfallAlerter(second);
    await new Promise((r) => setTimeout(r, 10));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(getPendingDeliveryShortfalls()).toHaveLength(1);
  });

  it('retries a queued alert on its own schedule, without waiting for a restart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      storePendingDeliveryShortfall(SHORTFALL);

      const attempts: string[] = [];
      let failNext = true;
      setDeliveryShortfallAlerter(async (s) => {
        attempts.push(s.reason);
        if (failNext) {
          failNext = false;
          throw new Error('alert channel down');
        }
      });
      await vi.waitFor(() => expect(attempts).toHaveLength(1));
      expect(getPendingDeliveryShortfalls()).toHaveLength(1);

      // The channel comes back; the queued alert goes out on the next sweep.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1_000);
      expect(attempts).toHaveLength(2);
      expect(getPendingDeliveryShortfalls()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists a live shortfall whose alert fails so it can be replayed', async () => {
    setDeliveryShortfallAlerter(async () => {
      throw new Error('telegram down');
    });

    reportDeliveryShortfall(SHORTFALL);

    await vi.waitFor(() =>
      expect(getPendingDeliveryShortfalls()).toHaveLength(1),
    );
  });
});
