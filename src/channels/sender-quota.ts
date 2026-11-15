// G19 per-sender email turn cap (registry v9.12).
//
// Two levels: a person on the email allowlist gets PERSON cap turns per
// window; an agent principal (G52) or a sender the allowlist cannot vouch
// for gets the lower DEFAULT cap. The default cap is the loop backstop: it
// stops agent-to-agent reply loops. The person cap is higher so that a person
// who sends many genuine messages in one window does not lose the last ones.
//
// Counters are in memory and reset on process restart.

export const SENDER_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SENDER_CAP = 10;
export const DEFAULT_PERSON_SENDER_CAP = 30;
/** Waits between attempts after a transient Telegram failure. */
export const SENDER_CAP_ALERT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

export interface SenderQuotaResult {
  allowed: boolean;
  count: number;
  cap: number;
  windowStart: number | null;
  /**
   * This over-cap message carries the window's admin alert. Claimed once;
   * released (see releaseAlert) only when every send attempt failed, so a
   * later over-cap message can try again.
   */
  alert: boolean;
  /**
   * This over-cap message carries the window's one sender notice. Only a
   * person on the allowlist gets one, and it is never released: a second
   * notice in a window could feed a loop.
   */
  notice: boolean;
  /** The window's notice was claimed by an earlier message. */
  noticeAlreadySent: boolean;
}

export interface SenderQuota {
  check(sender: string, allowlistedPerson: boolean): SenderQuotaResult;
  rollback(sender: string, windowStart: number): void;
  releaseAlert(sender: string, windowStart: number): void;
}

/** A positive integer from the environment, else the fallback. */
export function parseSenderCap(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createSenderQuota(opts: {
  defaultCap: number;
  personCap: number;
  windowMs?: number;
  now?: () => number;
}): SenderQuota {
  const windowMs = opts.windowMs ?? SENDER_WINDOW_MS;
  const now = opts.now ?? Date.now;
  const turns = new Map<
    string,
    {
      count: number;
      windowStart: number;
      alertClaimed: boolean;
      noticeClaimed: boolean;
    }
  >();

  function entryFor(sender: string, windowStart: number) {
    const existing = turns.get((sender || '').toLowerCase().trim());
    return existing && existing.windowStart === windowStart
      ? existing
      : undefined;
  }

  return {
    check(sender, allowlistedPerson) {
      const cap = allowlistedPerson ? opts.personCap : opts.defaultCap;
      const quiet = { alert: false, notice: false, noticeAlreadySent: false };
      const key = (sender || '').toLowerCase().trim();
      if (!key) {
        return { allowed: true, count: 0, cap, windowStart: null, ...quiet };
      }
      const at = now();
      const existing = turns.get(key);
      if (!existing || at - existing.windowStart > windowMs) {
        turns.set(key, {
          count: 1,
          windowStart: at,
          alertClaimed: false,
          noticeClaimed: false,
        });
        return { allowed: true, count: 1, cap, windowStart: at, ...quiet };
      }
      existing.count += 1;
      const allowed = existing.count <= cap;
      const result = {
        allowed,
        count: existing.count,
        cap,
        windowStart: existing.windowStart,
        ...quiet,
      };
      if (allowed) return result;
      result.noticeAlreadySent = existing.noticeClaimed;
      if (!existing.alertClaimed) {
        existing.alertClaimed = true;
        result.alert = true;
      }
      if (allowlistedPerson && !existing.noticeClaimed) {
        existing.noticeClaimed = true;
        result.notice = true;
      }
      return result;
    },

    rollback(sender, windowStart) {
      const existing = entryFor(sender, windowStart);
      if (!existing) return;
      existing.count -= 1;
      if (existing.count <= 0) {
        turns.delete((sender || '').toLowerCase().trim());
      }
    },

    releaseAlert(sender, windowStart) {
      const existing = entryFor(sender, windowStart);
      if (existing) existing.alertClaimed = false;
    },
  };
}

export type TelegramPingResult =
  | 'sent'
  | 'unconfigured'
  | 'failed-permanent'
  | 'failed-transient';

/**
 * Given the result of a first attempt, retries only transient failures,
 * waiting the given delays in turn.
 */
export async function retryTransient(
  first: TelegramPingResult,
  attempt: () => Promise<TelegramPingResult>,
  delaysMs: number[],
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<TelegramPingResult> {
  let result = first;
  for (const delay of delaysMs) {
    if (result !== 'failed-transient') break;
    await sleep(delay);
    result = await attempt();
  }
  return result;
}

/**
 * The CC for a sender notice: Avery's address, only when the alert did not
 * reach him and the send's own allowlist snapshot will let every CC address
 * through (the send drops a non-allowlisted CC, and the notice must not then
 * claim he was told). Returns the bare addresses, comma-joined, because the
 * send checks each comma-separated raw value against the allowlist and would
 * drop a display-name form.
 */
export function chooseNoticeCc(args: {
  alertSent: boolean;
  fallbackCc: string | undefined;
  fallbackCcAddresses: string[];
  allowlist: { available: boolean; senders: Set<string> };
}): string | undefined {
  if (args.alertSent || !args.fallbackCc) return undefined;
  if (!args.allowlist.available || args.fallbackCcAddresses.length === 0) {
    return undefined;
  }
  const bare = args.fallbackCcAddresses.map((addr) => addr.toLowerCase());
  return bare.every((addr) => args.allowlist.senders.has(addr))
    ? bare.join(', ')
    : undefined;
}

/** e.g. "October 24, 2026 at 9:33 AM CDT". */
export function formatCentralTime(ms: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

export interface SenderCapEvent {
  from: string;
  subject: string | undefined;
  messageId: string | undefined;
  count: number;
  cap: number;
  resetAt: string;
  allowlistedPerson: boolean;
  /** 'sending': this message carries the notice; 'sent-earlier': an earlier one did. */
  notice: 'sending' | 'sent-earlier' | 'none';
}

/** Telegram alert to Avery (G30 named exception, v9.12). */
export function buildSenderCapAlert(event: SenderCapEvent): string {
  const subject = (event.subject || '(no subject)').slice(0, 200);
  const notice = {
    sending: 'Coordinator is sending the sender one notice.',
    'sent-earlier':
      "The sender's one notice for this window went with an earlier message; the log has its result.",
    none: 'No notice goes to the sender.',
  }[event.notice];
  return [
    'Coordinator sender cap reached (G19)',
    `From: ${event.from} (${event.allowlistedPerson ? 'person on the allowlist' : 'agent principal or unverified sender'})`,
    `Messages in this 24h window: ${event.count}, cap ${event.cap}`,
    `Resets: ${event.resetAt}`,
    `Subject: ${subject}`,
    `Message-ID: ${event.messageId || '(none)'}`,
    'The message is archived but Coordinator did not process it. Later messages from this sender before the reset are dropped without another alert.',
    notice,
  ].join('\n');
}

/** One notice per window to a person who reached the cap. */
export function buildSenderCapNotice(args: {
  cap: number;
  resetAt: string;
  operatorTold: boolean;
}): string {
  return (
    `Your message reached Coordinator, but Coordinator will not answer it automatically.\n\n` +
    `You have sent Coordinator ${args.cap} messages in the last 24 hours, which is the daily limit. ` +
    (args.operatorTold
      ? `Avery Morgan has been told about this message and can follow up. `
      : '') +
    `The limit resets on ${args.resetAt}.\n\n` +
    `Coordinator`
  );
}
