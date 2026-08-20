/**
 * Cron adapter: the single place this feature validates, describes and projects cron schedules.
 *
 * Layer: service (adapter).
 *
 * All schedule semantics live in `@agent-hangar/core`, so the dialect the dialog accepts is the
 * dialect the scheduler runs. Core reports a bad expression by throwing, while the screens render
 * the problem inline next to the field and must never unmount on a typo, so this file is the only
 * place that turns those throws into values. Nothing else in this feature imports cron helpers.
 */
import {
  describeCron as describeSpec,
  nextRunAt as nextSpecRunAt,
  validateCronSpec,
} from '@agent-hangar/core';
import type { CronSpec } from '@agent-hangar/core';

/** Result of {@link validateCron}. */
export type CronValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Timezone used while checking an expression on its own.
 *
 * Whether the five fields parse does not depend on the zone — the zone only shifts the instants
 * an expression produces — so a fixed, always-resolvable zone keeps a timezone problem out of the
 * message shown under the cron field. The timezone is validated next to its own input instead.
 */
const VALIDATION_TIMEZONE = 'UTC';

/** Wrapper the error class puts around the parser's explanation, stripped before display. */
const REJECTION_PREFIX = /^.*?Invalid cron expression ".*?": /su;

/**
 * Extracts the explanation from a rejected schedule, without the wrapper the error class adds.
 *
 * @param error - Value thrown while parsing a schedule.
 * @returns The explanation, phrased for display under the field.
 */
function rejectionReason(error: unknown): string {
  return String(error).replace(REJECTION_PREFIX, '');
}

/**
 * Validates a cron expression against the dialect the scheduler runs.
 *
 * @param cron - The candidate expression (minute hour day-of-month month day-of-week).
 * @returns `{ ok: true }`, or `{ ok: false, reason }` explaining what the parser rejected.
 */
export function validateCron(cron: string): CronValidationResult {
  try {
    validateCronSpec({ cron, timezone: VALIDATION_TIMEZONE });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: rejectionReason(error) };
  }
}

/**
 * Renders a schedule as a short sentence ending with its timezone.
 *
 * @param cron - The cron expression.
 * @param timezone - IANA timezone the schedule runs in.
 * @returns A description such as `every day at 02:00 UTC`, or the reason it cannot be described.
 */
export function describeCron(cron: string, timezone: string): string {
  try {
    return describeSpec({ cron, timezone });
  } catch (error) {
    return `Invalid cron expression: ${rejectionReason(error)}`;
  }
}

/**
 * Finds the next instant a schedule fires.
 *
 * @param spec - Cron expression and IANA timezone.
 * @param from - Exclusive lower bound of the search; defaults to now.
 * @returns The next occurrence, or `null` when the schedule cannot be parsed.
 */
export function nextRunAt(spec: CronSpec, from: Date = new Date()): Date | null {
  try {
    return nextSpecRunAt(spec, from);
  } catch {
    return null;
  }
}
