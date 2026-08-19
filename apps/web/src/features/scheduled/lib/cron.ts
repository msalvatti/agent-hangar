// TEMP-STUB(W1-H): local implementation, swapped to `@agent-hangar/core` at rebase once W1-F merges
/**
 * Cron adapter: the single place this feature validates, describes and projects cron schedules.
 *
 * Layer: service (adapter).
 *
 * `packages/core`'s scheduling lane (W1-F) is not merged yet, so this file implements the same
 * signatures locally; nothing else in this feature imports cron logic directly.
 */

/** Result of {@link validateCron}. */
export type CronValidationResult = { ok: true } | { ok: false; reason: string };

/** A cron schedule paired with the IANA timezone it runs in. */
export interface CronSchedule {
  cron: string;
  timezone: string;
}

interface FieldRange {
  min: number;
  max: number;
  label: string;
}

/** Ranges of the 5 cron fields, in order; a tuple so every position is non-optional. */
const FIELD_RANGES: readonly [FieldRange, FieldRange, FieldRange, FieldRange, FieldRange] = [
  { min: 0, max: 59, label: 'minute' },
  { min: 0, max: 23, label: 'hour' },
  { min: 1, max: 31, label: 'day of month' },
  { min: 1, max: 12, label: 'month' },
  { min: 0, max: 7, label: 'day of week' },
];

const DIGITS_PATTERN = /^\d+$/;

/**
 * Splits a `field` into its 5 whitespace-separated parts, defaulting any missing position to an
 * empty string. Callers only reach a default when the field count was not already validated.
 *
 * @param cron - The cron expression.
 * @returns The 5 fields, in order.
 */
function splitFields(cron: string): [string, string, string, string, string] {
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = cron
    .trim()
    .split(/\s+/);
  return [minute, hour, dayOfMonth, month, dayOfWeek];
}

/**
 * Validates one comma-separated part of a field: `*`, a number, a range, or either with a
 * `/step` suffix.
 */
function validatePart(part: string, range: FieldRange): boolean {
  const segments = part.split('/');
  if (segments.length > 2) {
    return false;
  }
  // `String.prototype.split` always returns at least one element, so `span` (index 0) is never
  // actually missing; the default only satisfies the type checker.
  const [span = '', step] = segments;
  if (step !== undefined && !DIGITS_PATTERN.test(step)) {
    return false;
  }
  if (span === '*') {
    return true;
  }
  const rangeParts = span.split('-');
  if (rangeParts.length > 2) {
    return false;
  }
  const [startText, endText] = rangeParts;
  if (startText === undefined || !DIGITS_PATTERN.test(startText)) {
    return false;
  }
  if (endText !== undefined && !DIGITS_PATTERN.test(endText)) {
    return false;
  }
  const start = Number(startText);
  const end = endText === undefined ? start : Number(endText);
  return start >= range.min && end <= range.max && start <= end;
}

function validateField(field: string, range: FieldRange): boolean {
  return field.split(',').every((part) => validatePart(part, range));
}

/**
 * Validates a 5-field cron expression.
 *
 * @param cron - The cron expression (minute hour day-of-month month day-of-week).
 * @returns `{ ok: true }`, or `{ ok: false, reason }` naming the first invalid field.
 */
export function validateCron(cron: string): CronValidationResult {
  const rawFields = cron.trim().split(/\s+/);
  if (rawFields.length !== FIELD_RANGES.length) {
    return {
      ok: false,
      reason: `Cron expression must have ${String(FIELD_RANGES.length)} fields, got ${String(rawFields.length)}`,
    };
  }
  const fields = splitFields(cron);
  const checks: readonly [string, FieldRange][] = [
    [fields[0], FIELD_RANGES[0]],
    [fields[1], FIELD_RANGES[1]],
    [fields[2], FIELD_RANGES[2]],
    [fields[3], FIELD_RANGES[3]],
    [fields[4], FIELD_RANGES[4]],
  ];
  for (const [field, range] of checks) {
    if (!validateField(field, range)) {
      return { ok: false, reason: `Invalid ${range.label} field: "${field}"` };
    }
  }
  return { ok: true };
}

const WEEKDAY_NAMES: readonly [string, string, string, string, string, string, string] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * Weekday name for a day-of-week digit.
 *
 * @param value - A day-of-week digit; values outside 0-6 fall back to `Sunday` (callers only ever
 *   pass a validated cron digit, 0-7 with 7 also meaning Sunday, so this never fires in practice).
 * @returns The weekday's full name.
 */
export function weekdayName(value: number): string {
  return WEEKDAY_NAMES[value % 7] ?? 'Sunday';
}

