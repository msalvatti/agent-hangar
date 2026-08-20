/**
 * Server-side dependency container: one set of connections per Node process, injectable in tests.
 *
 * Layer: service (server).
 *
 * Route handlers are pure functions of this container, which is what lets them run against
 * in-memory repositories and fake queues without Next.js. Nothing connects at construction time —
 * Prisma and ioredis both open lazily — so importing a route module costs no I/O.
 *
 * The instance is cached on `globalThis` under a symbol rather than in a module-level variable:
 * Next.js reloads route modules on every edit in development, and a module-scoped cache would
 * leak a Prisma pool and a Redis connection per reload.
 */
import {
  createLogger,
  createPrismaClient,
  createQueues,
  createRedactor,
  createRepositories,
  createSecretsService,
  disconnectPrisma,
  loadConfig,
  MasterKeyFile,
  SSE_HEARTBEAT_MS,
  systemClock,
} from '@agent-hangar/core';
import type {
  AppConfig,
  ApplicationQueues,
  Clock,
  DatabaseClient,
  Redactor,
  Repositories,
  SecretsService,
} from '@agent-hangar/core';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { createGithubClient } from './github';
import type { GithubClient } from './github';
import type { RedisCommands } from './redis';

/** How long a blocking `XREAD` waits before the stream loop rechecks its exit conditions. */
export const SSE_BLOCK_MS = 15_000;

/** Everything a route handler is allowed to reach. */
export interface ServerContainer {
  readonly config: AppConfig;
  readonly logger: Logger;
  /** Only used for the health probe; every read and write goes through {@link ServerContainer.repos}. */
  readonly prisma: DatabaseClient;
  readonly repos: Repositories;
  /** Shared command connection; blocking reads run on a duplicate of it. */
  readonly redis: RedisCommands;
  readonly queues: ApplicationQueues;
  readonly secrets: SecretsService;
  readonly redactor: Redactor;
  readonly github: GithubClient;
  readonly clock: Clock;
  readonly sse: { heartbeatMs: number; blockMs: number };
  /** Closes queues, Redis and Prisma; safe to call more than once. */
  dispose(): Promise<void>;
}

/** Collaborators {@link createServerContainer} accepts instead of building them. */
export type ServerContainerDeps = Omit<ServerContainer, 'dispose'>;

/** Key of the cached container on `globalThis`, stable across Next.js module reloads. */
const CONTAINER_KEY: unique symbol = Symbol.for('agent-hangar.server-container');

/** `globalThis` seen as the store the cache lives in. */
interface ContainerHost {
  [CONTAINER_KEY]?: ServerContainer;
}

/**
 * Reads `globalThis` as the cache store.
 *
 * @returns The global object, typed with the cache slot.
 */
function containerHost(): ContainerHost {
  return globalThis as ContainerHost;
}

/**
 * Resolves the database client and the repositories over it.
 *
 * They are injected as a pair because they are two views of one store: the repositories are built
 * from a concrete Prisma client, while the container only ever calls `$queryRaw`/`$disconnect` on
 * it, so a test that supplies its own repositories supplies the matching probe target too.
 *
 * @param deps - Injected collaborators.
 * @param config - Loaded configuration.
 * @param redactor - Redactor the repositories apply on write.
 * @returns The client used for probes and the repositories.
 */
function buildPersistence(
  deps: Partial<ServerContainerDeps>,
  config: AppConfig,
  redactor: Redactor,
): { prisma: DatabaseClient; repos: Repositories } {
  if (deps.prisma !== undefined && deps.repos !== undefined) {
    return { prisma: deps.prisma, repos: deps.repos };
  }
  const client = createPrismaClient({ connectionString: config.DATABASE_URL });
  return { prisma: client, repos: createRepositories(client, redactor) };
}

/**
 * Resolves the Redis client and the queues built on it.
 *
 * Injected as a pair for the same reason as the persistence pair: BullMQ takes a concrete ioredis
 * client, while the container itself only issues the commands of {@link RedisCommands}, so a test
 * that brings its own queues brings the matching command double too.
 *
 * The client is built here rather than with the core `createQueueConnection` factory because that
 * one connects on construction: Next.js imports route modules eagerly, and a web process must not
 * open a socket merely because a module was loaded. The producer retry budget stays at its default,
 * which is the rule that factory exists to state — `maxRetriesPerRequest: null` belongs to workers,
 * and a request-scoped `add` must fail rather than hang.
 *
 * @param deps - Injected collaborators.
 * @param config - Loaded configuration.
 * @returns The command client and the three application queues.
 */
function buildMessaging(
  deps: Partial<ServerContainerDeps>,
  config: AppConfig,
): { redis: RedisCommands; queues: ApplicationQueues } {
  if (deps.redis !== undefined && deps.queues !== undefined) {
    return { redis: deps.redis, queues: deps.queues };
  }
  const client = new Redis(config.REDIS_URL, { lazyConnect: true });
  return { redis: client, queues: createQueues({ connection: client }) };
}

/**
 * Builds a container, using every injected collaborator and constructing only the rest.
 *
 * @param deps - Collaborators to use instead of the real ones.
 * @returns A container. No connection is opened until the first query, command or job.
 */
export function createServerContainer(deps: Partial<ServerContainerDeps> = {}): ServerContainer {
  const config = deps.config ?? loadConfig();
  const redactor = deps.redactor ?? createRedactor();
  const logger = deps.logger ?? createLogger({ level: config.LOG_LEVEL, redactor, name: 'web' });
  const { prisma, repos } = buildPersistence(deps, config, redactor);
  const { redis, queues } = buildMessaging(deps, config);
  const secrets =
    deps.secrets ??
    createSecretsService({
      repository: repos.secrets,
      masterKey: new MasterKeyFile({ path: config.MASTER_KEY_PATH }),
    });
  const github =
    deps.github ??
    createGithubClient({
      secrets,
      redactor,
      logger,
      baseUrl: config.GITHUB_API_BASE_URL,
      fetch: globalThis.fetch.bind(globalThis),
    });

  let disposed = false;
  return {
    config,
    logger,
    prisma,
    repos,
    redis,
    queues,
    secrets,
    redactor,
    github,
    clock: deps.clock ?? systemClock,
    sse: deps.sse ?? { heartbeatMs: SSE_HEARTBEAT_MS, blockMs: SSE_BLOCK_MS },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      await Promise.all([
        queues.chatTurns.close(),
        queues.scheduledJobs.close(),
        queues.workspaceGc.close(),
      ]);
      redis.disconnect();
      await disconnectPrisma(prisma);
    },
  };
}

/**
 * Returns the process-wide container, creating it on first use.
 *
 * @returns The cached container.
 */
export function getServerContainer(): ServerContainer {
  const host = containerHost();
  const existing = host[CONTAINER_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const container = createServerContainer();
  host[CONTAINER_KEY] = container;
  return container;
}

/**
 * Disposes the cached container and clears the cache.
 *
 * @returns Resolves once every connection is closed.
 */
export async function disposeServerContainer(): Promise<void> {
  const host = containerHost();
  const container = host[CONTAINER_KEY];
  if (container === undefined) {
    return;
  }
  Reflect.deleteProperty(host, CONTAINER_KEY);
  await container.dispose();
}
