/**
 * Unit tests for the cron adapter.
 *
 * Layer: unit.
 * Goal: `validateCron` accepts/rejects every field shape; `describeCron` covers every supported
 * sentence shape plus the fallback and timezone suffix; `nextRunAt` finds the next match across
 * timezones and DST, and returns `null` for an unsatisfiable expression.
 * Mocks: none — pure functions, a fixed `from` Date per case.
 */
import { describe, expect, it } from 'vitest';

import { describeCron, nextRunAt, validateCron, weekdayName } from './cron';

describe('validateCron', () => {
  /** A 5-field expression with only wildcards is valid. */
  it('accepts a plain wildcard expression', () => {
    expect(validateCron('* * * * *')).toEqual({ ok: true });
  });

  /** Lists, ranges and steps in every field are valid together. */
  it('accepts lists, ranges and steps combined', () => {
    expect(validateCron('0,30 8-10 1,15 */2 1-5')).toEqual({ ok: true });
  });

  /** Fewer than 5 fields is rejected with a field-count reason. */
  it('rejects an expression with the wrong number of fields', () => {
    const result = validateCron('* * * *');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('5 fields');
  });

  /** More than 5 fields is rejected too. */
  it('rejects an expression with too many fields', () => {
    expect(validateCron('* * * * * *').ok).toBe(false);
  });

  /** A minute value above 59 is rejected. */
  it('rejects a minute value out of range', () => {
    expect(validateCron('60 * * * *').ok).toBe(false);
  });

  /** An hour value above 23 is rejected. */
  it('rejects an hour value out of range', () => {
    expect(validateCron('0 24 * * *').ok).toBe(false);
  });

  /** A day-of-month value above 31 is rejected. */
  it('rejects a day-of-month value out of range', () => {
    expect(validateCron('0 0 32 * *').ok).toBe(false);
  });

  /** A month value above 12 is rejected. */
  it('rejects a month value out of range', () => {
    expect(validateCron('0 0 1 13 *').ok).toBe(false);
  });

  /** A day-of-week value above 7 is rejected. */
  it('rejects a day-of-week value out of range', () => {
    expect(validateCron('0 0 * * 8').ok).toBe(false);
  });

  /** A field that is not a number, wildcard, range or step is rejected. */
  it('rejects a field that does not match the part pattern', () => {
    expect(validateCron('abc * * * *').ok).toBe(false);
  });

  /** A descending range (start greater than end) is rejected. */
  it('rejects a descending range', () => {
    expect(validateCron('0 10-5 * * *').ok).toBe(false);
  });

  /** A step suffix on a bare wildcard is valid. */
  it('accepts a step on a wildcard', () => {
    expect(validateCron('*/15 * * * *').ok).toBe(true);
  });

  /** More than one `/` in a part is rejected. */
  it('rejects a part with more than one slash', () => {
    expect(validateCron('1/2/3 * * * *').ok).toBe(false);
  });

  /** A non-numeric step suffix is rejected. */
  it('rejects a non-numeric step', () => {
    expect(validateCron('*/abc * * * *').ok).toBe(false);
  });

  /** More than one `-` in a range is rejected. */
  it('rejects a range with more than one dash', () => {
    expect(validateCron('1-2-3 * * * *').ok).toBe(false);
  });

  /** A non-numeric range end is rejected. */
  it('rejects a non-numeric range end', () => {
    expect(validateCron('1-abc * * * *').ok).toBe(false);
  });
});

describe('weekdayName', () => {
  /** Every valid day-of-week digit (0-7) maps to its weekday name, 0 and 7 both meaning Sunday. */
  it('maps every valid digit to a weekday name', () => {
    expect(weekdayName(0)).toBe('Sunday');
    expect(weekdayName(1)).toBe('Monday');
    expect(weekdayName(6)).toBe('Saturday');
    expect(weekdayName(7)).toBe('Sunday');
  });

  /** A value outside the valid range falls back to Sunday rather than throwing. */
  it('falls back to Sunday for an out-of-range value', () => {
    expect(weekdayName(-1)).toBe('Sunday');
  });
});

