/**
 * The worker's heartbeat key, as the harness needs to touch it.
 *
 * Layer: test support (connects to Redis).
 *
 * The readiness gate decides the worker is up from what the health route reports, and the health
 * route reports it from this key. The key outlives the process that wrote it — it carries a
 * time-to-live longer than the gate's budget — so a run that did not clear it could satisfy its
 * own gate with the previous run's heartbeat. Clearing it is what makes the gate a statement about
 * this run's worker.
 */
import { workerHeartbeatKey } from '@agent-hangar/core';
import Redis from 'ioredis';

import type { E2eEnv } from './env';

/**
 * Removes any heartbeat left by an earlier worker of this instance.
 *
 * @param env - The resolved environment, naming the instance and its Redis.
 */
export async function clearWorkerHeartbeat(env: E2eEnv): Promise<void> {
  const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 1 });
  try {
    await redis.del(workerHeartbeatKey(env.instance));
  } finally {
    await redis.quit();
  }
}
