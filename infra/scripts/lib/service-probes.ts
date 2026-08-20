/**
 * `doctor`'s Postgres and Redis probes: whether the process listening on each instance port is
 * the service that instance expects, established by making it answer.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * A TCP connect proves only that something accepted a socket. That is what the two rows used to
 * report on, and an unrelated container bound to the database port therefore rendered as a
 * healthy Postgres — a check passing exactly where the real path fails. The probes here run the
 * same two calls the application makes at boot: `SELECT 1` through the Prisma/pg client built
 * from `DATABASE_URL`, and `PING` through the ioredis client built from `REDIS_URL`. A listener
 * that is not this instance's database cannot answer the first, and one that is not a Redis
 * cannot answer the second.
 *
 * Every collaborator is injected, so the behaviour is testable both against fakes and against a
 * real socket that answers nothing.
 *
 * Outcomes are drawn from the two literals declared below and never from an error's own text: a
 * driver failure carries the connection string, password included.
 */
import type { RawEnv } from '../../../packages/core/src/config/schema.js';

/** Reported for a service that answered its probe. */
export const PROBE_OK = 'ok';

/** Reported for a Postgres that did not answer `SELECT 1`, whatever the reason. */
export const POSTGRES_FAILURE = 'no-select-1';

/** Reported for a Redis that did not answer `PING` with `PONG`, whatever the reason. */
export const REDIS_FAILURE = 'no-pong';

/** Reply a healthy Redis returns to `PING`. */
export const REDIS_PONG = 'PONG';

/** How long each probe waits for an answer before calling the service unhealthy. */
export const PROBE_TIMEOUT_MS = 5000;

/** The Redis surface a probe needs: an error sink, a ping, and a way to stop reconnecting. */
export interface ProbeRedisClient {
  /** Registers a listener; used to absorb the connection errors ioredis emits while retrying. */
  on: (event: 'error', listener: () => void) => unknown;
  /** Issues `PING`. */
  ping: () => Promise<string>;
  /** Closes the connection without waiting for in-flight commands. */
  disconnect: () => void;
}

/**
 * Collaborators of {@link probeServices}, every one of them injectable for tests.
 *
 * `TClient` is whatever {@link ServiceProbesDeps.createDatabaseClient} returns — the real Prisma
 * client in production, a bare object in tests — so no cast is needed on either side.
 */
export interface ServiceProbesDeps<TClient = unknown> {
  /** Environment to read (`process.env` in production). */
  env: RawEnv;
  /** Validates the environment and resolves `DATABASE_URL`/`REDIS_URL`. */
  loadConfig: (env: RawEnv) => { DATABASE_URL: string; REDIS_URL: string };
  /** Builds a database client from a connection string. */
  createDatabaseClient: (connectionString: string) => TClient;
  /** Resolves once the database answers `SELECT 1` within the timeout, or rejects. */
  assertDatabaseReachable: (client: TClient, timeoutMs: number) => Promise<void>;
  /** Closes the database client and its pool. */
  disconnectDatabase: (client: TClient) => Promise<void>;
  /** Builds a Redis client from a connection URL. */
  createRedisClient: (url: string) => ProbeRedisClient;
  /** Wait before a probe gives up; defaults to {@link PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A promise and the timer that has to be cleared whichever way the race ends. */
interface Deadline {
  /** Rejects once the wait is over. */
  readonly expired: Promise<never>;
  /** Cancels the pending rejection. */
  readonly cancel: () => void;
}

/**
 * Builds a promise that rejects after `timeoutMs`.
 *
 * A client that never answers leaves its promise pending forever, so every probe races against
 * one of these rather than trusting the driver to give up on its own.
 *
 * @param timeoutMs - Wait before the returned promise rejects.
 * @returns The rejecting promise and the way to cancel it.
 */
function deadline(timeoutMs: number): Deadline {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('probe timed out'));
    }, timeoutMs);
  });
  return {
    expired,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Asks the configured database to answer `SELECT 1`.
 *
 * @param deps - Injected collaborators.
 * @param connectionString - `DATABASE_URL`.
 * @param timeoutMs - Wait before the database is called unhealthy.
 * @returns {@link PROBE_OK}, or {@link POSTGRES_FAILURE}.
 */
async function probePostgres<TClient>(
  deps: ServiceProbesDeps<TClient>,
  connectionString: string,
  timeoutMs: number,
): Promise<string> {
  const client = deps.createDatabaseClient(connectionString);
  try {
    await deps.assertDatabaseReachable(client, timeoutMs);
    return PROBE_OK;
  } catch {
    return POSTGRES_FAILURE;
  } finally {
    // Best effort and time-boxed: the verdict is already decided, and closing a pool still waiting
    // on a socket nothing will ever answer can take as long as the socket does. Neither a thrown
    // teardown nor a hanging one may replace or delay a verdict that is already known.
    const closing = deadline(timeoutMs);
    await Promise.race([deps.disconnectDatabase(client), closing.expired]).catch(() => undefined);
    closing.cancel();
  }
}

/**
 * Asks the configured Redis to answer `PING` with `PONG`.
 *
 * @param deps - Injected collaborators.
 * @param url - `REDIS_URL`.
 * @param timeoutMs - Wait before the cache is called unhealthy.
 * @returns {@link PROBE_OK}, or {@link REDIS_FAILURE}.
 */
async function probeRedis<TClient>(
  deps: ServiceProbesDeps<TClient>,
  url: string,
  timeoutMs: number,
): Promise<string> {
  const client = deps.createRedisClient(url);
  // ioredis emits `error` while it retries an unreachable endpoint, and an EventEmitter with no
  // `error` listener throws that out of the process — which would abort the whole diagnostic
  // instead of reporting one unhealthy row.
  client.on('error', () => undefined);
  const wait = deadline(timeoutMs);
  try {
    const reply = await Promise.race([client.ping(), wait.expired]);
    return reply === REDIS_PONG ? PROBE_OK : REDIS_FAILURE;
  } catch {
    return REDIS_FAILURE;
  } finally {
    wait.cancel();
    client.disconnect();
  }
}

/**
 * Probes this instance's Postgres and Redis and reports one line per service.
 *
 * @param deps - Injected collaborators.
 * @returns `POSTGRES=<outcome>` and `REDIS=<outcome>`, in that order.
 */
export async function probeServices<TClient>(deps: ServiceProbesDeps<TClient>): Promise<string[]> {
  const config = deps.loadConfig(deps.env);
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [postgres, redis] = await Promise.all([
    probePostgres(deps, config.DATABASE_URL, timeoutMs),
    probeRedis(deps, config.REDIS_URL, timeoutMs),
  ]);
  return [`POSTGRES=${postgres}`, `REDIS=${redis}`];
}