describe('describeCron', () => {
  /** The all-wildcard expression describes as running every minute. */
  it('describes every minute', () => {
    expect(describeCron('* * * * *')).toBe('Runs every minute');
  });

  /** A step-every-N-minutes expression describes as running every N minutes. */
  it('describes a minute step', () => {
    expect(describeCron('*/15 * * * *')).toBe('Runs every 15 minutes');
  });

  /** A fixed minute/hour with wildcard day/month/weekday describes a daily time. */
  it('describes a fixed daily time', () => {
    expect(describeCron('30 9 * * *')).toBe('Runs every day at 09:30');
  });

  /** A fixed time with a weekday range describes the range by name. */
  it('describes a weekday range', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Runs every Monday–Friday at 09:00');
  });

  /** A fixed time with a weekday list describes each name, comma-separated. */
  it('describes a weekday list', () => {
    expect(describeCron('0 9 * * 1,3')).toBe('Runs every Monday, Wednesday at 09:00');
  });

  /** A fixed time with a day-of-month describes the day number. */
  it('describes a day-of-month schedule', () => {
    expect(describeCron('0 9 15 * *')).toBe('Runs on day 15 of the month at 09:00');
  });

  /** A shape with no dedicated sentence falls back to the raw expression. */
  it('falls back to the raw expression for an unsupported shape', () => {
    expect(describeCron('0 9 15 * 1')).toBe('Runs on schedule 0 9 15 * 1');
  });

  /** An invalid expression describes its own validation reason. */
  it('describes an invalid expression', () => {
    expect(describeCron('nope')).toContain('Invalid cron expression:');
  });

  /** A timezone, when given, is appended in parentheses; omitted otherwise. */
  it('appends the timezone only when given', () => {
    expect(describeCron('* * * * *', 'UTC')).toBe('Runs every minute (UTC)');
    expect(describeCron('* * * * *')).toBe('Runs every minute');
  });
});

describe('nextRunAt', () => {
  /** A weekly Monday 09:00 UTC schedule, searched from a Wednesday, lands on the next Monday. */
  it('finds the next Monday 09:00 in UTC', () => {
    const from = new Date('2026-08-19T12:00:00Z'); // Wednesday
    const result = nextRunAt({ cron: '0 9 * * 1', timezone: 'UTC' }, from);
    expect(result?.toISOString()).toBe('2026-08-24T09:00:00.000Z');
  });

  /** The same schedule in a non-UTC timezone lands on 09:00 local time, converted to UTC. */
  it('finds the next Monday 09:00 in America/Sao_Paulo', () => {
    const from = new Date('2026-08-19T12:00:00Z'); // Wednesday
    const result = nextRunAt({ cron: '0 9 * * 1', timezone: 'America/Sao_Paulo' }, from);
    // America/Sao_Paulo is UTC-3 year-round since the 2019 DST abolition.
    expect(result?.toISOString()).toBe('2026-08-24T12:00:00.000Z');
  });

  /** A daily schedule still lands on the same local hour across a DST transition. */
  it('keeps the local hour across a DST transition in Europe/Berlin', () => {
    const from = new Date('2026-03-28T12:00:00Z'); // the weekend Europe/Berlin springs forward
    const result = nextRunAt({ cron: '0 3 * * *', timezone: 'Europe/Berlin' }, from);
    expect(result).not.toBeNull();
    const matched = result ?? new Date(0);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
    const formattedParts = formatter.formatToParts(matched);
    const lookup = new Map(formattedParts.map((part) => [part.type, part.value]));
    const localHour = lookup.get('hour');
    const localMinute = lookup.get('minute');
    const localTime = String(localHour) + ':' + String(localMinute);
    expect(localTime).toBe('03:00');
  });

  /** A day-of-month that never occurs (30 February) is unsatisfiable within the search horizon. */
  it('returns null for an unsatisfiable expression', () => {
    const result = nextRunAt(
      { cron: '0 0 30 2 *', timezone: 'UTC' },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(result).toBeNull();
  });

  /** An invalid cron expression returns null without searching. */
  it('returns null for an invalid expression', () => {
    expect(nextRunAt({ cron: 'nope', timezone: 'UTC' })).toBeNull();
  });

  /** A minute step-every-N field is honoured when projecting the next match. */
  it('matches a minute step field', () => {
    const from = new Date('2026-08-19T09:05:00Z');
    const result = nextRunAt({ cron: '*/20 9 * * *', timezone: 'UTC' }, from);
    expect(result?.toISOString()).toBe('2026-08-19T09:20:00.000Z');
  });

  /** A weekday range field (`1-5`) matches any day within the range. */
  it('matches within a weekday range', () => {
    const from = new Date('2026-08-16T00:00:00Z'); // Sunday
    const result = nextRunAt({ cron: '0 9 * * 1-5', timezone: 'UTC' }, from);
    expect(result?.toISOString()).toBe('2026-08-17T09:00:00.000Z'); // Monday
  });

  /** When both day-of-month and day-of-week are restricted, either match is sufficient (OR). */
  it('matches on day-of-month OR day-of-week when both are restricted', () => {
    const from = new Date('2026-08-01T00:00:00Z'); // Saturday
    // Day 15 or Monday, whichever comes first.
    const result = nextRunAt({ cron: '0 0 15 * 1', timezone: 'UTC' }, from);
    // The next Monday (Aug 3) comes before day 15.
    expect(result?.toISOString()).toBe('2026-08-03T00:00:00.000Z');
  });
});
