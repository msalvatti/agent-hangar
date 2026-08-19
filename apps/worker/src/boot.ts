/**
 * Worker boot sequence: validate configuration, prove Postgres and Redis are reachable, and
 * hand back a `shutdown()` that closes both.
 *
 * Layer: service (composition).
 *
 * Every dependency is injected so the sequence is unit-tested with fakes; `main.ts` wires the real
 * ones. Failing fast here (instead of on the first job) is what makes `pnpm dev` print a clear
 * message when the compose instance is down.
 */
import type { AppConfig } from '@agent-hangar/core';
import { ConfigError, describeClientFailure } from '@agent-hangar/core';
import type { Logger } from 'pino';

/** The part of the Prisma client the boot needs. */
export interface BootDatabase {
  $disconnect(): Promise<void>;
}

/** The part of an ioredis client the boot needs. */
export interface BootRedis {
  ping(): Promise<string>;
  quit(): Promise<unknown>;
}

/** Injectable collaborators. */
export interface BootDeps<
  TDatabase extends BootDatabase = BootDatabase,
  TRedis extends BootRedis = BootRedis,
> {
  loadConfig: () => AppConfig;
  createPrismaClient: (options: { connectionString: string }) => TDatabase;
  assertDatabaseReachable: (client: TDatabase) => Promise<void>;
  createRedis: (url: string) => TRedis;
  logger: Logger;
}

/** What a booted worker holds. */
export interface BootResult<
  TDatabase extends BootDatabase = BootDatabase,
  TRedis extends BootRedis = BootRedis,
> {
  config: AppConfig;
  prisma: TDatabase;
  redis: TRedis;
  /** Closes Redis then Postgres; safe to call once. */
  shutdown: () => Promise<void>;
}

/** Stands in for a URL that cannot be named without risking a credential. */
export const REDACTED_URL = '(redacted url)';

/**
 * Reduces a connection URL to the parts that are safe to print: scheme, host and path.
 *
 * Rebuilding from those three is deliberate. Removing the components known to be dangerous would
 * mean keeping up with every place a credential can hide, and each of them is reachable here,
 * because the environment schema only asks `URL` to parse the value:
 *
 * - userinfo, as in `redis://ah:pw@cache:6379`;
 * - the query, as in `redis://cache:6379?password=pw` — ioredis reads query parameters as
 *   connection options, so that is a supported way to spell the password, not a typo;
 * - the fragment, which `repo-url.ts` already treats as credential-bearing for the same reason.
 *
 * An authority-less URL such as `redis:/ah:pw@cache` parses with an empty host and the whole of
 * `ah:pw@cache` as its path, so nothing safe is left to name; it and an outright unparseable value
 * are both reported as {@link REDACTED_URL}. Losing the target from one boot message costs a
 * little diagnosis; repeating a password costs more.
 *
 * @param url - Connection URL (may carry credentials in userinfo, query or fragment).
 * @returns `scheme//host/path`, or {@link REDACTED_URL} when no host can be isolated.
 */
export function describeUrl(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null || parsed.host === '') {
    return REDACTED_URL;
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

async function assertRedisReachable(redis: BootRedis, url: string): Promise<void> {
  const target = describeUrl(url);
  let reply: string;
  try {
    reply = await redis.ping();
  } catch (error) {
    // The driver's message and the error itself both carry the connection string, password
    // included, and `cause` republishes it to anything walking the chain.
    throw new ConfigError(`redis unreachable at ${target} (${describeClientFailure(error)})`);
  }
  if (reply !== 'PONG') {
    throw new ConfigError(`redis unreachable at ${target}: unexpected PING reply "${reply}"`);
  }
}

/**
 * Builds the idempotent shutdown of a booted worker.
 *
 * Every client is released even when an earlier release fails: letting a rejected `redis.quit()`
 * skip `$disconnect()` would leave the Postgres pool open for the rest of the process's life. The
 * first failure is the one thrown, because it is the one that explains the shutdown.
 *
 * @param redis - Redis client, closed first so no late job can query a gone database.
 * @param prisma - Prisma client, whose pool is always released.
 * @param logger - Logger for the shutdown breadcrumbs.
 * @returns A function that closes both clients at most once. A concurrent second call joins the
 *   run already in flight instead of resolving immediately: SIGINT and SIGTERM are separate
 *   handlers that each exit the process once this settles, so a second signal arriving mid-shutdown
 *   would otherwise kill the process with Redis and Prisma still open.
 */
function createShutdown(
  redis: BootRedis,
  prisma: BootDatabase,
  logger: Logger,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    logger.info('shutting down');
    const failures: unknown[] = [];
    try {
      await redis.quit();
    } catch (error) {
      failures.push(error);
    }
    try {
      await prisma.$disconnect();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw failures[0];
    }
    logger.info('shutdown complete');
  };
  return (): Promise<void> => (inFlight ??= run());
}

/**
 * Boots the worker.
 *
 * @param deps - Injected collaborators.
 * @returns Config, clients and a shutdown function.
 * @throws ConfigError when configuration is invalid or Postgres/Redis do not answer.
 */
export async function boot<TDatabase extends BootDatabase, TRedis extends BootRedis>(
  deps: BootDeps<TDatabase, TRedis>,
): Promise<BootResult<TDatabase, TRedis>> {
  const config = deps.loadConfig();
  const { logger } = deps;
  logger.info({ instance: config.AH_INSTANCE }, 'booting worker');

  const prisma = deps.createPrismaClient({ connectionString: config.DATABASE_URL });
  try {
    await deps.assertDatabaseReachable(prisma);
  } catch (error) {
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
  logger.debug('postgres reachable');

  const redis = deps.createRedis(config.REDIS_URL);
  try {
    await assertRedisReachable(redis, config.REDIS_URL);
  } catch (error) {
    await redis.quit().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
  logger.debug('redis reachable');

  return { config, prisma, redis, shutdown: createShutdown(redis, prisma, logger) };
}
