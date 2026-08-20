/**
 * The mechanics both cancel routes share: taking a job back off its queue before a worker starts
 * it, and the status that says the worker still has to act.
 *
 * Layer: service (server).
 *
 * Cancelling has two shapes, and which one applies depends on whether a worker has picked the work
 * up. Work still waiting in the queue is removed and closed by the web process, which is exact and
 * immediate. Work already executing lives in a container the worker owns, so the web process only
 * publishes the request on the command channel and answers `202`. A chat turn and a scheduled job
 * run differ in which queue and which repository they belong to, and in nothing else here, so the
 * removal step lives in one place rather than in each handler.
 *
 * What the removal guarantees is that a `true` answer means this request took the job off the
 * queue before any worker held it. What it does not guarantee is the converse in a useful form: a
 * `false` answer means only that the job is not removable *now* — it may have started, it may
 * never have been enqueued under that id, or it may already have been removed by a request that
 * raced this one. Every caller therefore treats `false` as "ask the worker instead", which is
 * correct for all three, and none of them may read it as proof that the work is running.
 */
import type { ApplicationQueues } from '@agent-hangar/core';

/** Status the cancel routes accept a request with when the worker still has to act on it. */
export const CANCEL_REQUESTED_STATUS = 202;

/** BullMQ states in which a job has not started and can still be removed. */
const REMOVABLE_STATES: readonly string[] = ['waiting', 'delayed', 'prioritized'];

/** A queue a cancellable job can live on; every application queue satisfies it. */
export type CancellableQueue = ApplicationQueues[keyof ApplicationQueues];

/**
 * Removes the queued job of a turn or a run, when it is still removable.
 *
 * The state is read and then acted on, and nothing holds the queue still in between: BullMQ can
 * hand the job to a worker after the check, and it refuses to remove a job a worker has locked.
 * That refusal is the running case rather than a failure — the same situation the caller already
 * handles for a job that was active when it was checked — so the state is read again to tell the
 * two apart. A removal that fails while the job is still removable is a failure of the store and
 * is reported as one.
 *
 * @param queue - The queue the job was enqueued on.
 * @param jobId - BullMQ job id, which every producer of cancellable work derives from the row it
 *   drives: a `Turn.id` on the chat queue, a `JobRun.id` on the scheduled queue.
 * @returns `true` when the job was removed before it started.
 * @throws Error When the queue refuses the removal for any reason other than the job having
 *   started.
 */
export async function removeQueuedJob(queue: CancellableQueue, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (job === undefined || !REMOVABLE_STATES.includes(await job.getState())) {
    return false;
  }
  try {
    await job.remove();
  } catch (error) {
    if (REMOVABLE_STATES.includes(await job.getState())) {
      throw error;
    }
    return false;
  }
  return true;
}
