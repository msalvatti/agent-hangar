/**
 * Unit tests for the cron adapter.
 *
 * Layer: unit.
 * Goal: the adapter turns the core scheduler's throwing API into the values the screens render —
 * a validation result, a describable sentence and a nullable next run — without adding any cron
 * semantics of its own.
 * Mocks: none — pure functions, a fixed `from` Date per case.
 */
import { describe, expect, it, vi } from 'vitest';

import { describeCron, nextRunAt, validateCron } from './cron';

describe('validateCron', () => {
  /** A well-formed expression is accepted, so the dialog's Save stays enabled. */
  it('accepts a well-formed expression', () => {
    expect(validateCron('0,30 8-10 1,15 */2 1-5')).toEqual({ ok: true });
  });

  /**
   * A field-count mistake is reported as a value rather than thrown, and the reason arrives
   * without the error class's `Invalid cron expression "…":` wrapper so it reads as field help.
   */
  it('reports a field-count mistake as a bare reason', () => {
    const result = validateCron('* * * *');
    expect(result).toEqual({
      ok: false,
      reason: 'expected 5 fields (minute hour day-of-month month day-of-week), got 4',
    });
  });

  /** An out-of-range value is rejected by the same parser the scheduler runs. */
  it('rejects a value outside its field range', () => {
    const result = validateCron('60 * * * *');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toBe(
      'Constraint error, got value 60 expected range 0-59',
    );
  });

  /**
   * Macros are refused: the stored expression is shown verbatim in the table and re-parsed by the
   * scheduler, which reads the five-field dialect only.
   */
  it('rejects a macro shorthand', () => {
    const result = validateCron('@daily');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('macros are not supported');
  });

  /** An empty field is a field-count mistake, not a crash, while the user is still typing. */
  it('rejects an empty expression', () => {
    expect(validateCron('').ok).toBe(false);
  });
});

describe('describeCron', () => {
  /** Every sentence shape the scheduler spells out reaches the screens unchanged. */
  it('renders each supported sentence shape with its timezone', () => {
    expect(describeCron('* * * * *', 'UTC')).toBe('every minute UTC');
    expect(describeCron('*/15 * * * *', 'UTC')).toBe('every 15 minutes UTC');
    expect(describeCron('30 * * * *', 'UTC')).toBe('every hour at :30 UTC');
    expect(describeCron('30 9 * * *', 'UTC')).toBe('every day at 09:30 UTC');
    expect(describeCron('0 9 * * 1-5', 'UTC')).toBe('every weekday at 09:00 UTC');
    expect(describeCron('0 9 * * 1,3', 'UTC')).toBe('every Mon, Wed at 09:00 UTC');
    expect(describeCron('0 9 15 * *', 'UTC')).toBe('on day 15 of every month at 09:00 UTC');
  });

  /** The timezone is part of the sentence, so two jobs on the same clock stay distinguishable. */
  it('names the timezone it was given', () => {
    expect(describeCron('0 9 * * *', 'America/Sao_Paulo')).toBe(
      'every day at 09:00 America/Sao_Paulo',
    );
  });

  /** A shape with no dedicated sentence quotes the expression — terse, but never wrong. */
  it('quotes an expression it has no sentence for', () => {
    expect(describeCron('0 9 15 * 1', 'UTC')).toBe('on schedule `0 9 15 * 1` UTC');
  });

  /**
   * A table row renders whatever the API returned, so an undescribable schedule degrades to its
   * reason instead of unmounting the row.
   */
  it('degrades to the reason instead of throwing', () => {
    expect(describeCron('nope', 'UTC')).toBe(
      'Invalid cron expression: expected 5 fields (minute hour day-of-month month day-of-week), got 1',
    );
  });

  /** An unknown timezone is a describable failure too, not an unhandled throw. */
  it('degrades when the timezone is unknown', () => {
    expect(describeCron('* * * * *', 'Not/AZone')).toBe(
      'Invalid cron expression: unknown IANA timezone: Not/AZone',
    );
  });
});

describe('nextRunAt', () => {
  /** The preview projects the next occurrence from an explicit instant. */
  it('finds the next occurrence in UTC', () => {
    const from = new Date('2026-08-19T12:00:00Z'); // Wednesday
    expect(nextRunAt({ cron: '0 9 * * 1', timezone: 'UTC' }, from)?.toISOString()).toBe(
      '2026-08-24T09:00:00.000Z',
    );
  });

  /** The occurrence is the local wall time of the job's zone, converted back to UTC. */
  it('projects the local wall time of a non-UTC zone', () => {
    const from = new Date('2026-08-19T12:00:00Z');
    // America/Sao_Paulo is UTC-3 year-round since the 2019 DST abolition.
    expect(
      nextRunAt({ cron: '0 9 * * 1', timezone: 'America/Sao_Paulo' }, from)?.toISOString(),
    ).toBe('2026-08-24T12:00:00.000Z');
  });

  /** Omitting `from` searches from now, which is what the live preview does while typing. */
  it('searches from now when no start is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00Z'));
    try {
      expect(nextRunAt({ cron: '0 9 * * 1', timezone: 'UTC' })?.toISOString()).toBe(
        '2026-08-24T09:00:00.000Z',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /** A schedule that can never fire yields `null` so the preview simply omits the next run. */
  it('returns null for an unsatisfiable schedule', () => {
    expect(
      nextRunAt({ cron: '0 0 30 2 *', timezone: 'UTC' }, new Date('2026-01-01T00:00:00Z')),
    ).toBeNull();
  });

  /** A half-typed expression yields `null` rather than throwing out of the preview's render. */
  it('returns null for an invalid expression', () => {
    expect(
      nextRunAt({ cron: 'nope', timezone: 'UTC' }, new Date('2026-01-01T00:00:00Z')),
    ).toBeNull();
  });
});
