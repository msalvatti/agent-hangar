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
import { ConfigError } from '@agent-hangar/core';
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

async function assertRedisReachable(redis: BootRedis, url: string): Promise<void> {
  let reply: string;
  try {
    reply = await redis.ping();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`redis unreachable at ${url}: ${detail}`, { cause: error });
  }
  if (reply !== 'PONG') {
    throw new ConfigError(`redis unreachable at ${url}: unexpected PING reply "${reply}"`);
  }
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

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    logger.info('shutting down');
    await redis.quit();
    await prisma.$disconnect();
    logger.info('shutdown complete');
  };

  return { config, prisma, redis, shutdown };
}