function describeWeekdayField(field: string): string {
  return field
    .split(',')
    .map((part) => {
      const [start, end] = part.split('-');
      if (end === undefined) {
        return weekdayName(Number(start));
      }
      return `${weekdayName(Number(start))}–${weekdayName(Number(end))}`;
    })
    .join(', ');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Renders a cron expression as a short, human-readable sentence.
 *
 * @param cron - The cron expression.
 * @param timezone - IANA timezone, appended in parentheses when given.
 * @returns A description; an invalid expression yields `Invalid cron expression: <reason>`.
 */
export function describeCron(cron: string, timezone?: string): string {
  const suffix = timezone === undefined ? '' : ` (${timezone})`;
  const validation = validateCron(cron);
  if (!validation.ok) {
    return `Invalid cron expression: ${validation.reason}`;
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = splitFields(cron);

  if (minute === '*' && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Runs every minute${suffix}`;
  }
  const everyNMinutes = /^\*\/(\d+)$/.exec(minute);
  if (
    everyNMinutes !== null &&
    hour === '*' &&
    dayOfMonth === '*' &&
    month === '*' &&
    dayOfWeek === '*'
  ) {
    return `Runs every ${everyNMinutes[1]} minutes${suffix}`;
  }
  const isFixedTime = DIGITS_PATTERN.test(minute) && DIGITS_PATTERN.test(hour);
  const time = `${pad2(Number(hour))}:${pad2(Number(minute))}`;
  if (isFixedTime && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Runs every day at ${time}${suffix}`;
  }
  if (isFixedTime && dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    return `Runs every ${describeWeekdayField(dayOfWeek)} at ${time}${suffix}`;
  }
  if (isFixedTime && dayOfMonth !== '*' && month === '*' && dayOfWeek === '*') {
    return `Runs on day ${dayOfMonth} of the month at ${time}${suffix}`;
  }
  return `Runs on schedule ${cron.trim()}${suffix}`;
}

function expandField(field: string, range: FieldRange): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [span, step] = part.split('/');
    const stepValue = step === undefined ? 1 : Number(step);
    let start = range.min;
    let end = range.max;
    if (span !== '*' && span !== undefined) {
      const [startText, endText] = span.split('-');
      start = Number(startText);
      end = endText === undefined ? start : Number(endText);
    }
    for (let value = start; value <= end; value += stepValue) {
      values.add(value);
    }
  }
  return values;
}

const WEEKDAY_SHORT: readonly [string, string, string, string, string, string, string] = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
];

const MINUTE_MS = 60_000;
const SEARCH_HORIZON_MS = 366 * 24 * 60 * MINUTE_MS;

/** The 5 date/time components this module reads out of a formatted candidate instant. */
interface CandidateParts {
  minute: string;
  hour: string;
  day: string;
  month: string;
  weekday: string;
}

/**
 * Reduces `Intl.DateTimeFormat.formatToParts` output into a plain, fully-populated record: every
 * field the caller configured the formatter with is a real, non-optional `string` (each part's
 * own `value` is never optional; only looking one up by type through an index/`Map` would be).
 */
function extractParts(parts: readonly Intl.DateTimeFormatPart[]): CandidateParts {
  const result: CandidateParts = { minute: '', hour: '', day: '', month: '', weekday: '' };
  for (const part of parts) {
    if (part.type === 'minute') {
      result.minute = part.value;
    } else if (part.type === 'hour') {
      result.hour = part.value;
    } else if (part.type === 'day') {
      result.day = part.value;
    } else if (part.type === 'month') {
      result.month = part.value;
    } else if (part.type === 'weekday') {
      result.weekday = part.value;
    }
  }
  return result;
}

/**
 * Finds the next time a cron schedule fires, searching minute by minute in its timezone.
 *
 * @param schedule - Cron expression and IANA timezone.
 * @param from - Search start (exclusive); defaults to now.
 * @returns The next matching instant, or `null` when the expression is invalid or unsatisfiable
 *   within a 366-day horizon (e.g. `30 2 *` — day of month 30 in February).
 */
export function nextRunAt(schedule: CronSchedule, from: Date = new Date()): Date | null {
  const validation = validateCron(schedule.cron);
  if (!validation.ok) {
    return null;
  }
  const [minuteField, hourField, domField, monthField, dowField] = splitFields(schedule.cron);
  const minuteSet = expandField(minuteField, FIELD_RANGES[0]);
  const hourSet = expandField(hourField, FIELD_RANGES[1]);
  const domSet = expandField(domField, FIELD_RANGES[2]);
  const monthSet = expandField(monthField, FIELD_RANGES[3]);
  const dowSet = expandField(dowField, FIELD_RANGES[4]);
  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });

  const start = Math.ceil((from.getTime() + 1) / MINUTE_MS) * MINUTE_MS;
  const limit = from.getTime() + SEARCH_HORIZON_MS;

  for (let candidateMs = start; candidateMs <= limit; candidateMs += MINUTE_MS) {
    const candidateParts = extractParts(formatter.formatToParts(new Date(candidateMs)));
    const minute = Number(candidateParts.minute);
    const hour = Number(candidateParts.hour);
    const day = Number(candidateParts.day);
    const month = Number(candidateParts.month);
    const weekday = WEEKDAY_SHORT.indexOf(candidateParts.weekday);

    if (!minuteSet.has(minute) || !hourSet.has(hour) || !monthSet.has(month)) {
      continue;
    }
    const domMatch = domSet.has(day);
    const dowMatch = dowSet.has(weekday) || (weekday === 0 && dowSet.has(7));
    const dayMatches =
      domRestricted && dowRestricted
        ? domMatch || dowMatch
        : domRestricted
          ? domMatch
          : !dowRestricted || dowMatch;
    if (dayMatches) {
      return new Date(candidateMs);
    }
  }
  return null;
}
