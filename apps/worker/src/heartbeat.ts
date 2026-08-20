/**
 * The health heartbeat: what the worker knows about Docker, published for the web app to read.
 *
 * Layer: service.
 *
 * `GET /api/health` reports Docker reachability and workspace-image presence from this key and
 * from nothing else, because only the worker owns a Docker connection and the health route is
 * polled by every open tab. A key that stops being rewritten is therefore how a dead worker
 * becomes visible, which is why the lifetime is short and the rewrite is frequent.
 *
 * The key, its lifetime and the payload shape are the web app's read contract; they are spelled
 * here until the shared queue contract carries them.
 */
import { describeClientFailure } from '@agent-hangar/core';
import type { AppConfig, Clock, WorkspaceRunner } from '@agent-hangar/core';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { WorkspaceImageStatus } from './image-status.js';
import { LABELS } from './processors/constants.js';

/** Lifetime of the heartbeat key, in seconds; three writes fit inside it. */
export const WORKER_HEARTBEAT_TTL_SEC = 90;

/** How often the heartbeat is rewritten, in seconds. */
export const WORKER_HEARTBEAT_INTERVAL_SEC = 30;

/** Seconds to milliseconds. */
const SECOND_MS = 1000;

/**
 * Redis key holding one instance's worker heartbeat.
 *
 * @param instance - `AH_INSTANCE`.
 * @returns The key the web app reads.
 */
export function workerHeartbeatKey(instance: string): string {
  return `health:worker:${instance}`;
}

/** What the worker publishes about its own health. */
export const workerHeartbeatSchema = z.object({
  /** When the worker took these readings. */
  at: z.iso.datetime(),
  /** Whether the Docker daemon answered. */
  dockerOk: z.boolean(),
  /** Whether the workspace image is present on the Docker host. */
  imagePresent: z.boolean(),
  /** Workspace containers the instance owned at that moment. */
  containers: z.number().int().nonnegative(),
});

/** A worker heartbeat. */
export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;

/** The Redis surface the heartbeat needs; ioredis' `Redis` satisfies it. */
export interface HeartbeatRedis {
  /**
   * Writes a value with a lifetime.
   *
   * @param key - Key to write.
   * @param value - Value to store.
   * @param mode - Always `EX`, so the lifetime is in seconds.
   * @param seconds - Lifetime.
   */
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** What {@link writeHeartbeat} needs. */
export interface HeartbeatDeps {
  config: AppConfig;
  clock: Clock;
  logger: Logger;
  runner: WorkspaceRunner;
  imageStatus: WorkspaceImageStatus;
  redis: { queue: HeartbeatRedis };
}

/**
 * Takes one set of readings and publishes them.
 *
 * A daemon that does not answer is a reading, not a failure: the whole point of the key is to let
 * the UI say "Docker is down" rather than to make the worker fall over.
 *
 * @param deps - Runner, Redis, clock, image status and logger.
 * @returns What was published.
 */
export async function writeHeartbeat(deps: HeartbeatDeps): Promise<WorkerHeartbeat> {
  let dockerOk = true;
  let containers = 0;
  try {
    containers = (await deps.runner.list({ [LABELS.instance]: deps.config.AH_INSTANCE })).length;
  } catch (error) {
    dockerOk = false;
    deps.logger.warn(
      { failure: describeClientFailure(error) },
      'the workspace runner did not answer the health probe',
    );
  }
  const heartbeat = workerHeartbeatSchema.parse({
    at: deps.clock.now().toISOString(),
    dockerOk,
    imagePresent: dockerOk && deps.imageStatus.present(),
    containers,
  });
  await deps.redis.queue.set(
    workerHeartbeatKey(deps.config.AH_INSTANCE),
    JSON.stringify(heartbeat),
    'EX',
    WORKER_HEARTBEAT_TTL_SEC,
  );
  return heartbeat;
}

/** A running heartbeat. */
export interface RunningHeartbeat {
  /** Stops rewriting the key; the last one expires on its own. */
  stop(): void;
}

/**
 * Publishes a heartbeat now and keeps rewriting it.
 *
 * The timer is unreferenced so it never holds the process open, and a failed write is logged
 * rather than thrown: the worker's job is to run turns, and it must not exit because a health key
 * could not be refreshed.
 *
 * @param deps - Runner, Redis, clock, image status and logger.
 * @returns A handle that stops the rewrites.
 */
export async function startHeartbeat(deps: HeartbeatDeps): Promise<RunningHeartbeat> {
  const publish = async (): Promise<void> => {
    try {
      await writeHeartbeat(deps);
    } catch (error) {
      // A failed write is almost always ioredis, whose message carries the connection string.
      deps.logger.warn(
        { failure: describeClientFailure(error) },
        'publishing the worker heartbeat failed',
      );
    }
  };
  await publish();
  const timer = setInterval(() => {
    void publish();
  }, WORKER_HEARTBEAT_INTERVAL_SEC * SECOND_MS);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
