/**
 * Unit tests for cron validation and next-run computation.
 *
 * Layer: unit.
 * Goal: the accepted dialect is exactly five fields in a known timezone, occurrences are strictly
 * increasing, and daylight-saving transitions produce the shifted UTC instants a scheduler must
 * honour.
 * Mocks: none, except one test that replaces `cron-parser` to prove a non-Error parser failure is
 * still wrapped.
 */
import { describe, expect, it, vi } from 'vitest';

import { InvalidCronError } from '../errors.ts';

import {
  CRON_FIELD_COUNT,
  isValidTimezone,
  nextRunAt,
  nextRuns,
  validateCronSpec,
} from './cron.ts';

/** Instant used wherever the starting point does not matter to the assertion. */
const EPOCH = new Date('2026-01-01T00:00:00.000Z');

/** One hour in milliseconds, used to express daylight-saving gaps. */
const HOUR_MS = 60 * 60 * 1000;

describe('isValidTimezone', () => {
  /**
   * Zone names the IANA database knows are accepted, including the two spellings of UTC that the
   * job form can produce.
   */
  it('accepts known IANA zone names', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Etc/UTC')).toBe(true);
    expect(isValidTimezone('America/Sao_Paulo')).toBe(true);
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
  });

  /**
   * An empty string, an unknown zone and a name with stray whitespace are all rejected; nothing
   * is trimmed silently, so a user sees the value they typed in the error.
   */
  it('rejects empty, unknown and untrimmed zone names', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('utc ')).toBe(false);
    expect(isValidTimezone(' UTC')).toBe(false);
  });
});

describe('validateCronSpec', () => {
  /**
   * The five-field dialect the UI documents is accepted and the expression comes back trimmed so
   * the stored value and the value handed to BullMQ are identical.
   */
  it('accepts five-field expressions and trims them', () => {
    expect(validateCronSpec({ cron: '* * * * *', timezone: 'UTC' })).toEqual({
      cron: '* * * * *',
      timezone: 'UTC',
    });
    expect(validateCronSpec({ cron: '  0 9 * * 1-5  ', timezone: 'Europe/Berlin' })).toEqual({
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Berlin',
    });
    expect(CRON_FIELD_COUNT).toBe(5);
  });

  /**
   * A seconds column would silently change the meaning of every stored schedule, so six fields
   * are rejected even though the parser understands them.
   */
  it('rejects a six-field expression', () => {
    expect(() => validateCronSpec({ cron: '* * * * * *', timezone: 'UTC' })).toThrow(
      /expected 5 fields \(minute hour day-of-month month day-of-week\), got 6/,
    );
  });

  /**
   * Macros parse but are not the documented dialect and would not round-trip through the UI's
   * cron field, so they are refused with a message pointing at the five-field form.
   */
  it('rejects macro shorthands', () => {
    expect(() => validateCronSpec({ cron: '@daily', timezone: 'UTC' })).toThrow(
      /macros are not supported/,
    );
  });

  /**
   * The parser treats an empty expression as "every minute"; reporting zero fields instead keeps
   * an accidentally blank input from becoming the busiest possible schedule.
   */
  it('rejects an empty or whitespace-only expression', () => {
    expect(() => validateCronSpec({ cron: '', timezone: 'UTC' })).toThrow(/got 0/);
    expect(() => validateCronSpec({ cron: '   ', timezone: 'UTC' })).toThrow(/got 0/);
  });

  /**
   * Field values outside their range and non-numeric junk reach the parser, whose message is
   * appended so the user learns which field is wrong.
   */
  it('wraps parser errors and quotes the offending expression', () => {
    expect(() => validateCronSpec({ cron: '60 * * * *', timezone: 'UTC' })).toThrow(
      /Invalid cron expression "60 \* \* \* \*".*0-59/,
    );
    expect(() => validateCronSpec({ cron: '* * * * 8', timezone: 'UTC' })).toThrow(/0-7/);
    expect(() => validateCronSpec({ cron: 'a b c d e', timezone: 'UTC' })).toThrow(
      /Invalid characters/,
    );
  });

  /**
   * An unknown timezone is caught before the parser sees it, so the message names the zone rather
   * than surfacing the parser's "unhandled timestamp".
   */
  it('rejects unknown and untrimmed timezones', () => {
    expect(() => validateCronSpec({ cron: '* * * * *', timezone: 'Mars/Olympus' })).toThrow(
      /unknown IANA timezone: Mars\/Olympus/,
    );
    expect(() => validateCronSpec({ cron: '* * * * *', timezone: '' })).toThrow(
      /unknown IANA timezone: $/,
    );
    expect(() => validateCronSpec({ cron: '* * * * *', timezone: 'utc ' })).toThrow(
      InvalidCronError,
    );
  });

  /**
   * Every rejection is the typed domain error carrying the offending expression, so the API can
   * map it to a field-level validation message without matching on text.
   */
  it('always throws InvalidCronError carrying the expression', () => {
    expect.assertions(2);
    try {
      validateCronSpec({ cron: '@daily', timezone: 'UTC' });
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCronError);
      expect((error as InvalidCronError).cron).toBe('@daily');
    }
  });

  /**
   * The parser is assumed to throw `Error`s, but a caught value is `unknown`; replacing the module
   * proves a non-Error failure still becomes an `InvalidCronError` rather than crashing the API.
   */
  it('wraps a non-Error parser failure', async () => {
    const failure: unknown = 'parser exploded';
    vi.resetModules();
    vi.doMock('cron-parser', () => ({
      CronExpressionParser: {
        parse: (): never => {
          throw failure;
        },
      },
    }));
    const module = await import('./cron.ts');
    expect(() => module.validateCronSpec({ cron: '* * * * *', timezone: 'UTC' })).toThrow(
      /parser exploded/,
    );
    vi.doUnmock('cron-parser');
    vi.resetModules();
  });
});

