/**
 * Database ↔ Job Scheduler reconciliation.
 *
 * Layer: domain (pure).
 *
 * Redis holds the schedulers; Postgres holds the truth. They drift whenever the app writes one
 * and fails before the other, or whenever Redis is flushed. The worker therefore diffs them on
 * boot and applies the result, instead of blindly re-upserting everything: an upsert reschedules
 * the next delayed job, so re-upserting an unchanged scheduler would keep pushing its next tick
 * further out on every restart.
 */
import { toSchedulerKey } from './keys.ts';
import type { ReconcilePlan, ScheduledJobRef, SchedulerKey } from './types.ts';

/** A job as the reconciler reads it: the scheduler fields plus whether it should run at all. */
export interface ReconcilableJob extends ScheduledJobRef {
  /** Disabled jobs keep their row but must have no scheduler. */
  enabled: boolean;
}

/** A scheduler that currently exists in Redis, as reported by BullMQ. */
export interface ExistingScheduler {
  /** Scheduler key, equal to the `ScheduledJob.id`. */
  key: SchedulerKey;
  /** Cron pattern the scheduler was registered with. */
  pattern?: string | undefined;
  /** IANA timezone the scheduler was registered with. */
  tz?: string | undefined;
}

/**
 * Reports whether a job's schedule differs from the scheduler registered for it.
 *
 * @param job - Enabled job from the database.
 * @param existing - Scheduler registered under the job's key, or `undefined` when there is none.
 * @returns `true` when the scheduler is missing or registered with another pattern or timezone.
 */
function needsUpsert(job: ReconcilableJob, existing: ExistingScheduler | undefined): boolean {
  if (existing === undefined) {
    return true;
  }
  return existing.pattern !== job.cron || existing.tz !== job.timezone;
}

/**
 * Diffs enabled jobs against the schedulers registered in Redis.
 *
 * @param dbJobs - Every scheduled job row, enabled or not.
 * @param schedulers - Schedulers currently registered, excluding infrastructure schedulers.
 * @returns Schedulers to upsert and keys to remove, both ordered by id so the plan is stable.
 */
export function reconcile(
  dbJobs: readonly ReconcilableJob[],
  schedulers: readonly ExistingScheduler[],
): ReconcilePlan {
  const enabled = dbJobs.filter((job) => job.enabled);
  const byKey = new Map(schedulers.map((scheduler) => [scheduler.key, scheduler]));
  const enabledKeys = new Set(enabled.map((job) => toSchedulerKey(job.id)));

  const upsert = enabled
    .filter((job) => needsUpsert(job, byKey.get(toSchedulerKey(job.id))))
    .map((job) => ({ id: job.id, cron: job.cron, timezone: job.timezone }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const remove = schedulers
    .map((scheduler) => scheduler.key)
    .filter((key) => !enabledKeys.has(key))
    .sort((left, right) => left.localeCompare(right));

  return { upsert, remove };
}
