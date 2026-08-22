/**
 * `GET /api/health` — the environment card and the doctor's API twin.
 *
 * Layer: service (server).
 *
 * Docker and the workspace image are reported from the heartbeat the worker writes to Redis rather
 * than from a Docker connection of this process. The web app owns no Docker client — that stays
 * behind the runner in core — and the route is polled by the UI, so it has to stay cheap.
 *
 * The route never throws: an unreachable dependency is what it exists to report, so every probe
 * resolves to `{ ok: false }` with a classification written in this repository. A driver's own
 * message is never repeated, because a connection failure quotes the connection string, password
 * included.
 */
import {
  describeClientFailure,
  healthResponse,
  WORKER_HEARTBEAT_TTL_SEC,
  workerHeartbeatKey,
  workerHeartbeatSchema,
} from '@agent-hangar/core';
import type { WorkerHeartbeat } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { jsonResponse, withErrorHandling } from '../http';
import { assertKnownHost } from '../same-origin';
import { TIMED_OUT, withTimeout } from '../timeout';
import type { ProbeResult } from '../timeout';

/** How long a probe may take before it is reported as unreachable. */
export const PROBE_TIMEOUT_MS = 2000;

/** Detail reported when the worker has not written a heartbeat this instance can read. */
export const WORKER_SILENT = 'worker has not reported';

/** Detail reported for Docker and the image while the worker that measures them is silent. */
export const UNKNOWN_WITHOUT_WORKER = 'unknown while the worker is down';

/** Detail reported when the heartbeat says Docker did not answer. */
export const DOCKER_UNREACHABLE = 'docker did not answer the worker';

/** Detail reported when the workspace image is not on the Docker host. */
export const IMAGE_MISSING = 'run pnpm infra:image';

/**
 * Runs one probe, bounded and never rejecting.
 *
 * @param container - The server container.
 * @param name - Probe name, used only in the log line.
 * @param work - The command to await.
 * @returns Whether it answered, and why it did not when it did not.
 */
async function probe(
  container: ServerContainer,
  name: string,
  work: () => Promise<unknown>,
): Promise<ProbeResult> {
  const attempt = work().then(
    (): ProbeResult => ({ ok: true }),
    (error: unknown): ProbeResult => {
      const detail = describeClientFailure(error);
      container.logger.warn({ probe: name, failure: detail }, 'health probe failed');
      return { ok: false, detail };
    },
  );
  return withTimeout(attempt, PROBE_TIMEOUT_MS, () => ({ ok: false, detail: TIMED_OUT }));
}

/**
 * Reads the worker's heartbeat, if it wrote a fresh and valid one.
 *
 * @param container - The server container.
 * @returns The heartbeat, or `null` when it is absent, unreadable or older than its lifetime.
 */
async function readHeartbeat(container: ServerContainer): Promise<WorkerHeartbeat | null> {
  const raw = await withTimeout(
    container.redis.get(workerHeartbeatKey(container.config.AH_INSTANCE)).catch(
      // Stryker disable next-line ArrowFunction
      () => null,
    ),
    PROBE_TIMEOUT_MS,
    // Stryker disable next-line ArrowFunction
    () => null,
  );
  // Nothing read and nothing readable are the same answer, which is why neither the failure above
  // nor the timeout beside it needs a value of its own: both say only that no heartbeat arrived.
  // Stryker disable next-line ConditionalExpression,BlockStatement
  if (raw === null) {
    return null;
  }
  const stored = parseStoredHeartbeat(raw);
  if (stored === null) {
    return null;
  }
  const age = container.clock.now().getTime() - new Date(stored.at).getTime();
  return age <= WORKER_HEARTBEAT_TTL_SEC * 1000 ? stored : null;
}

/**
 * Reads a heartbeat out of the text stored under the key.
 *
 * Another process writes that key, so neither the JSON nor the shape is trusted: text that is not
 * JSON, and JSON that is not a heartbeat, are both a worker reporting nothing.
 *
 * @param raw - Text read from Redis.
 * @returns The heartbeat, or `null` when the text is not one.
 */
function parseStoredHeartbeat(raw: string): WorkerHeartbeat | null {
  try {
    const parsed = workerHeartbeatSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Turns a probe result into the contract's check shape.
 *
 * @param result - Outcome of a probe.
 * @returns `{ ok }`, plus a detail when there is one worth showing.
 */
function toCheck(result: ProbeResult): { ok: boolean; detail?: string } {
  // The key is left out rather than set to nothing, because this project may not hand an optional
  // property an explicit `undefined` — and JSON drops such a key on the way out anyway, which is
  // why no reader of this response can tell the two spellings apart.
  // Stryker disable next-line ConditionalExpression
  return result.detail === undefined ? { ok: result.ok } : { ok: result.ok, detail: result.detail };
}

/**
 * Describes what the heartbeat says about the worker, Docker and the workspace image.
 *
 * Docker and the image are the worker's readings, so a silent worker leaves both unknown rather
 * than failed. They are still reported as not-ok — an unconfirmed dependency cannot be called
 * healthy — but the detail says which of the three is actually missing, so the operator starts the
 * worker instead of restarting a daemon that was answering all along.
 *
 * @param heartbeat - The worker's last reading, or `null` when it has not reported.
 * @returns One check per fact.
 */
function fromHeartbeat(heartbeat: WorkerHeartbeat | null): {
  worker: { ok: boolean; detail?: string; lastSeenAt?: string };
  docker: { ok: boolean; detail?: string };
  image: { ok: boolean; detail?: string };
} {
  if (heartbeat === null) {
    return {
      worker: { ok: false, detail: WORKER_SILENT },
      docker: { ok: false, detail: UNKNOWN_WITHOUT_WORKER },
      image: { ok: false, detail: UNKNOWN_WITHOUT_WORKER },
    };
  }
  return {
    worker: { ok: true, lastSeenAt: heartbeat.at },
    docker: heartbeat.dockerOk ? { ok: true } : { ok: false, detail: DOCKER_UNREACHABLE },
    image: heartbeat.imagePresent ? { ok: true } : { ok: false, detail: IMAGE_MISSING },
  };
}

/**
 * `GET /api/health` — reachability of the database, Redis, Docker and the workspace image.
 *
 * @param container - The server container.
 * @param request - The incoming request; only its addressed host is read.
 * @returns `200` with the health report; `ok` is false when a dependency is unreachable.
 */
export function getHealth(container: ServerContainer, request: Request): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertKnownHost(request);
    const [db, redis, heartbeat] = await Promise.all([
      probe(container, 'db', () => container.prisma.$queryRaw`SELECT 1`),
      probe(container, 'redis', () => container.redis.ping()),
      readHeartbeat(container),
    ]);
    const { worker, docker, image } = fromHeartbeat(heartbeat);
    return jsonResponse(
      healthResponse,
      {
        ok: db.ok && redis.ok && worker.ok && docker.ok && image.ok,
        instance: container.config.AH_INSTANCE,
        ports: {
          web: container.config.WEB_PORT,
          postgres: container.config.POSTGRES_PORT,
          redis: container.config.REDIS_PORT,
        },
        checks: { db: toCheck(db), redis: toCheck(redis), docker, image, worker },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  });
}
