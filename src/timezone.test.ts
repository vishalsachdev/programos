import { describe, it, expect } from 'vitest';

import {
  formatLocalTime,
  isValidTimezone,
  isWeekendCalendarDate,
  localDateYmd,
  localTimeHms,
  localWeekdayDate,
  resolveTimezone,
  weekdayOfCalendarDate,
  zonedDayStartUtc,
} from './timezone.js';

// --- formatLocalTime ---

describe('formatLocalTime', () => {
  it('converts UTC to local time display', () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime(
      '2026-02-04T18:30:00.000Z',
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('handles different timezones', () => {
    // Same UTC time should produce different local times
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });

  it('does not throw on invalid timezone, falls back to UTC', () => {
    expect(() =>
      formatLocalTime('2026-01-01T00:00:00.000Z', 'IST-2'),
    ).not.toThrow();
    const result = formatLocalTime('2026-01-01T12:00:00.000Z', 'IST-2');
    // Should format as UTC (noon UTC = 12:00 PM)
    expect(result).toContain('12:00');
    expect(result).toContain('PM');
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA identifiers', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Asia/Jerusalem')).toBe(true);
  });

  it('rejects invalid timezone strings', () => {
    expect(isValidTimezone('IST-2')).toBe(false);
    expect(isValidTimezone('XYZ+3')).toBe(false);
  });

  it('rejects empty and garbage strings', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('NotATimezone')).toBe(false);
  });
});

describe('resolveTimezone', () => {
  it('returns the timezone if valid', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for invalid timezone', () => {
    expect(resolveTimezone('IST-2')).toBe('UTC');
    expect(resolveTimezone('')).toBe('UTC');
  });
});

// --- localDateYmd ---

describe('localDateYmd', () => {
  it('returns the local date, not the UTC date, for evenings west of UTC', () => {
    // 2026-05-11T02:30:00Z = 2026-05-10 21:30 in America/Chicago (CDT, UTC-5)
    const lateEvening = new Date('2026-05-11T02:30:00.000Z');
    expect(localDateYmd('America/Chicago', lateEvening)).toBe('2026-05-10');
  });

  it('returns the UTC date for the same instant when UTC is requested', () => {
    const lateEvening = new Date('2026-05-11T02:30:00.000Z');
    expect(localDateYmd('UTC', lateEvening)).toBe('2026-05-11');
  });

  it('falls back to UTC for invalid timezone', () => {
    const noon = new Date('2026-05-10T12:00:00.000Z');
    expect(localDateYmd('Not/AZone', noon)).toBe('2026-05-10');
  });
});

// --- localTimeHms ---

describe('localTimeHms', () => {
  it('returns 24-hour HH:MM:SS in the requested timezone', () => {
    // 2026-05-11T02:30:45Z = 21:30:45 in America/Chicago (CDT, UTC-5)
    const instant = new Date('2026-05-11T02:30:45.000Z');
    expect(localTimeHms('America/Chicago', instant)).toBe('21:30:45');
  });

  it('pads single-digit components with leading zeros', () => {
    // 2026-05-10T13:04:09Z = 08:04:09 in America/Chicago (CDT, UTC-5)
    const instant = new Date('2026-05-10T13:04:09.000Z');
    expect(localTimeHms('America/Chicago', instant)).toBe('08:04:09');
  });

  it('normalizes midnight to "00" rather than "24"', () => {
    // 2026-05-11T05:00:00Z = 00:00:00 in America/Chicago (CDT, UTC-5)
    const midnight = new Date('2026-05-11T05:00:00.000Z');
    expect(localTimeHms('America/Chicago', midnight)).toBe('00:00:00');
  });
});

// --- localWeekdayDate ---

describe('localWeekdayDate', () => {
  it('returns weekday-qualified date in the given timezone', () => {
    // 2026-06-12T23:30:00Z is still Friday June 12 in Chicago (18:30 CDT)
    const result = localWeekdayDate(
      'America/Chicago',
      new Date('2026-06-12T23:30:00.000Z'),
    );
    expect(result).toBe('Friday, June 12, 2026');
  });

  it('rolls to the local date, not the UTC date', () => {
    // 2026-06-13T03:30:00Z is Friday 22:30 in Chicago but Saturday in UTC
    const result = localWeekdayDate(
      'America/Chicago',
      new Date('2026-06-13T03:30:00.000Z'),
    );
    expect(result).toBe('Friday, June 12, 2026');
  });

  it('falls back to UTC on invalid timezone', () => {
    const result = localWeekdayDate(
      'not-a-tz',
      new Date('2026-06-13T03:30:00.000Z'),
    );
    expect(result).toBe('Saturday, June 13, 2026');
  });
});

// --- weekdayOfCalendarDate / isWeekendCalendarDate ---

describe('weekdayOfCalendarDate', () => {
  it('computes the weekday of a calendar date', () => {
    expect(weekdayOfCalendarDate('2026-06-12')).toBe('Friday');
    expect(weekdayOfCalendarDate('2026-06-13')).toBe('Saturday');
    expect(weekdayOfCalendarDate('2026-06-15')).toBe('Monday');
  });
});

describe('isWeekendCalendarDate', () => {
  it('flags Saturday and Sunday', () => {
    expect(isWeekendCalendarDate('2026-06-13')).toBe(true); // Sat
    expect(isWeekendCalendarDate('2026-06-14')).toBe(true); // Sun
    expect(isWeekendCalendarDate('2026-06-12')).toBe(false); // Fri
    expect(isWeekendCalendarDate('2026-06-15')).toBe(false); // Mon
  });
});

// --- zonedDayStartUtc ---

describe('zonedDayStartUtc', () => {
  it('starts the day at local midnight, not UTC midnight', () => {
    // Central is UTC-5 in July, so the Central day begins at 05:00Z.
    expect(zonedDayStartUtc('2026-07-31', 'America/Chicago')).toBe(
      '2026-07-31T05:00:00.000Z',
    );
  });

  it('tracks the standard-time offset in winter', () => {
    expect(zonedDayStartUtc('2026-01-15', 'America/Chicago')).toBe(
      '2026-01-15T06:00:00.000Z',
    );
  });

  it('is identity for UTC', () => {
    expect(zonedDayStartUtc('2026-07-31', 'UTC')).toBe(
      '2026-07-31T00:00:00.000Z',
    );
  });
});
