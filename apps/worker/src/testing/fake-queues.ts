/**
 * Recording queues that satisfy the worker's queue surface without Redis.
 *
 * Layer: test double.
 *
 * `getJobSchedulers` reads back what `upsertJobScheduler` wrote, so a reconciliation test can
 * assert the second boot is a no-op rather than only that the first one registered something.
 */
import type { WorkerQueue, WorkerQueues } from '../queues.js';

/** One recorded `add`. */
export interface RecordedJob {
  name: string;
  data: unknown;
  opts: unknown;
}

/** A registered Job Scheduler, as `getJobSchedulers` reports it. */
export interface RecordedScheduler {
  key: string;
  pattern?: string | undefined;
  tz?: string | undefined;
  template: { name: string; data: unknown };
}

/** Records every call and answers scheduler queries from what it recorded. */
export class FakeQueue implements WorkerQueue {
  /** Jobs enqueued through `add`, in order. */
  readonly jobs: RecordedJob[] = [];

  /** Scheduler keys removed through `removeJobScheduler`, in order. */
  readonly removed: string[] = [];

  /** Whether `close` was called. */
  closed = false;

  private readonly schedulers = new Map<string, RecordedScheduler>();

  /**
   * Records an enqueued job.
   *
   * @param name - Job name.
   * @param data - Payload.
   * @param opts - BullMQ job options.
   * @returns The recorded entry.
   */
  add(name: string, data: unknown, opts?: unknown): Promise<unknown> {
    const job: RecordedJob = { name, data, opts };
    this.jobs.push(job);
    return Promise.resolve(job);
  }

  /**
   * Registers or replaces a scheduler.
   *
   * @param key - Scheduler key.
   * @param repeat - Cron pattern and optional timezone.
   * @param template - Job name and payload the scheduler produces.
   * @returns The stored entry.
   */
  upsertJobScheduler(
    key: string,
    repeat: { pattern: string; tz?: string },
    template: { name: string; data: unknown },
  ): Promise<unknown> {
    const scheduler: RecordedScheduler = { key, pattern: repeat.pattern, tz: repeat.tz, template };
    this.schedulers.set(key, scheduler);
    return Promise.resolve(scheduler);
  }

  /**
   * Removes a scheduler.
   *
   * @param key - Scheduler key.
   * @returns `true` when one was registered under that key.
   */
  removeJobScheduler(key: string): Promise<boolean> {
    this.removed.push(key);
    return Promise.resolve(this.schedulers.delete(key));
  }

  /**
   * Lists the registered schedulers.
   *
   * @returns Every scheduler, in insertion order.
   */
  getJobSchedulers(): Promise<
    { key: string; pattern?: string | null | undefined; tz?: string | null | undefined }[]
  > {
    return Promise.resolve([...this.schedulers.values()]);
  }

  /** Marks the queue closed. */
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /**
   * The scheduler registered under a key.
   *
   * @param key - Scheduler key.
   * @returns The entry, or `undefined`.
   */
  scheduler(key: string): RecordedScheduler | undefined {
    return this.schedulers.get(key);
  }
}

/** The three fake queues, each addressable for assertions. */
export interface FakeQueues extends WorkerQueues {
  chatTurns: FakeQueue;
  scheduledJobs: FakeQueue;
  workspaceGc: FakeQueue;
}

/**
 * Builds one recording queue per application queue.
 *
 * @returns The three queues.
 */
export function createFakeQueues(): FakeQueues {
  return {
    chatTurns: new FakeQueue(),
    scheduledJobs: new FakeQueue(),
    workspaceGc: new FakeQueue(),
  };
}
