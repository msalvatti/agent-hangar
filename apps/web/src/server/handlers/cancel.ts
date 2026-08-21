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
 * Whichever shape applies, the request that publishes also records the cancellation on the row —
 * conditionally, so it is granted only while the work is still live — and answers `202` only once
 * that write has landed. Publishing alone was not enough: the worker decides between "the user
 * stopped this" and "this could not run" from a flag it read some awaits before it writes the
 * outcome, and a Stop arriving in that gap was answered `202` here and then recorded as `FAILED`
 * there. Neither side can close that on its own — pub/sub delivers after the publish returns, so no
 * amount of re-reading in the worker sees a request still in flight — so the record is written
 * where the promise is made, and the worker's own terminal write is refused as the second one.
 * {@link askWorkerToCancel} is that step, shared for the same reason the removal is: a turn and a
 * run differ in which repository and which code they answer with, and in nothing else here.
 *
 * What the removal guarantees is that a `true` answer means this request took the job off the
 * queue before any worker held it. What it does not guarantee is the converse in a useful form: a
 * `false` answer means only that the job is not removable *now* — it may have started, it may
 * never have been enqueued under that id, or it may already have been removed by a request that
 * raced this one. Every caller therefore treats `false` as "ask the worker instead", which is
 * correct for all three, and none of them may read it as proof that the work is running.
 */
import { okResponse, turnCommand, turnCommandChannel } from '@agent-hangar/core';
import type { ApplicationQueues } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ConflictError } from '../errors';
import { jsonResponse } from '../http';

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

/** What one kind of cancellable work supplies to {@link askWorkerToCancel}. */
export interface WorkerCancellation {
  /** `Turn.id` or `JobRun.id`; also the key of the command channel the worker listens on. */
  id: string;
  /**
   * Records the cancellation on the row, conditionally on the work still being live.
   *
   * @returns The row this write produced, or `null` when it had already reached an outcome.
   */
  finish: () => Promise<object | null>;
  /** Conflict code answered when the row had already reached an outcome. */
  code: string;
  /** What the user is told then. */
  message: string;
}

/**
 * Asks the worker to stop work it is already holding, and records that it was asked.
 *
 * The command is published before the row is taken, so a request that then loses the row has still
 * told the worker to let go of a container it may still be holding; a cancel command for work that
 * has already ended reaches a listener with nothing left to stop. Losing the row afterwards is not
 * a half-done cancellation to undo — the outcome the other writer recorded is the record — so it is
 * reported rather than compensated.
 *
 * @param container - The server container.
 * @param work - The run being stopped, and how to record it.
 * @returns `202`, once the cancellation is both published and recorded.
 * @throws ConflictError 409 when the work reached an outcome while this request was in flight.
 */
export async function askWorkerToCancel(
  container: ServerContainer,
  work: WorkerCancellation,
): Promise<Response> {
  await container.redis.publish(
    turnCommandChannel(work.id),
    JSON.stringify(turnCommand.parse({ type: 'cancel' })),
  );
  if ((await work.finish()) === null) {
    throw new ConflictError(work.code, work.message);
  }
  return jsonResponse(okResponse, { ok: true }, { status: CANCEL_REQUESTED_STATUS });
}
