/**
 * BullMQ connection, queue and worker factories.
 *
 * Layer: infrastructure.
 *
 * This file and `./schedulers.ts` are the only modules in this package that import `bullmq` and
 * `ioredis` at runtime; everything else works against the contracts. Concentrating them here
 * means the two rules that are easy to get wrong are stated once:
 *
 * 1. Only connections that issue blocking commands may set `maxRetriesPerRequest: null`. A worker
 *    needs it — BullMQ refuses to start otherwise, because its blocking reads outlive any retry
 *    budget. A producer must not have it: a request-scoped `add` from the web app would then hang
 *    forever against an unreachable Redis instead of failing the request.
 * 2. Every job is added with a deterministic `jobId`, so a retried HTTP request or a redelivered
 *    message enqueues the same work once rather than twice.
 */
import { Queue, Worker } from 'bullmq';
import type { Processor } from 'bullmq';
import { Redis } from 'ioredis';

import { ConfigError } from '../errors.ts';

import {
  destroyChatWorkspacePayload,
  JOB_NAMES,
  QUEUE_NAMES,
  runScheduledJobPayload,
  runTurnPayload,
} from './contracts.ts';
import type { DestroyChatWorkspacePayload, QueueName, RunTurnPayload } from './contracts.ts';

/** Completed jobs kept per queue, for the runs list and for debugging. */
export const KEEP_COMPLETED_JOBS = 1000;

/** Failed jobs kept per queue; failures are the ones worth keeping longer. */
export const KEEP_FAILED_JOBS = 5000;

/** Default number of jobs a worker processes at once. */
export const DEFAULT_WORKER_CONCURRENCY = 1;

/** ioredis error message emitted when a command is issued after `quit`. */
const CONNECTION_CLOSED = 'Connection is closed';

/** Options every queue and worker factory accepts. */
export interface QueueConnectionOptions {
  /** BullMQ key prefix; integration tests use a unique one so they never collide. */
  prefix?: string;
}

/**
 * BullMQ stalled-job settings a worker may override.
 *
 * A turn holds its job far longer than the default lock, so the worker application sets all three
 * (`lockDuration` 60 s, `stalledInterval` 30 s, `maxStalledCount` 1). They are forwarded rather
 * than fixed here because only the caller knows how long its processors run.
 */
export interface WorkerReliabilityOptions {
  /** How long a job's lock survives without renewal before BullMQ treats the worker as dead. */
  lockDuration?: number;
  /** How often the worker scans for jobs whose lock expired. */
  stalledInterval?: number;
  /** How many times a stalled job may be recovered before it is failed. */
  maxStalledCount?: number;
}

/**
 * Opens a connection for producing jobs.
 *
 * Keeps ioredis' default retry budget, so an `add` against an unreachable Redis fails instead of
 * hanging a request.
 *
 * @param redisUrl - `REDIS_URL`.
 * @returns A connected client.
 */
export function createQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl);
}

/**
 * Opens a connection for consuming jobs.
 *
 * Sets `maxRetriesPerRequest: null`, which BullMQ requires of any connection that issues blocking
 * reads. Never share this connection with a producer.
 *
 * @param redisUrl - `REDIS_URL`.
 * @returns A connected client configured for blocking commands.
 */
export function createWorkerConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/**
 * Closes a connection, tolerating one that is already closed.
 *
 * @param connection - Client to close.
 * @throws Error Any failure other than the connection already being closed.
 */
export async function closeConnection(connection: Redis): Promise<void> {
  try {
    await connection.quit();
  } catch (error) {
    if (error instanceof Error && error.message.includes(CONNECTION_CLOSED)) {
      return;
    }
    throw error;
  }
}

/**
 * Creates a queue.
 *
 * @param name - One of {@link QUEUE_NAMES}.
 * @param opts - Connection and optional key prefix.
 * @returns The queue.
 */
export function createQueue<TData = unknown>(
  name: QueueName,
  opts: { connection: Redis } & QueueConnectionOptions,
): Queue<TData> {
  return new Queue<TData>(name, { connection: opts.connection, ...prefixOption(opts) });
}

/** Every queue the application uses, created on one connection. */
export interface ApplicationQueues {
  chatTurns: Queue;
  scheduledJobs: Queue;
  workspaceGc: Queue;
}

/**
 * Creates every application queue on one connection.
 *
 * @param opts - Connection and optional key prefix.
 * @returns The three queues, keyed as {@link QUEUE_NAMES} is.
 */
export function createQueues(
  opts: { connection: Redis } & QueueConnectionOptions,
): ApplicationQueues {
  return {
    chatTurns: createQueue(QUEUE_NAMES.chatTurns, opts),
    scheduledJobs: createQueue(QUEUE_NAMES.scheduledJobs, opts),
    workspaceGc: createQueue(QUEUE_NAMES.workspaceGc, opts),
  };
}

/**
 * Creates a worker.
 *
 * @param name - Queue to consume.
 * @param processor - Handler invoked per job.
 * @param opts - Connection, optional concurrency, optional key prefix and optional stalled-job
 *   settings, each forwarded to BullMQ only when it was given.
 * @returns The worker, already running.
 * @throws ConfigError When the connection is not one {@link createWorkerConnection} produced; a
 *   worker on a producer connection drops its blocking reads under load.
 */
