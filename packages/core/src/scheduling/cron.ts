/**
 * Cron validation and next-run computation.
 *
 * Layer: domain (pure).
 *
 * The API validates a schedule here before it is persisted and before a Job Scheduler is
 * upserted; the worker recomputes the next run after every tick. Both must agree, so nothing
 * else parses a cron expression: every caller goes through {@link validateCronSpec}.
 *
 * The accepted dialect is deliberately narrower than what the parser understands — exactly five
 * fields, no seconds column and no `@macro` shorthands — because the stored expression is shown
 * verbatim in the UI and re-parsed by BullMQ, which reads the same five-field dialect.
 */
import { CronExpressionParser } from 'cron-parser';

import { InvalidCronError } from '../errors.js';

import type { CronSpec } from './types.js';

/** Number of whitespace-separated fields a valid expression has. */
export const CRON_FIELD_COUNT = 5;

/** Field names in order, quoted in validation messages. */
const CRON_FIELD_NAMES = 'minute hour day-of-month month day-of-week';

/**
 * Reports whether the runtime's IANA database knows a timezone name.
 *
 * Zone names arrive from the job form, so an unknown one must fail validation rather than make
 * `cron-parser` produce an `Invalid Date` far from the user's input.
 *
 * @param timezone - Candidate IANA zone name, e.g. `Europe/Lisbon`.
 * @returns `true` when `Intl` resolves the name; `false` for an empty or unknown one.
 */
export function isValidTimezone(timezone: string): boolean {
  if (timezone === '') {
    return false;
  }
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions();
    return resolved.timeZone.length > 0;
  } catch {
    return false;
  }
}

/**
 * Validates a schedule and returns it with the expression trimmed.
 *
 * @param spec - Candidate expression and timezone.
 * @returns The same schedule with surrounding whitespace removed from the expression.
 * @throws InvalidCronError When the expression uses a macro, does not have exactly
 *   {@link CRON_FIELD_COUNT} fields, names an unknown timezone, or the parser rejects it.
 */
export function validateCronSpec(spec: CronSpec): CronSpec {
  const cron = spec.cron.trim();
  if (cron.startsWith('@')) {
    throw new InvalidCronError(
      spec.cron,
      `macros are not supported; use ${CRON_FIELD_COUNT} fields (${CRON_FIELD_NAMES})`,
    );
  }
  const fields = cron === '' ? [] : cron.split(/\s+/);
  if (fields.length !== CRON_FIELD_COUNT) {
    throw new InvalidCronError(
      spec.cron,
      `expected ${CRON_FIELD_COUNT} fields (${CRON_FIELD_NAMES}), got ${fields.length}`,
    );
  }
  if (!isValidTimezone(spec.timezone)) {
    throw new InvalidCronError(spec.cron, `unknown IANA timezone: ${spec.timezone}`);
  }
  try {
    CronExpressionParser.parse(cron, { tz: spec.timezone });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new InvalidCronError(spec.cron, detail, { cause: error });
  }
  return { cron, timezone: spec.timezone };
}

/**
 * Parses a validated schedule into an iterator positioned at an instant.
 *
 * @param spec - Already validated schedule.
 * @param from - Exclusive lower bound handed to the parser as its current date.
 * @returns A parser iterator whose first `next()` is strictly after `from`.
 */
function iterate(spec: CronSpec, from: Date): ReturnType<typeof CronExpressionParser.parse> {
  return CronExpressionParser.parse(spec.cron, { currentDate: from, tz: spec.timezone });
}

/**
 * Computes the first occurrence strictly after an instant.
 *
 * @param spec - Schedule; validated before use.
 * @param from - Exclusive lower bound, typically the end of the previous run.
 * @returns The next occurrence, in UTC.
 * @throws InvalidCronError When the schedule is invalid.
 */
export function nextRunAt(spec: CronSpec, from: Date): Date {
  return iterate(validateCronSpec(spec), from).next().toDate();
}

/**
 * Computes consecutive occurrences strictly after an instant.
 *
 * Daylight-saving transitions are handled by the parser: consecutive daily runs in a zone that
 * shifts are 23 or 25 hours apart in UTC, and a wall time that does not exist on a spring-forward
 * day resolves to the first instant after the gap.
 *
 * @param spec - Schedule; validated before use.
 * @param from - Exclusive lower bound.
 * @param count - How many occurrences to return; must be at least 1.
 * @returns Strictly increasing occurrences, in UTC.
 * @throws RangeError When `count` is below 1.
 * @throws InvalidCronError When the schedule is invalid.
 */
export function nextRuns(spec: CronSpec, from: Date, count: number): Date[] {
  if (count < 1) {
    throw new RangeError(`count must be at least 1, got ${count}`);
  }
  return iterate(validateCronSpec(spec), from)
    .take(count)
    .map((occurrence) => occurrence.toDate());
}