describe('nextRunAt', () => {
  /**
   * The bound is exclusive: asking from an instant that is itself a tick returns the following
   * one, so a run never re-triggers itself when the worker recomputes from its own start time.
   */
  it('returns the first occurrence strictly after the bound', () => {
    expect(nextRunAt({ cron: '* * * * *', timezone: 'UTC' }, EPOCH).toISOString()).toBe(
      '2026-01-01T00:01:00.000Z',
    );
    const onTick = new Date('2026-01-01T09:00:00.000Z');
    expect(nextRunAt({ cron: '0 9 * * *', timezone: 'UTC' }, onTick).toISOString()).toBe(
      '2026-01-02T09:00:00.000Z',
    );
  });

  /**
   * The timezone is part of the schedule, not a display detail: the same expression and the same
   * bound produce instants nine hours apart in UTC for Tokyo.
   */
  it('resolves the expression in the schedule timezone', () => {
    const utc = nextRunAt({ cron: '0 9 * * *', timezone: 'UTC' }, EPOCH);
    const tokyo = nextRunAt({ cron: '0 9 * * *', timezone: 'Asia/Tokyo' }, EPOCH);
    expect(utc.toISOString()).toBe('2026-01-01T09:00:00.000Z');
    expect(tokyo.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  /**
   * `UTC` and `Etc/UTC` are the same zone under different names and must not produce different
   * schedules depending on which one the timezone picker emitted.
   */
  it('treats UTC and Etc/UTC identically', () => {
    const spec = { cron: '0 9 * * *' };
    expect(nextRunAt({ ...spec, timezone: 'UTC' }, EPOCH).getTime()).toBe(
      nextRunAt({ ...spec, timezone: 'Etc/UTC' }, EPOCH).getTime(),
    );
  });

  /**
   * Validation happens before computation, so a bad schedule fails at the API boundary instead of
   * producing an invalid date the worker would store as `nextRunAt`.
   */
  it('validates before computing', () => {
    expect(() => nextRunAt({ cron: '@daily', timezone: 'UTC' }, EPOCH)).toThrow(InvalidCronError);
  });
});

describe('nextRuns', () => {
  /**
   * The preview line in the job dialog lists upcoming runs, which must be strictly increasing and
   * exactly as many as requested.
   */
  it('returns the requested number of strictly increasing occurrences', () => {
    const runs = nextRuns({ cron: '0 9 * * *', timezone: 'UTC' }, EPOCH, 3);
    expect(runs.map((run) => run.toISOString())).toEqual([
      '2026-01-01T09:00:00.000Z',
      '2026-01-02T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
    ]);
  });

  /**
   * Asking for fewer than one occurrence is a caller bug, not an empty result.
   */
  it('rejects a count below one', () => {
    expect(() => nextRuns({ cron: '0 9 * * *', timezone: 'UTC' }, EPOCH, 0)).toThrow(RangeError);
  });

  /**
   * Spring forward in Berlin: noon local is 11:00 UTC before the switch and 10:00 UTC after, so
   * two consecutive daily runs are 23 hours apart in real time.
   */
  it('produces a 23-hour gap across the Berlin spring-forward', () => {
    const runs = nextRuns(
      { cron: '0 12 * * *', timezone: 'Europe/Berlin' },
      new Date('2026-03-27T00:00:00.000Z'),
      3,
    );
    expect(runs[1]?.toISOString()).toBe('2026-03-28T11:00:00.000Z');
    expect(runs[2]?.toISOString()).toBe('2026-03-29T10:00:00.000Z');
    expect((runs[2]?.getTime() ?? 0) - (runs[1]?.getTime() ?? 0)).toBe(23 * HOUR_MS);
  });

  /**
   * Fall back in Berlin: the same two runs are 25 hours apart, the mirror image of the spring
   * case, which catches an implementation that adds a fixed 24 hours.
   */
  it('produces a 25-hour gap across the Berlin fall-back', () => {
    const runs = nextRuns(
      { cron: '0 12 * * *', timezone: 'Europe/Berlin' },
      new Date('2026-10-23T00:00:00.000Z'),
      3,
    );
    expect(runs[1]?.toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(runs[2]?.toISOString()).toBe('2026-10-25T11:00:00.000Z');
    expect((runs[2]?.getTime() ?? 0) - (runs[1]?.getTime() ?? 0)).toBe(25 * HOUR_MS);
  });

  /**
   * New York skips 02:00–03:00 local on 2026-03-08, so `30 2 * * *` has no wall time that day; the
   * run lands after the gap and the following day is back at 02:30 local (06:30 UTC in EDT).
   */
  it('resolves a wall time that does not exist on a spring-forward day', () => {
    const runs = nextRuns(
      { cron: '30 2 * * *', timezone: 'America/New_York' },
      new Date('2026-03-08T05:00:00.000Z'),
      2,
    );
    const gapStart = new Date('2026-03-08T07:00:00.000Z');
    expect(runs[0]?.getTime()).toBeGreaterThan(gapStart.getTime());
    expect(runs[1]?.toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });
});

describe('what the schedule refuses, and what it says', () => {
  /**
   * A count below one asks for no occurrences at all, which is a caller's mistake rather than an
   * empty answer — and the message names the value so the caller can see what it asked for. One is
   * the smallest real request and has to be answered.
   */
  it.each([0, -1])('refuses a request for %i occurrences, naming it', (count) => {
    expect(() => nextRuns({ cron: '0 3 * * *', timezone: 'UTC' }, new Date(), count)).toThrow(
      `count must be at least 1, got ${String(count)}`,
    );
  });

  /** One occurrence is the smallest request there is, and it is a real one. */
  it('answers a request for exactly one occurrence', () => {
    expect(
      nextRuns({ cron: '0 3 * * *', timezone: 'UTC' }, new Date('2026-01-01T00:00:00Z'), 1),
    ).toHaveLength(1);
  });

  /**
   * An empty timezone is not a zone, and `Intl` answers for it with the machine's own rather than
   * refusing — so a schedule saved with the field blank would run on whatever zone the host is set
   * to, which is not the one the operator chose.
   */
  it('refuses an empty timezone rather than falling back to the machine', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(() => validateCronSpec({ cron: '0 3 * * *', timezone: '' })).toThrow(
      'unknown IANA timezone: ',
    );
  });

  /**
   * A cron line is separated by whitespace, whatever the operator typed: a form that pastes two
   * spaces between fields is a form that saves a schedule, and split on a single space it becomes
   * a line of the wrong number of fields.
   */
  it('reads a schedule written with several spaces between its fields', () => {
    expect(validateCronSpec({ cron: '0  3  *  *  *', timezone: 'UTC' }).cron).toBe('0  3  *  *  *');
  });

  /**
   * The zone belongs to the schedule, not to the machine that evaluates it: without it the parser
   * computes occurrences in the host's zone, and a job set for three in the morning in Lisbon runs
   * at three in the morning wherever the worker happens to be.
   */
  it('computes occurrences in the schedule own zone', () => {
    const [first] = nextRuns(
      { cron: '0 3 * * *', timezone: 'Asia/Tokyo' },
      new Date('2026-01-01T00:00:00Z'),
      1,
    );

    expect(first?.toISOString()).toBe('2026-01-01T18:00:00.000Z');
  });

  /**
   * A parser failure is reported with the parser's own reason kept as the cause, which is the only
   * thing that says which field it choked on.
   */
  it('keeps the parser reason as the cause of an invalid expression', () => {
    const failure = (() => {
      try {
        validateCronSpec({ cron: '99 3 * * *', timezone: 'UTC' });
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(failure).toBeInstanceOf(InvalidCronError);
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });
});