export function createWorker<TData = unknown>(
  name: QueueName,
  processor: Processor<TData>,
  opts: { connection: Redis; concurrency?: number } & QueueConnectionOptions &
    WorkerReliabilityOptions,
): Worker<TData> {
  if (opts.connection.options.maxRetriesPerRequest !== null) {
    throw new ConfigError(
      'worker connections require maxRetriesPerRequest: null — use createWorkerConnection()',
    );
  }
  return new Worker<TData>(name, processor, {
    connection: opts.connection,
    concurrency: opts.concurrency ?? DEFAULT_WORKER_CONCURRENCY,
    ...prefixOption(opts),
    ...reliabilityOptions(opts),
  });
}

/**
 * Narrows the optional prefix to an object that can be spread under `exactOptionalPropertyTypes`.
 *
 * @param opts - Options that may carry a prefix.
 * @returns `{ prefix }` when one was given, `{}` otherwise.
 */
function prefixOption(opts: QueueConnectionOptions): { prefix?: string } {
  return opts.prefix === undefined ? {} : { prefix: opts.prefix };
}

/**
 * Narrows the optional stalled-job settings the same way, so an absent field is omitted rather
 * than passed as `undefined`, which BullMQ would take as an explicit override of its default.
 *
 * @param opts - Options that may carry stalled-job settings.
 * @returns Only the settings that were given.
 */
function reliabilityOptions(opts: WorkerReliabilityOptions): WorkerReliabilityOptions {
  return {
    ...(opts.lockDuration === undefined ? {} : { lockDuration: opts.lockDuration }),
    ...(opts.stalledInterval === undefined ? {} : { stalledInterval: opts.stalledInterval }),
    ...(opts.maxStalledCount === undefined ? {} : { maxStalledCount: opts.maxStalledCount }),
  };
}

/** Job options shared by every producer: deterministic id plus bounded retention. */
const RETENTION = {
  removeOnComplete: KEEP_COMPLETED_JOBS,
  removeOnFail: KEEP_FAILED_JOBS,
} as const;

/**
 * Retention of the workspace teardown job, which keeps no history on purpose.
 *
 * Its job id is derived from the chat so that a double archive tears down once. A *retained* job
 * keeps that id taken, though, and BullMQ answers an `add` for an id it still holds by returning
 * the existing job instead of enqueuing a new one — silently, without throwing. A chat can be
 * archived, restored into a fresh workspace and archived again, so an id that outlived its
 * teardown would drop the second request and leave the new container running with the repository
 * and its credentials still mounted. Releasing the job as soon as it resolves scopes the
 * deduplication to the window that actually races — two archives before the first teardown ran —
 * while the durable record of a failed teardown is the `FAILED` workspace row the worker writes,
 * not the Redis job.
 */
const DESTROY_RETENTION = {
  removeOnComplete: true,
  removeOnFail: true,
} as const;

/**
 * Enqueues a chat turn.
 *
 * The BullMQ job id is the turn id, so a retried request enqueues the same turn once.
 *
 * @param queue - The `chat-turns` queue.
 * @param payload - `{ turnId }`.
 * @returns The job id, equal to the turn id.
 * @throws ZodError When the payload does not satisfy the contract.
 */
export async function enqueueRunTurn(queue: Queue, payload: RunTurnPayload): Promise<string> {
  const data = runTurnPayload.parse(payload);
  await queue.add(JOB_NAMES.runTurn, data, { jobId: data.turnId, ...RETENTION });
  return data.turnId;
}

/**
 * Enqueues a one-off run of a scheduled job.
 *
 * Manual runs deliberately carry no deterministic id: pressing "Run now" twice is two runs, which
 * is what the user asked for. The overlap policy is what stops them from piling up.
 *
 * @param queue - The `scheduled-jobs` queue.
 * @param payload - `{ jobId }`.
 * @returns The generated job id.
 * @throws ZodError When the payload does not satisfy the contract.
 * @throws ConfigError When BullMQ returns a job without an id.
 */
export async function enqueueManualJobRun(
  queue: Queue,
  payload: { jobId: string },
): Promise<string> {
  const data = runScheduledJobPayload.parse({ jobId: payload.jobId, trigger: 'MANUAL' });
  const job = await queue.add(JOB_NAMES.runScheduledJob, data, RETENTION);
  if (job.id === undefined) {
    throw new ConfigError('Redis accepted the manual run but returned no job id');
  }
  return job.id;
}

/**
 * Enqueues the destruction of a chat's workspace, as archiving does.
 *
 * The job id is derived from the chat, so archiving twice destroys once. The job is not retained
 * after it resolves: see {@link DESTROY_RETENTION} for why holding the id would make the archive
 * that follows a restore a no-op.
 *
 * @param queue - The `workspace-gc` queue.
 * @param payload - `{ chatId }`.
 * @returns The job id.
 * @throws ZodError When the payload does not satisfy the contract.
 */
export async function enqueueDestroyChatWorkspace(
  queue: Queue,
  payload: DestroyChatWorkspacePayload,
): Promise<string> {
  const data = destroyChatWorkspacePayload.parse(payload);
  const jobId = `destroy-${data.chatId}`;
  await queue.add(JOB_NAMES.destroyChatWorkspace, data, { jobId, ...DESTROY_RETENTION });
  return jobId;
}
