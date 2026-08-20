/**
 * Unit tests for the BullMQ connection, queue and worker factories.
 *
 * Layer: unit.
 * Goal: producer and consumer connections get opposite retry policies, a worker refuses a
 * producer connection, every queue is created with its contract name and the caller's prefix, and
 * every producer validates its payload and pins its job id before touching Redis.
 * Mocks: `bullmq` and `ioredis` are replaced by constructor-recording doubles; no Redis.
 */
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../errors.ts';

import { JOB_NAMES, QUEUE_NAMES } from './contracts.ts';
import {
  closeConnection,
  createQueue,
  createQueueConnection,
  createQueues,
  createWorker,
  createWorkerConnection,
  DEFAULT_WORKER_CONCURRENCY,
  enqueueDestroyChatWorkspace,
  enqueueManualJobRun,
  enqueueRunTurn,
  KEEP_COMPLETED_JOBS,
  KEEP_FAILED_JOBS,
} from './queues.ts';
import type { WorkerReliabilityOptions } from './queues.ts';

const mocks = vi.hoisted(() => ({
  redisCtor: vi.fn<(url: string, options?: Record<string, unknown>) => void>(),
  queueCtor: vi.fn<(name: string, options: unknown) => void>(),
  workerCtor: vi.fn<(name: string, processor: unknown, options: unknown) => void>(),
  add: vi.fn<
    (name: string, data: unknown, options?: unknown) => Promise<{ id?: string | undefined }>
  >(),
}));

/** ioredis' documented default retry budget, mirrored so the producer path is realistic. */
const IOREDIS_DEFAULT_RETRIES = 20;

vi.mock('ioredis', () => ({
  Redis: class FakeRedis {
    readonly options: Record<string, unknown>;

    constructor(url: string, options?: Record<string, unknown>) {
      mocks.redisCtor(url, options);
      this.options = options ?? { maxRetriesPerRequest: IOREDIS_DEFAULT_RETRIES };
    }
  },
}));

vi.mock('bullmq', () => ({
  Queue: class FakeQueue {
    readonly add = mocks.add;

    constructor(name: string, options: unknown) {
      mocks.queueCtor(name, options);
    }
  },
  Worker: class FakeWorker {
    readonly name: string;

    constructor(name: string, processor: unknown, options: unknown) {
      mocks.workerCtor(name, processor, options);
      this.name = name;
    }
  },
}));

/** Retention options every producer applies. */
const RETENTION = { removeOnComplete: KEEP_COMPLETED_JOBS, removeOnFail: KEEP_FAILED_JOBS };

/** Retention of the teardown job, which keeps no history so its derived id is released. */
const DESTROY_RETENTION = { removeOnComplete: true, removeOnFail: true };

/** A queue whose `add` is the shared spy. */
const fakeQueue = (): Queue => createQueue(QUEUE_NAMES.chatTurns, { connection: {} as Redis });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.add.mockResolvedValue({ id: 'generated-id' });
});

