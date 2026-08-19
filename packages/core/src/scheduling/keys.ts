/**
 * The BullMQ Job Scheduler key convention.
 *
 * Layer: domain (pure).
 *
 * A scheduler key is exactly the `ScheduledJob.id` it belongs to. That single decision buys two
 * properties the worker relies on: upserting a scheduler is idempotent per job (editing a cron
 * updates the one scheduler instead of adding a second), and reconciling the database against
 * Redis is a set difference over ids rather than a join over generated names.
 *
 * The conversions are therefore the identity function. They exist so that call sites read as
 * conversions and a future change of convention has one place to happen.
 */
import type { SchedulerKey } from './types.js';

/** Key of the scheduler that drives idle-workspace collection; not tied to any job. */
export const GC_SCHEDULER_KEY = 'reap-idle';

/** Cron pattern of the idle-workspace collector: every five minutes. */
export const GC_CRON = '*/5 * * * *';

/**
 * Converts a scheduled job's id to its scheduler key.
 *
 * @param jobId - `ScheduledJob.id`.
 * @returns The scheduler key, equal to the id.
 * @throws RangeError When the id is empty.
 */
export function toSchedulerKey(jobId: string): SchedulerKey {
  if (jobId === '') {
    throw new RangeError('scheduled job id must not be empty');
  }
  return jobId;
}

/**
 * Converts a scheduler key back to the scheduled job's id.
 *
 * @param key - Scheduler key read from Redis.
 * @returns The `ScheduledJob.id`, equal to the key.
 * @throws RangeError When the key is empty.
 */
export function jobIdFromSchedulerKey(key: SchedulerKey): string {
  if (key === '') {
    throw new RangeError('scheduler key must not be empty');
  }
  return key;
}
