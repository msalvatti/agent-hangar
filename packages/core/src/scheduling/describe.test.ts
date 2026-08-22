/**
 * Unit tests for the human-readable cron description.
 *
 * Layer: unit.
 * Goal: every spelled-out schedule shape renders the exact sentence the job dialog shows, the
 * timezone is always appended, and unrecognised shapes fall back to quoting the expression.
 * Mocks: none.
 */
import { describe, expect, it } from 'vitest';

import { InvalidCronError } from '../errors.ts';

import { describeCron } from './describe.ts';

/**
 * Describes an expression in UTC unless another zone is given.
 *
 * @param cron - Expression to describe.
 * @param timezone - IANA zone name; defaults to UTC.
 * @returns The rendered sentence.
 */
function describeIn(cron: string, timezone = 'UTC'): string {
  return describeCron({ cron, timezone });
}

describe('describeCron', () => {
  /**
   * The busiest schedule has its own sentence rather than falling through to the quoted form.
   */
  it('describes every minute', () => {
    expect(describeIn('* * * * *')).toBe('every minute UTC');
  });

  /**
   * A minute step is the shape behind the "*​/30" schedules the UI mock-up shows.
   */
  it('describes a minute step', () => {
    expect(describeIn('*/15 * * * *')).toBe('every 15 minutes UTC');
    expect(describeIn('*/30 * * * *')).toBe('every 30 minutes UTC');
  });

  /**
   * A fixed minute with a wildcard hour is hourly; the minute is zero-padded so `5` reads `:05`.
   */
  it('describes an hourly schedule at a fixed minute', () => {
    expect(describeIn('15 * * * *')).toBe('every hour at :15 UTC');
    expect(describeIn('5 * * * *')).toBe('every hour at :05 UTC');
  });

  /**
   * The daily shape is the example the spec pins for the tooltip text.
   */
  it('describes a daily schedule', () => {
    expect(describeIn('0 2 * * *')).toBe('every day at 02:00 UTC');
  });

  /**
   * Monday-to-Friday has its own wording, and the zone suffix is the zone as stored.
   */
  it('describes a weekday schedule', () => {
    expect(describeIn('0 9 * * 1-5', 'Europe/Berlin')).toBe('every weekday at 09:00 Europe/Berlin');
  });

  /**
   * Explicit days are listed in the order written, numerically or by three-letter alias, with 0
   * and 7 both meaning Sunday.
   */
  it('describes explicit weekdays', () => {
    expect(describeIn('0 0 * * 1,3')).toBe('every Mon, Wed at 00:00 UTC');
    expect(describeIn('0 0 * * 0')).toBe('every Sun at 00:00 UTC');
    expect(describeIn('0 0 * * 7')).toBe('every Sun at 00:00 UTC');
    expect(describeIn('0 0 * * MON')).toBe('every Mon at 00:00 UTC');
    expect(describeIn('0 0 * * mon,fri')).toBe('every Mon, Fri at 00:00 UTC');
  });

  /**
   * A fixed day of month in every month is the last spelled-out shape.
   */
  it('describes a monthly schedule', () => {
    expect(describeIn('0 3 1 * *')).toBe('on day 1 of every month at 03:00 UTC');
  });

  /**
   * Shapes with no plain-English form quote the expression instead of guessing: a specific month,
   * an hour step, a minute range and a day-of-week range that is not Monday-to-Friday.
   */
  it('quotes shapes it does not spell out', () => {
    expect(describeIn('0 3 1 6 *')).toBe('on schedule `0 3 1 6 *` UTC');
    expect(describeIn('0 */2 * * *')).toBe('on schedule `0 */2 * * *` UTC');
    expect(describeIn('0-30 * * * *')).toBe('on schedule `0-30 * * * *` UTC');
    expect(describeIn('0 0 * * 1-3')).toBe('on schedule `0 0 * * 1-3` UTC');
    expect(describeIn('*/15 3 * * *')).toBe('on schedule `*/15 3 * * *` UTC');
    expect(describeIn('0 0 1 * 1')).toBe('on schedule `0 0 1 * 1` UTC');
    // A field that merely contains a shape this does spell out is not that shape: the step pattern
    // is anchored at both ends, and either anchor removed reads a list holding a step as one.
    expect(describeIn('1,*/15 * * * *')).toBe('on schedule `1,*/15 * * * *` UTC');
    expect(describeIn('*/15,7 * * * *')).toBe('on schedule `*/15,7 * * * *` UTC');
  });

  /**
   * A day-of-week token is a single digit or a three-letter alias. A token that merely begins or
   * ends with a digit — `12`, or the `07` a zero-padded form produces — names no day, and read as
   * one it would put a weekday name into the sentence that the schedule does not run on.
   */
  it.each(['07', '1-2'])('quotes a schedule whose day-of-week token is %s', (token) => {
    expect(describeIn(`0 0 * * ${token}`)).toBe(`on schedule \`0 0 * * ${token}\` UTC`);
  });

  /**
   * The expression is quoted after trimming, so a stored value and its description agree.
   */
  it('describes the trimmed expression', () => {
    expect(describeIn('  0 2 * * *  ')).toBe('every day at 02:00 UTC');
  });

  /**
   * Validation runs first, so the preview line surfaces the same error as saving would.
   */
  it('rejects an invalid schedule', () => {
    expect(() => describeIn('60 * * * *')).toThrow(InvalidCronError);
    expect(() => describeCron({ cron: '* * * * *', timezone: 'Mars/Olympus' })).toThrow(
      InvalidCronError,
    );
  });
});