describe('connections', () => {
  /**
   * A producer keeps ioredis' retry budget: an `add` issued while handling an HTTP request must
   * fail the request rather than hang it against an unreachable Redis.
   */
  it('opens a producer connection with the default retry policy', () => {
    const connection = createQueueConnection('redis://127.0.0.1:6379');
    expect(mocks.redisCtor).toHaveBeenCalledWith('redis://127.0.0.1:6379', undefined);
    expect(connection.options.maxRetriesPerRequest).not.toBeNull();
  });

  /**
   * A consumer needs unlimited retries because its blocking reads outlive any budget; BullMQ
   * refuses to start a worker without it.
   */
  it('opens a consumer connection with unlimited retries', () => {
    const connection = createWorkerConnection('redis://127.0.0.1:6379');
    expect(mocks.redisCtor).toHaveBeenCalledWith('redis://127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    expect(connection.options.maxRetriesPerRequest).toBeNull();
  });

  /**
   * Closing twice is normal during shutdown, so an already-closed connection is not an error.
   */
  it('tolerates closing an already-closed connection', async () => {
    const closed = {
      quit: vi.fn().mockRejectedValue(new Error('Connection is closed')),
    } as unknown as Redis;
    await expect(closeConnection(closed)).resolves.toBeUndefined();
  });

  /**
   * Any other failure is real and must not be swallowed, or a shutdown would report success while
   * leaving a socket behind.
   */
  it('rethrows other close failures', async () => {
    const broken = { quit: vi.fn().mockRejectedValue(new Error('ECONNRESET')) } as unknown as Redis;
    await expect(closeConnection(broken)).rejects.toThrow('ECONNRESET');
  });

  /**
   * A clean close resolves without touching the error path.
   */
  it('closes a healthy connection', async () => {
    const quit = vi.fn().mockResolvedValue('OK');
    await expect(closeConnection({ quit } as unknown as Redis)).resolves.toBeUndefined();
    expect(quit).toHaveBeenCalledTimes(1);
  });
});

describe('queue factories', () => {
  /**
   * The queue is created with the contract name; a typo here would orphan every job already
   * queued under the old key.
   */
  it('creates a queue on the given connection', () => {
    const connection = {} as Redis;
    createQueue(QUEUE_NAMES.chatTurns, { connection });
    expect(mocks.queueCtor).toHaveBeenCalledWith('chat-turns', { connection });
  });

  /**
   * A prefix namespaces every key, which is how two integration runs share one Redis without
   * seeing each other's jobs; omitting it must not send `prefix: undefined` to BullMQ.
   */
  it('passes a prefix through and omits it when absent', () => {
    const connection = {} as Redis;
    createQueue(QUEUE_NAMES.chatTurns, { connection, prefix: 'ah-test-1' });
    expect(mocks.queueCtor).toHaveBeenCalledWith('chat-turns', { connection, prefix: 'ah-test-1' });
    mocks.queueCtor.mockClear();
    createQueue(QUEUE_NAMES.chatTurns, { connection });
    expect(mocks.queueCtor).toHaveBeenCalledWith('chat-turns', { connection });
  });

  /**
   * The three application queues are created together so a process cannot forget one.
   */
  it('creates every application queue', () => {
    const connection = {} as Redis;
    const queues = createQueues({ connection, prefix: 'ah-test-1' });
    expect(Object.keys(queues)).toEqual(['chatTurns', 'scheduledJobs', 'workspaceGc']);
    expect(mocks.queueCtor.mock.calls.map((call) => call[0])).toEqual([
      QUEUE_NAMES.chatTurns,
      QUEUE_NAMES.scheduledJobs,
      QUEUE_NAMES.workspaceGc,
    ]);
  });
});

describe('createWorker', () => {
  /**
   * The worker is constructed with the consumer connection, the caller's concurrency and prefix.
   */
  it('creates a worker with concurrency and prefix', () => {
    const connection = createWorkerConnection('redis://127.0.0.1:6379');
    const processor = vi.fn();
    createWorker(QUEUE_NAMES.chatTurns, processor, { connection, concurrency: 2, prefix: 'p' });
    expect(mocks.workerCtor).toHaveBeenCalledWith('chat-turns', processor, {
      connection,
      concurrency: 2,
      prefix: 'p',
    });
  });

  /**
   * Concurrency defaults to one: a turn owns a container, so the safe default is the one that
   * cannot exhaust a laptop.
   */
  it('defaults the concurrency', () => {
    const connection = createWorkerConnection('redis://127.0.0.1:6379');
    createWorker(QUEUE_NAMES.chatTurns, vi.fn(), { connection });
    expect(mocks.workerCtor).toHaveBeenCalledWith('chat-turns', expect.anything(), {
      connection,
      concurrency: DEFAULT_WORKER_CONCURRENCY,
    });
  });

  /**
   * The worker application must set BullMQ's stalled-job settings itself — a turn holds its job
   * far longer than the default lock — so the factory forwards all three rather than fixing them.
   */
  it('forwards the stalled-job settings', () => {
    const connection = createWorkerConnection('redis://127.0.0.1:6379');
    createWorker(QUEUE_NAMES.chatTurns, vi.fn(), {
      connection,
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    });
    expect(mocks.workerCtor).toHaveBeenCalledWith('chat-turns', expect.anything(), {
      connection,
      concurrency: DEFAULT_WORKER_CONCURRENCY,
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1,
    });
  });

  /**
   * A setting the caller omitted is left out of the options object rather than passed as
   * `undefined`, which BullMQ would read as an explicit override of its own default.
   */
  it('omits a stalled-job setting that was not given', () => {
    const connection = createWorkerConnection('redis://127.0.0.1:6379');
    createWorker(QUEUE_NAMES.chatTurns, vi.fn(), { connection, lockDuration: 60_000 });
    const options = mocks.workerCtor.mock.calls[0]?.[2] as WorkerReliabilityOptions;
    expect(options.lockDuration).toBe(60_000);
    expect(Object.hasOwn(options, 'stalledInterval')).toBe(false);
    expect(Object.hasOwn(options, 'maxStalledCount')).toBe(false);
  });

  /**
   * A worker on a producer connection loses its blocking reads under load, and the failure is
   * silent, so the wrong connection is refused before BullMQ is constructed at all.
   */
  it('refuses a producer connection', () => {
    const producer = createQueueConnection('redis://127.0.0.1:6379');
    expect(() => createWorker(QUEUE_NAMES.chatTurns, vi.fn(), { connection: producer })).toThrow(
      ConfigError,
    );
    const undefinedPolicy = { options: {} } as unknown as Redis;
    expect(() =>
      createWorker(QUEUE_NAMES.chatTurns, vi.fn(), { connection: undefinedPolicy }),
    ).toThrow(/maxRetriesPerRequest: null/);
    expect(mocks.workerCtor).not.toHaveBeenCalled();
  });
});

describe('producers', () => {
  /**
   * The BullMQ job id is the turn id, so a retried request or a redelivered message enqueues the
   * same turn once instead of running it twice in two containers.
   */
  it('enqueues a turn under its own id', async () => {
    await expect(enqueueRunTurn(fakeQueue(), { turnId: 'turn-1' })).resolves.toBe('turn-1');
    expect(mocks.add).toHaveBeenCalledWith(
      JOB_NAMES.runTurn,
      { turnId: 'turn-1' },
      { jobId: 'turn-1', ...RETENTION },
    );
  });

  /**
   * Validation happens before the queue is touched, so a malformed payload cannot become a job
   * the worker will fail to parse later.
   */
  it('rejects a malformed turn payload before adding', async () => {
    await expect(enqueueRunTurn(fakeQueue(), { turnId: '' })).rejects.toThrow();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  /**
   * "Run now" is recorded as a manual trigger so the runs table can tell it apart from a tick.
   */
  it('enqueues a manual run with the manual trigger', async () => {
    await expect(enqueueManualJobRun(fakeQueue(), { jobId: 'job-1' })).resolves.toBe(
      'generated-id',
    );
    expect(mocks.add).toHaveBeenCalledWith(
      JOB_NAMES.runScheduledJob,
      { jobId: 'job-1', trigger: 'MANUAL' },
      RETENTION,
    );
  });

  /**
   * The caller needs the id to correlate the run, so a queue that accepted the job without
   * returning one is a failure rather than a silently empty string.
   */
  it('fails when Redis returns no job id for a manual run', async () => {
    mocks.add.mockResolvedValue({ id: undefined });
    await expect(enqueueManualJobRun(fakeQueue(), { jobId: 'job-1' })).rejects.toThrow(ConfigError);
  });

  /**
   * An empty job id is refused before the queue is touched.
   */
  it('rejects a malformed manual run payload', async () => {
    await expect(enqueueManualJobRun(fakeQueue(), { jobId: '' })).rejects.toThrow();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  /**
   * Archiving twice must destroy once, so the destroy job id is derived from the chat.
   */
  it('enqueues a workspace destruction under a derived id', async () => {
    await expect(enqueueDestroyChatWorkspace(fakeQueue(), { chatId: 'chat-1' })).resolves.toBe(
      'destroy-chat-1',
    );
    expect(mocks.add).toHaveBeenCalledWith(
      JOB_NAMES.destroyChatWorkspace,
      { chatId: 'chat-1' },
      { jobId: 'destroy-chat-1', ...DESTROY_RETENTION },
    );
  });

  /**
   * The teardown job must not be retained. BullMQ answers an `add` for a job id it still holds by
   * returning the existing job instead of enqueuing, so a retained teardown would make the archive
   * that follows a restore a silent no-op and leave the new container running. Keeping the shared
   * retention here is exactly the regression this pins against.
   */
  it('keeps no history of a teardown, so a later archive can enqueue again', async () => {
    await enqueueDestroyChatWorkspace(fakeQueue(), { chatId: 'chat-1' });
    const options = mocks.add.mock.calls[0]?.[2] as {
      removeOnComplete?: number | boolean;
      removeOnFail?: number | boolean;
    };
    expect(options.removeOnComplete).toBe(true);
    expect(options.removeOnFail).toBe(true);
    expect(options.removeOnComplete).not.toBe(KEEP_COMPLETED_JOBS);
    expect(options.removeOnFail).not.toBe(KEEP_FAILED_JOBS);
  });

  /**
   * An empty chat id is refused before the queue is touched.
   */
  it('rejects a malformed destroy payload', async () => {
    await expect(enqueueDestroyChatWorkspace(fakeQueue(), { chatId: '' })).rejects.toThrow();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
