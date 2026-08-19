/**
 * Scheduling contracts: cron definitions and the DB ↔ BullMQ Job Scheduler reconciliation plan.
 *
 * Layer: service (port).
 */

/** A cron schedule in an IANA timezone. */
export interface CronSpec {
  /** 5-field cron expression, validated with cron-parser. */
  cron: string;
  /** IANA timezone name, e.g. `Europe/Lisbon`. */
  timezone: string;
}

/** Key of a BullMQ Job Scheduler; equals `ScheduledJob.id`. */
export type SchedulerKey = string;

/** What the worker needs to upsert a scheduler for an enabled job. */
export interface ScheduledJobRef extends CronSpec {
  /** `ScheduledJob.id`, used as the scheduler key. */
  id: SchedulerKey;
}

/** Diff between enabled jobs in the database and schedulers registered in Redis. */
export interface ReconcilePlan {
  /** Schedulers to create or update (idempotent by key). */
  upsert: ScheduledJobRef[];
  /** Scheduler keys with no matching enabled job. */
  remove: SchedulerKey[];
}

/** What happens when a tick fires while the previous run is still executing. */
export type OverlapPolicy = 'skip';
