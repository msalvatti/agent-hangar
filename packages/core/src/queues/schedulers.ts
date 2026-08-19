/**
 * BullMQ Job Scheduler wrappers.
 *
 * Layer: infrastructure.
 *
 * Scheduler keys are `ScheduledJob.id`s, so upserting is idempotent per job: editing a cron
 * updates the one scheduler that job owns instead of leaving the old one firing beside the new.
 * Reconciling the database against Redis is then a set difference the scheduling module computes
 * and these wrappers apply.
 *
 * The queue is accepted through {@link SchedulerQueue}, a structural subset of BullMQ's `Queue`,
 * so unit tests can drive the logic without Redis while the real queue satisfies it unchanged.
 */
import { GC_CRON, GC_SCHEDULER_KEY, toSchedulerKey } from '../scheduling/keys.js';
import type { ExistingScheduler } from '../scheduling/reconcile.js';
import type { ReconcilePlan } from '../scheduling/types.js';

import { JOB_NAMES, runScheduledJobPayload } from './contracts.js';

/** What a scheduler wrapper needs from a queue; BullMQ's `Queue` satisfies it. */
export interface SchedulerQueue {
  upsertJobScheduler(
    key: string,
    repeat: { pattern: string; tz?: string },
    template: { name: string; data: unknown },
  ): Promise<unknown>;
  removeJobScheduler(key: string): Promise<boolean>;
  getJobSchedulers(): Promise<
    { key: string; pattern?: string | null | undefined; tz?: string | null | undefined }[]
  >;
}

/** What {@link applyReconcilePlan} changed. */
export interface AppliedReconcilePlan {
  /** Keys whose scheduler was created or updated. */
  upserted: string[];
  /** Keys whose scheduler was removed. */
  removed: string[];
}

/**
 * Creates or updates the scheduler of an enabled job.
 *
 * @param queue - The `scheduled-jobs` queue.
 * @param job - Job id, cron expression and IANA timezone.
 * @throws ZodError When the job id does not satisfy the payload contract.
 */
export async function upsertScheduledJob(
  queue: SchedulerQueue,
  job: { id: string; cron: string; timezone: string },
): Promise<void> {
  const data = runScheduledJobPayload.parse({ jobId: job.id, trigger: 'SCHEDULE' });
  await queue.upsertJobScheduler(
    toSchedulerKey(job.id),
    { pattern: job.cron, tz: job.timezone },
    { name: JOB_NAMES.runScheduledJob, data },
  );
}

/**
 * Removes the scheduler of a job that was disabled or deleted.
 *
 * @param queue - The `scheduled-jobs` queue.
 * @param jobId - `ScheduledJob.id`.
 * @returns `true` when a scheduler was removed, `false` when there was none.
 */
export async function removeScheduledJob(queue: SchedulerQueue, jobId: string): Promise<boolean> {
  return queue.removeJobScheduler(toSchedulerKey(jobId));
}

/**
 * Lists the schedulers that belong to scheduled jobs.
 *
 * The garbage-collection scheduler is excluded: it belongs to no job, so a reconciler that saw it
 * would remove it on every boot and then recreate it.
 *
 * @param queue - The `scheduled-jobs` queue.
 * @returns The job schedulers, ordered by key, with absent fields normalised to `undefined`.
 */
export async function listSchedulers(queue: SchedulerQueue): Promise<ExistingScheduler[]> {
  const schedulers = await queue.getJobSchedulers();
  return schedulers
    .filter((scheduler) => scheduler.key !== GC_SCHEDULER_KEY)
    .map((scheduler) => ({
      key: scheduler.key,
      pattern: scheduler.pattern ?? undefined,
      tz: scheduler.tz ?? undefined,
    }))
    .toSorted((left, right) => left.key.localeCompare(right.key));
}

/**
 * Applies a reconciliation plan.
 *
 * The calls are sequential on purpose: they all go to one Redis connection, and a deterministic
 * order makes a failure halfway through leave a state the next boot converges from.
 *
 * @param queue - The `scheduled-jobs` queue.
 * @param plan - Plan produced by the scheduling module.
 * @returns The keys that were upserted and removed.
 */
export async function applyReconcilePlan(
  queue: SchedulerQueue,
  plan: ReconcilePlan,
): Promise<AppliedReconcilePlan> {
  const upserted: string[] = [];
  for (const job of plan.upsert) {
    await upsertScheduledJob(queue, job);
    upserted.push(job.id);
  }
  const removed: string[] = [];
  for (const key of plan.remove) {
    await removeScheduledJob(queue, key);
    removed.push(key);
  }
  return { upserted, removed };
}

/**
 * Creates or updates the scheduler that drives idle-workspace collection.
 *
 * @param queue - The `workspace-gc` queue.
 */
export async function upsertGcScheduler(queue: SchedulerQueue): Promise<void> {
  await queue.upsertJobScheduler(
    GC_SCHEDULER_KEY,
    { pattern: GC_CRON },
    { name: JOB_NAMES.reapIdle, data: {} },
  );
}
