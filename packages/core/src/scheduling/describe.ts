/**
 * Human-readable rendering of a cron schedule.
 *
 * Layer: domain (pure).
 *
 * The job dialog shows the expression in a monospace field and this sentence underneath it, so a
 * user who does not read cron can still tell what they configured.
 *
 * Each field is first reduced to a coarse shape (`any`, `num`, `step`, …); the concatenation of
 * the five shapes selects one sentence template. Only the shapes people actually write are
 * spelled out — anything else quotes the expression, which is terse but never wrong.
 */
import { validateCronSpec } from './cron.js';
import type { CronSpec } from './types.js';

/** Weekday names indexed by cron day-of-week number; 7 wraps back to Sunday. */
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Uppercase three-letter aliases the cron dialect accepts, aligned with {@link WEEKDAY_NAMES}. */
const WEEKDAY_ALIASES: readonly string[] = WEEKDAY_NAMES.map((name) => name.toUpperCase());

/** Matches an every-N-minutes step expression such as `*​/15`. */
const EVERY_N_MINUTES = /^\*\/[0-9]+$/;

/** Matches a plain non-negative integer field. */
const PLAIN_NUMBER = /^[0-9]+$/;

/** Matches a single day-of-week number; both `0` and `7` mean Sunday. */
const WEEKDAY_NUMBER = /^[0-7]$/;

/** The Monday-to-Friday day-of-week field, spelled out as its own sentence. */
const WEEKDAYS_FIELD = '1-5';

/** Characters that separate the entries of a day-of-week list. */
const LIST_SEPARATOR = ',';

/** Width of a zero-padded clock field, as `HH:MM` is written. */
const CLOCK_FIELD_WIDTH = 2;

/** A schedule split into its fields plus the shape key that selects a sentence template. */
interface ParsedSchedule {
  minute: string;
  hour: string;
  dayOfMonth: string;
  /** Weekday display names when the day-of-week field is a list of days; empty otherwise. */
  weekdays: readonly string[];
  /** Space-separated shapes of the five fields, in order. */
  shape: string;
}

/**
 * Renders a field as a two-digit zero-padded number.
 *
 * @param value - Hour or minute field, already known to be numeric.
 * @returns The value padded to two characters.
 */
function pad(value: string): string {
  return value.padStart(CLOCK_FIELD_WIDTH, '0');
}

/**
 * Resolves one day-of-week token to its display name.
 *
 * @param token - A number (`0`–`7`) or a three-letter alias such as `MON`.
 * @returns The weekday name, or `null` when the token names no single day.
 */
function weekdayName(token: string): string | null {
  const index = WEEKDAY_NUMBER.test(token)
    ? Number(token) % WEEKDAY_NAMES.length
    : WEEKDAY_ALIASES.indexOf(token.toUpperCase());
  return WEEKDAY_NAMES[index] ?? null;
}

/**
 * Resolves a comma-separated day-of-week list to display names.
 *
 * @param field - The day-of-week field, e.g. `1,3` or `MON`.
 * @returns The names in the order written, or an empty array when any token names no single day.
 */
function weekdayNames(field: string): string[] {
  const names: string[] = [];
  for (const token of field.split(LIST_SEPARATOR)) {
    const name = weekdayName(token);
    if (name === null) {
      return [];
    }
    names.push(name);
  }
  return names;
}

/**
 * Reduces the minute field to a shape.
 *
 * @param field - The minute field.
 * @returns `any` for `*`, `step` for `*​/N`, `num` for a plain number, `other` otherwise.
 */
function minuteShape(field: string): string {
  if (field === '*') {
    return 'any';
  }
  if (EVERY_N_MINUTES.test(field)) {
    return 'step';
  }
  return PLAIN_NUMBER.test(field) ? 'num' : 'other';
}

/**
 * Reduces a field that is either a wildcard or a plain number to a shape.
 *
 * @param field - The hour, day-of-month or month field.
 * @returns `any` for `*`, `num` for a plain number, `other` otherwise.
 */
function numericShape(field: string): string {
  if (field === '*') {
    return 'any';
  }
  return PLAIN_NUMBER.test(field) ? 'num' : 'other';
}

/**
 * Reduces the day-of-week field to a shape.
 *
 * @param field - The day-of-week field.
 * @param weekdays - Display names resolved from the field; empty when it is not a day list.
 * @returns `any`, `weekdays` for Monday-to-Friday, `names` for a day list, `other` otherwise.
 */
function dayOfWeekShape(field: string, weekdays: readonly string[]): string {
  if (field === '*') {
    return 'any';
  }
  if (field === WEEKDAYS_FIELD) {
    return 'weekdays';
  }
  return weekdays.length > 0 ? 'names' : 'other';
}

/**
 * Splits a validated expression into fields and computes its shape key.
 *
 * @param cron - Trimmed, validated expression with exactly five fields.
 * @returns The parsed schedule.
 */
function parseSchedule(cron: string): ParsedSchedule {
  // The expression is validated before it gets here, so exactly five fields are present.
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.split(/\s+/) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const weekdays = weekdayNames(dayOfWeek);
  const shape = [
    minuteShape(minute),
    numericShape(hour),
    numericShape(dayOfMonth),
    numericShape(month),
    dayOfWeekShape(dayOfWeek, weekdays),
  ].join(' ');
  return { minute, hour, dayOfMonth, weekdays, shape };
}

/**
 * Renders the schedule clause, without the timezone suffix.
 *
 * @param parsed - Parsed schedule.
 * @param cron - Trimmed expression, quoted by the fallback.
 * @returns The clause describing when the job runs.
 */
function describeShape(parsed: ParsedSchedule, cron: string): string {
  const { minute, hour, dayOfMonth, weekdays } = parsed;
  const at = `${pad(hour)}:${pad(minute)}`;
  switch (parsed.shape) {
    case 'any any any any any':
      return 'every minute';
    case 'step any any any any':
      return `every ${minute.slice('*/'.length)} minutes`;
    case 'num any any any any':
      return `every hour at :${pad(minute)}`;
    case 'num num any any any':
      return `every day at ${at}`;
    case 'num num any any weekdays':
      return `every weekday at ${at}`;
    case 'num num any any names':
      return `every ${weekdays.join(', ')} at ${at}`;
    case 'num num num any any':
      return `on day ${dayOfMonth} of every month at ${at}`;
    default:
      return `on schedule \`${cron}\``;
  }
}

/**
 * Describes a schedule in one sentence, always ending with the timezone.
 *
 * @param spec - Schedule to describe; validated first.
 * @returns A sentence such as `every day at 02:00 UTC`.
 * @throws InvalidCronError When the schedule is invalid.
 */
export function describeCron(spec: CronSpec): string {
  const validated = validateCronSpec(spec);
  return `${describeShape(parseSchedule(validated.cron), validated.cron)} ${validated.timezone}`;
}
