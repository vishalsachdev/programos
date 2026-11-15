/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Return the current date as `YYYY-MM-DD` in the given timezone.
 * Used for audit-log file naming so a 9 PM Central message on May 10
 * writes to the May-10 file, not the UTC-rolled May-11 file.
 */
export function localDateYmd(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The UTC instant at which calendar date `ymd` begins in `timezone`.
 *
 * The inverse direction of localDateYmd: that maps an instant to its local
 * calendar date; this maps a calendar date back to its starting instant.
 * Needed wherever a local-date-keyed store (audit-log day files) must be
 * queried against a UTC-timestamp-keyed one (evals.db) over the same span.
 *
 * Single-offset correction: measure the zone's offset at the guessed instant
 * and apply it. On the two DST-transition days this can land an hour off,
 * which is immaterial for a day-window boundary.
 */
export function zonedDayStartUtc(ymd: string, timezone: string): string {
  const guess = Date.parse(`${ymd}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimezone(timezone),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return new Date(guess + (guess - asIfUtc)).toISOString();
}

/**
 * Return the current time as `HH:MM:SS` (24-hour) in the given timezone.
 * Used for audit-log entry headers so timestamps match local working context.
 */
export function localTimeHms(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: resolveTimezone(timezone),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // en-GB hour can be "24" at midnight in some runtimes — normalize to "00".
  const hh = get('hour') === '24' ? '00' : get('hour');
  return `${hh}:${get('minute')}:${get('second')}`;
}

/**
 * Current date with weekday, e.g. "Friday, June 12, 2026", in the given
 * timezone. Injected into agent context so weekdays are never derived by
 * the model — weekday→date arithmetic from memory can aim a task at
 * the wrong day.
 */
export function localWeekdayDate(
  timezone: string,
  now: Date = new Date(),
): string {
  return now.toLocaleDateString('en-US', {
    timeZone: resolveTimezone(timezone),
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Weekday name ("Saturday") of a calendar date `YYYY-MM-DD`. A calendar
 * date's weekday is timezone-independent, so this evaluates at UTC noon.
 */
export function weekdayOfCalendarDate(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  });
}

export function isWeekendCalendarDate(ymd: string): boolean {
  const weekday = weekdayOfCalendarDate(ymd);
  return weekday === 'Saturday' || weekday === 'Sunday';
}
