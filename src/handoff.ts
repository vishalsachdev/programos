/**
 * The ONE definition of a handoff record.
 *
 * A handoff is something Coordinator handed to a person with a reply expected. It is
 * written by the agent into the working-context store, survives the store's
 * decay while unresolved, and is surfaced by the weekly exceptions digest once
 * past `ping_after` (or immediately when it carries a `gotcha`).
 *
 * Why this module exists: "what is a valid handoff" was once defined
 * independently in five places — the loader's `isEntry`, the decay exemption, the register's raw
 * field checks, the hand-written JSON example in the prompt, and Coordinator's actual
 * writing behavior. Independent definitions disagree (dropped on
 * read, `text` required that the writer never produces, invisible-but-immortal
 * partials, lexical date comparison vs permissive parsing, a placeholder
 * gotcha in the copyable example). Patching one call site moves the disagreement instead
 * of removing it.
 *
 * The rule now: every consumer — loader validation, decay exemption, the
 * exceptions register, and the agent-facing example — derives from
 * `parseHandoff` / `HANDOFF_EXAMPLE` in this file. If you need a new notion of
 * handoff validity, change it HERE, never at a call site.
 */

import { localDateYmd } from './timezone.js';

export interface Handoff {
  /** ISO date the handoff was SENT (not when it stops mattering). */
  ts: string;
  /** Recipient email. */
  to: string;
  /** What was handed over (path, doc name, or description). */
  artifact: string;
  /** What is expected back. */
  expected: string;
  /**
   * Exactly `YYYY-MM-DD`. The register compares this LEXICALLY against
   * today's `YYYY-MM-DD`, which is only correct when both strings share that
   * exact format — `08/10/2026` would read as permanently overdue and an ISO
   * timestamp would slip a day.
   */
  ping_after: string;
  resolved: boolean;
  /**
   * A real trap the recipient or Coordinator could fall into. Presence surfaces the
   * handoff in the digest IMMEDIATELY, before `ping_after` — so blank values
   * normalize to absent rather than firing a standing false alarm.
   */
  gotcha?: string;
}

/**
 * The canonical agent-facing example, dated relative to `now`. The prompt in
 * `buildWorkingContextSection` embeds `JSON.stringify(handoffExample(now))`,
 * so the example can never be invalid JSON, can never drift
 * from this schema, and can never expire — hardcoded dates would eventually
 * sit in the past, making a verbatim copy immediately overdue and a standing
 * false weekly alarm. Deliberately WITHOUT `gotcha`: the
 * example is copied verbatim, and a populated placeholder gotcha would
 * surface every copied handoff before its ping_after.
 */
export function handoffExample(
  now: Date,
  timeZone: string,
): Record<string, unknown> {
  // Local calendar dates in the DIGEST's zone, never UTC: the register
  // compares ping_after against today-in-timeZone, so a UTC-rendered date
  // from an evening Central session lands one day later and a Monday-due
  // handoff misses that Monday's digest — alerting a week late.
  const today = localDateYmd(timeZone, now);
  // Advance 7 CALENDAR days from the local date, not 168 absolute hours:
  // across a DST transition the +168h form lands 6 or 8 local days out.
  // Date.UTC arithmetic on the local date parts is DST-free.
  const [y, m, d] = today.split('-').map(Number);
  const pingAfter = new Date(Date.UTC(y, m - 1, d + 7))
    .toISOString()
    .slice(0, 10);
  return {
    ts: today,
    type: 'handoff',
    to: 'someone@example.edu',
    artifact: 'docs/kb-audit.md',
    expected: 'itemized corrections',
    ping_after: pingAfter,
    resolved: false,
  };
}

/**
 * A real calendar date in exactly `YYYY-MM-DD`. The shape regex alone is not
 * enough: JS rolls `2026-02-30` forward to March 2, so `Date.parse` succeeds
 * on impossible dates while the register keeps comparing the ORIGINAL string
 * and alerts on the wrong day. Round-tripping the parse back
 * to the input catches that.
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Parse an unknown value into a normalized Handoff, or null when it is not a
 * complete valid handoff.
 *
 * Null on ANY missing/malformed required field — a partial handoff must not
 * load at all: it would be decay-exempt forever, rejected by the register, and
 * hidden from prompt injection, i.e. immortal and invisible at once.
 * Coordinator writes NO `text` field on handoffs (structured fields
 * instead), so `text` plays no part here (requiring it would drop every
 * real handoff).
 *
 * Fields deliberately NOT validated: `text` and `refs`. They are decoration a
 * handoff may carry but the contract ignores — validity must not depend on
 * them, or a consumer with its own refs/text check silently disagrees with
 * this parser again (`refs: [null]` loaded nowhere, reported
 * nowhere).
 *
 * Normalization performed: blank `gotcha` → absent.
 */
export function parseHandoff(value: unknown): Handoff | null {
  if (typeof value !== 'object' || value === null) return null;
  const e = value as Record<string, unknown>;
  if (e.type !== 'handoff') return null;
  if (
    typeof e.ts !== 'string' ||
    Number.isNaN(Date.parse(e.ts)) ||
    !nonEmpty(e.to) ||
    !nonEmpty(e.artifact) ||
    !nonEmpty(e.expected) ||
    typeof e.ping_after !== 'string' ||
    !isCalendarDate(e.ping_after) ||
    typeof e.resolved !== 'boolean' ||
    (e.gotcha !== undefined && typeof e.gotcha !== 'string')
  ) {
    return null;
  }
  return {
    ts: e.ts,
    to: e.to,
    artifact: e.artifact,
    expected: e.expected,
    ping_after: e.ping_after,
    resolved: e.resolved,
    gotcha: nonEmpty(e.gotcha) ? e.gotcha : undefined,
  };
}
