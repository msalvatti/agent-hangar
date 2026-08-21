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
 * The key, its lifetime and the payload shape are the web app's read contract, so they are
 * imported from it rather than restated: two copies of a key are two keys the day one is edited,
 * and the failure that follows is a health card reporting a worker that is running perfectly.
 */
import {
  describeClientFailure,
  WORKER_HEARTBEAT_INTERVAL_SEC,
  WORKER_HEARTBEAT_TTL_SEC,
  workerHeartbeatKey,
  workerHeartbeatSchema,
} from '@agent-hangar/core';
import type { AppConfig, Clock, WorkerHeartbeat, WorkspaceRunner } from '@agent-hangar/core';
import type { Logger } from 'pino';

import { LABELS } from './processors/constants.js';

/** Seconds to milliseconds. */
const SECOND_MS = 1000;

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
  redis: { queue: HeartbeatRedis };
}

/**
 * Takes one set of readings and publishes them.
 *
 * A daemon that does not answer is a reading, not a failure: the whole point of the key is to let
 * the UI say "Docker is down" rather than to make the worker fall over. Both readings come from
 * the same attempt for that reason — whatever the runner could not answer leaves the card saying
 * Docker is down, which is the fact an operator acts on, rather than reporting an image as absent
 * when nothing was in a position to look for it.
 *
 * The image is asked for on every beat rather than remembered from the last workspace create. What
 * the card shows is then true of the host now, including before anything has ever been created —
 * which is exactly when an operator who has not run `pnpm infra:image` is looking at it.
 *
 * @param deps - Runner, Redis, clock and logger.
 * @returns What was published.
 */
export async function writeHeartbeat(deps: HeartbeatDeps): Promise<WorkerHeartbeat> {
  let dockerOk = true;
  let containers = 0;
  let imagePresent = false;
  try {
    containers = (await deps.runner.list({ [LABELS.instance]: deps.config.AH_INSTANCE })).length;
    imagePresent = await deps.runner.imageExists(deps.config.WORKSPACE_IMAGE);
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
    imagePresent,
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
 * @param deps - Runner, Redis, clock and logger.
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
