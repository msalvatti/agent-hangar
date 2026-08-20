/**
 * The producer of a manual scheduled-job run, shared by the route that starts one and the route
 * that stops it.
 *
 * Layer: service (server).
 *
 * The core producers cannot be used for this delivery: `enqueueManualJobRun` cannot carry the id
 * of the `JobRun` row the API already created, and that id is what makes the worker adopt the row
 * the browser is watching instead of inserting a second one. The retention policy is imported from
 * core rather than restated, so a manual run is kept for as long as every other job is.
 *
 * The BullMQ job id is the run id. That is what lets the cancel route take a run back off the
 * queue by name, exactly as the chat path does with the turn id, and it makes a redelivered
 * request enqueue one job rather than two.
 *
 * The guarantee is bounded by what a job id can express. It deduplicates deliveries of the *same*
 * run and nothing else: pressing "Run now" twice creates two rows with two ids and is deliberately
 * two runs, which the overlap policy — not this id — is what keeps from piling up. A tick fired by
 * the Job Scheduler carries no run id at all, because its row does not exist until the worker
 * creates it, so a queued tick is not addressable here and cannot be removed by run id.
 */
import {
  JOB_NAMES,
  KEEP_COMPLETED_JOBS,
  KEEP_FAILED_JOBS,
  runScheduledJobPayload,
} from '@agent-hangar/core';

import type { CancellableQueue } from './cancel';

/** Retention every producer applies, shared with the core producers. */
const RETENTION = {
  removeOnComplete: KEEP_COMPLETED_JOBS,
  removeOnFail: KEEP_FAILED_JOBS,
} as const;

/** Which job the delivery runs, and which row it records against. */
export interface ManualRunDelivery {
  /** `ScheduledJob.id` the run belongs to. */
  jobId: string;
  /** `JobRun.id` created by the API, adopted by the worker and used as the BullMQ job id. */
  runId: string;
}

/**
 * Enqueues a manual run against a `JobRun` row that already exists.
 *
 * @param queue - The `scheduled-jobs` queue.
 * @param delivery - The job to run and the row to record against.
 * @returns Resolves once the queue has accepted the delivery.
 * @throws ZodError When the payload does not satisfy the queue contract.
 * @throws Error When the queue refuses the delivery; the caller closes the row it created.
 */
export async function enqueueManualRun(
  queue: CancellableQueue,
  delivery: ManualRunDelivery,
): Promise<void> {
  const data = runScheduledJobPayload.parse({
    jobId: delivery.jobId,
    trigger: 'MANUAL',
    runId: delivery.runId,
  });
  await queue.add(JOB_NAMES.runScheduledJob, data, { jobId: delivery.runId, ...RETENTION });
}
