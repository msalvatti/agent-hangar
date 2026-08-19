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

/** Stands in for a URL whose credentials cannot be proved removed. */
export const OPAQUE_URL = '(unparseable url)';

/**
 * Returns a URL with any credentials removed, safe for error messages and logs.
 *
 * Blanking the userinfo only removes a password when the URL actually has an authority to blank.
 * `URL` parses an authority-less form such as `redis:/ah:pw@host` — which the environment schema
 * accepts, since it is a valid URL — into an empty host and a path of `ah:pw@host`, leaving
 * `username`/`password` empty and the password sitting in the path. Echoing the input for those,
 * as for an outright unparseable one, would put the credential straight into the boot error this
 * module raises. Anything without a host is therefore reported as {@link OPAQUE_URL} instead:
 * losing the target from the message costs a little diagnosis, repeating a password costs more.
 *
 * @param url - Connection URL (may carry `user:password@`).
 * @returns The URL without userinfo, or {@link OPAQUE_URL} when it has no host to strip one from.
 */
export function describeUrl(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null || parsed.host === '') {
    return OPAQUE_URL;
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
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
