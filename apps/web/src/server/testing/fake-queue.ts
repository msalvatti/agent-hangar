/**
 * In-memory BullMQ stand-in, installed in place of the `bullmq` module.
 *
 * Layer: test double.
 *
 * The queue producers live in `@agent-hangar/core` and take a concrete BullMQ `Queue`, so the way
 * to exercise a handler without Redis is to replace the module rather than to invent a second
 * producer in the web app: the job ids, payload contracts and retention policy under test stay the
 * ones that ship. A test file installs it with
 * `vi.mock('bullmq', () => import('@/server/testing/fake-queue'))`, then reads the recorded calls
 * through {@link fakeQueue}.
 */

/** The job options a producer sets; only the deterministic id is read back. */
export interface JobOptions {
  jobId?: string;
  removeOnComplete?: unknown;
  removeOnFail?: unknown;
}

/** One recorded `add` call. */
export interface RecordedJob {
  name: string;
  data: unknown;
  opts: JobOptions | undefined;
}

/** One registered Job Scheduler. */
export interface RecordedScheduler {
  pattern: string | undefined;
  tz: string | undefined;
  template: { name: string; data: unknown };
}

/** BullMQ job states the cancel path branches on. */
export type FakeJobState = 'waiting' | 'delayed' | 'prioritized' | 'active' | 'completed';

/** A job held by a {@link FakeQueue}. */
export class FakeJob {
  /** Whether {@link FakeJob.remove} was called. */
  removed = false;

  /**
   * @param id - Job id.
   * @param state - State {@link FakeJob.getState} reports.
   * @param queue - Queue holding the job.
   */
  constructor(
    readonly id: string,
    public state: FakeJobState,
    private readonly queue: FakeQueue,
  ) {}

  /**
   * @returns The configured state.
   */
  getState(): Promise<FakeJobState> {
    return Promise.resolve(this.state);
  }

  /**
   * Removes the job from its queue.
   *
   * @returns Resolves once removed.
   */
  remove(): Promise<void> {
    this.removed = true;
    this.queue.jobs.delete(this.id);
    return Promise.resolve();
  }
}

/** Queues created since the last {@link resetFakeQueues}, keyed by queue name. */
const created = new Map<string, FakeQueue>();

/** In-memory stand-in for a BullMQ queue. */
export class FakeQueue {
  /** Every `add` call, in order. */
  readonly added: RecordedJob[] = [];

  /** Jobs currently held, keyed by job id. */
  readonly jobs = new Map<string, FakeJob>();

  /** Registered Job Schedulers, keyed by scheduler key. */
  readonly schedulers = new Map<string, RecordedScheduler>();

  /** Whether {@link FakeQueue.close} was called. */
  closed = false;

  /** Set to make the next `add` reject, exercising the enqueue-failure path. */
  addFailure: Error | null = null;

  /** State reported by jobs this queue hands out. */
  jobState: FakeJobState = 'waiting';

  /** Whether `getJob` finds jobs at all; `false` models a job BullMQ has already released. */
  jobsVisible = true;

  /**
   * @param name - Queue name.
   */
  constructor(readonly name: string) {
    created.set(name, this);
  }

  /**
   * Records an enqueue.
   *
   * @param name - Job name.
   * @param data - Job payload.
   * @param opts - Job options, including the deterministic `jobId` when the producer sets one.
   * @returns The stored job.
   * @throws Error When {@link FakeQueue.addFailure} is set.
   */
  add(name: string, data: unknown, opts?: JobOptions): Promise<FakeJob> {
    if (this.addFailure !== null) {
      return Promise.reject(this.addFailure);
    }
    this.added.push({ name, data, opts });
    const id = opts?.jobId ?? `generated-${name}`;
    const job = new FakeJob(id, this.jobState, this);
    this.jobs.set(id, job);
    return Promise.resolve(job);
  }

  /**
   * @param id - Job id.
   * @returns The job, or `undefined` when it is gone or the queue hides its jobs.
   */
  getJob(id: string): Promise<FakeJob | undefined> {
    return Promise.resolve(this.jobsVisible ? this.jobs.get(id) : undefined);
  }

  /**
   * @param key - Scheduler key (`ScheduledJob.id`).
   * @param repeat - Cron pattern and timezone.
   * @param template - Job name and payload produced at each tick.
   */
  upsertJobScheduler(
    key: string,
    repeat: { pattern: string; tz?: string },
    template: { name: string; data: unknown },
  ): Promise<void> {
    this.schedulers.set(key, { pattern: repeat.pattern, tz: repeat.tz, template });
    return Promise.resolve();
  }

  /**
   * @param key - Scheduler key.
   * @returns `true` when a scheduler was removed.
   */
  removeJobScheduler(key: string): Promise<boolean> {
    return Promise.resolve(this.schedulers.delete(key));
  }

  /**
   * @returns Every registered scheduler.
   */
  getJobSchedulers(): Promise<
    { key: string; pattern: string | undefined; tz: string | undefined }[]
  > {
    return Promise.resolve(
      [...this.schedulers.entries()].map(([key, scheduler]) => ({
        key,
        pattern: scheduler.pattern,
        tz: scheduler.tz,
      })),
    );
  }

  /**
   * Marks the queue closed.
   *
   * @returns Resolves once closed.
   */
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** Stand-in for BullMQ's `Worker`. The web process never starts one; only the worker does. */
export class FakeWorker {
  /**
   * @param name - Queue this worker would consume.
   */
  constructor(readonly name: string) {}
}

/** Name BullMQ's module exports for the queue class. */
export { FakeQueue as Queue, FakeWorker as Worker };

/**
 * Reads back a queue created since the last reset.
 *
 * @param name - Queue name, from `QUEUE_NAMES`.
 * @returns The queue.
 * @throws Error When no queue of that name was created, which means the `bullmq` module was not
 *   replaced in this test file.
 */
export function fakeQueue(name: string): FakeQueue {
  const queue = created.get(name);
  if (queue === undefined) {
    throw new Error(`No fake queue named "${name}"; is the bullmq module mocked in this file?`);
  }
  return queue;
}

/** Forgets every recorded queue, so one test cannot see another's jobs. */
export function resetFakeQueues(): void {
  created.clear();
}
