/**
 * Starting and stopping the worker: schedulers reconciled, three consumers running, one shutdown.
 *
 * Layer: service (composition).
 *
 * The application is separated from `main.ts` so that everything except `process` and the real
 * clients can be unit-tested: which queues get a consumer, with which concurrency and which
 * stalled-job settings, and what a shutdown does when a turn refuses to end.
 */
import { createWorker as createBullWorker, QUEUE_NAMES } from '@agent-hangar/core';
import type { QueueName, WorkspaceRunner } from '@agent-hangar/core';
import type { Redis } from 'ioredis';

import type { ContainerDatabase, WorkerContainer, WorkerRedisClient } from './container.js';
import { LABELS, SHUTDOWN_GRACE_MS, WORKER_RELIABILITY } from './processors/constants.js';
import { createGcProcessor } from './processors/gc.js';
import { createRunScheduledJobProcessor } from './processors/run-scheduled-job.js';
import { createRunTurnProcessor } from './processors/run-turn.js';
import type { ProcessorJob } from './processors/types.js';
import { reconcileSchedulers } from './scheduler-reconcile.js';

/** The part of a BullMQ worker this application drives. */
export interface WorkerLike {
  /**
   * Stops consuming.
   *
   * @param force - Abandon jobs still in flight instead of waiting for them.
   */
  close(force?: boolean): Promise<void>;
  /**
   * Subscribes to a worker event.
   *
   * @param event - Event name.
   * @param listener - Handler.
   */
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/** Options every consumer is created with. */
export interface CreateWorkerOptions<TRedis> {
  connection: TRedis;
  concurrency: number;
  lockDuration: number;
  stalledInterval: number;
  maxStalledCount: number;
}

/**
 * Reports whether the workspace image is present.
 *
 * @param runner - The workspace runner.
 * @param image - Image reference from the configuration.
 * @param instance - Instance name, used as the label selector of the reachability probe.
 * @returns `true` when a workspace can be created from the image.
 */
export type ImageProbe = (
  runner: WorkspaceRunner,
  image: string,
  instance: string,
) => Promise<boolean>;

/** How the application builds what it cannot build itself. */
export interface StartWorkerFactories<TRedis> {
  /**
   * Creates one consumer.
   *
   * @param name - Queue to consume.
   * @param processor - Handler invoked per job.
   * @param options - Connection, concurrency and stalled-job settings.
   */
  createWorker<TData>(
    name: QueueName,
    processor: (job: ProcessorJob<TData>) => Promise<unknown>,
    options: CreateWorkerOptions<TRedis>,
  ): WorkerLike;
  /** Image presence check; defaults to {@link probeRunnerReachable}. */
  checkImage?: ImageProbe;
}

/** A running worker. */
export interface RunningWorker {
  /** Stops every consumer and releases the container; idempotent. */
  shutdown(): Promise<void>;
}

/**
 * Proves the runner answers, and defers the image check to the first workspace.
 *
 * The `WorkspaceRunner` port exposes no image lookup, so nothing cheaper than creating a container
 * can prove the image exists. Listing this instance's workspaces proves the daemon is reachable,
 * which is the half of the check that is worth failing loudly about at boot; the other half is
 * raised by `create` as `WorkspaceImageMissing`, carrying the command that builds it. A contract
 * change request asks the Docker runner for an `imageExists` so this can become a real check.
 *
 * @param runner - The workspace runner.
 * @param _image - Image reference; unused until the runner can look one up.
 * @param instance - Instance name, used as the label selector.
 * @returns `true` whenever the daemon answered.
 */
export const probeRunnerReachable: ImageProbe = async (runner, _image, instance) => {
  await runner.list({ [LABELS.instance]: instance });
  return true;
};

/** The real wiring, used by `main.ts`. */
export const defaultWorkerFactories: StartWorkerFactories<Redis> = {
  createWorker: createBullWorker,
};

/**
 * Waits, without holding the process open.
 *
 * @param ms - How long to wait.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Builds the idempotent shutdown of a running worker.
 *
 * In-flight turns are given {@link SHUTDOWN_GRACE_MS} to finish, because a turn interrupted
 * halfway leaves a container the next boot has to reconcile. Past that, they are abandoned: a
 * runaway turn must not stop the process from exiting.
 *
 * @param workers - The consumers to stop.
 * @param container - Released once the consumers are stopped.
 * @returns A function that stops everything at most once.
 */
function createShutdown(
  workers: readonly WorkerLike[],
  container: {
    logger: { info: (message: string) => void; warn: (message: string) => void };
    close: () => Promise<void>;
  },
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    container.logger.info('stopping workers');
    const closed = Promise.all(workers.map((worker) => worker.close())).then(() => false);
    if (await Promise.race([closed, delay(SHUTDOWN_GRACE_MS).then(() => true)])) {
      container.logger.warn('workers did not stop in time; abandoning jobs still in flight');
      await Promise.all(workers.map((worker) => worker.close(true)));
    }
    await container.close();
  };
  return (): Promise<void> => (inFlight ??= run());
}

/**
 * Starts the worker application.
 *
 * @param container - The dependency container.
 * @param factories - How to create consumers, and optionally how to check the image.
 * @returns The running worker.
 */
export async function startWorker<
  TDatabase extends ContainerDatabase,
  TRedis extends WorkerRedisClient,
>(
  container: WorkerContainer<TDatabase, TRedis>,
  factories: StartWorkerFactories<TRedis>,
): Promise<RunningWorker> {
  const { config, logger } = container;
  const probe = factories.checkImage ?? probeRunnerReachable;
  if (!(await probe(container.runner, config.WORKSPACE_IMAGE, config.AH_INSTANCE))) {
    logger.error(
      { image: config.WORKSPACE_IMAGE },
      'workspace image missing — build it with: pnpm infra:image',
    );
  }

  await reconcileSchedulers(container);

  const options = { connection: container.redis.worker, ...WORKER_RELIABILITY };
  const workers = [
    factories.createWorker(QUEUE_NAMES.chatTurns, createRunTurnProcessor(container), {
      ...options,
      concurrency: config.WORKER_TURN_CONCURRENCY,
    }),
    factories.createWorker(QUEUE_NAMES.scheduledJobs, createRunScheduledJobProcessor(container), {
      ...options,
      concurrency: 1,
    }),
    factories.createWorker(QUEUE_NAMES.workspaceGc, createGcProcessor(container), {
      ...options,
      concurrency: 1,
    }),
  ];
  for (const worker of workers) {
    worker.on('failed', (job: { id?: string } | undefined, error: unknown) => {
      logger.error({ err: error, jobId: job?.id }, 'job failed');
    });
    worker.on('error', (error: unknown) => {
      logger.error({ err: error }, 'worker error');
    });
  }

  logger.info(
    {
      instance: config.AH_INSTANCE,
      runner: container.runner.kind,
      concurrency: config.WORKER_TURN_CONCURRENCY,
    },
    'worker ready',
  );
  return { shutdown: createShutdown(workers, container) };
}
