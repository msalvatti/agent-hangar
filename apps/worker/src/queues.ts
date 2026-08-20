/**
 * The queue surface the worker uses, narrowed to what it actually calls.
 *
 * Layer: contract.
 *
 * BullMQ's `Queue` satisfies these interfaces, and so does the recording double in
 * `src/testing/fake-queues.ts`. Depending on the narrow shape is what lets the scheduler
 * reconciler and the processors be unit-tested without Redis, while production passes the real
 * queues unchanged.
 */
import type { SchedulerQueue } from '@agent-hangar/core';

/** One queue as the worker sees it: the Job Scheduler API, plus enqueuing and closing. */
export interface WorkerQueue extends SchedulerQueue {
  /**
   * Enqueues a job.
   *
   * @param name - Job name, one of `JOB_NAMES`.
   * @param data - Payload; validated by the producer helpers in core.
   * @param opts - BullMQ job options.
   */
  add(name: string, data: unknown, opts?: unknown): Promise<unknown>;
  /** Releases the queue's resources. */
  close(): Promise<void>;
}

/** Every queue the worker consumes or reconciles. */
export interface WorkerQueues {
  chatTurns: WorkerQueue;
  scheduledJobs: WorkerQueue;
  workspaceGc: WorkerQueue;
}
