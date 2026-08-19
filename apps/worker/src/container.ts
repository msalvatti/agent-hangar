/**
 * The worker's dependency container: one place where every collaborator is built and closed.
 *
 * Layer: service (composition).
 *
 * Every construction goes through an injectable factory, so the wiring — how many Redis
 * connections are opened, which options each carries, in which order they are released — is
 * asserted by unit tests instead of being discovered in production. The defaults are direct
 * references to the real factories in `@agent-hangar/core`, so nothing is re-implemented here.
 *
 * Security: this is the only module in the repository that hands a `SecretsService` with a working
 * `reveal` to anything. The plaintext it returns travels from the processor straight into
 * `WorkspaceRunner.create({ env })` and `Redactor.register`; it is never stored on the container,
 * on a processor context, or in a log record.
 */
import {
  closeConnection,
  createPrismaClient,
  createQueueConnection,
  createQueues,
  createRedactor,
  createRepositories,
  createSecretsService,
  createWorkerConnection,
  disconnectPrisma,
  MasterKeyFile,
  systemClock,
} from '@agent-hangar/core';
import type {
  AppConfig,
  Clock,
  Redactor,
  Repositories,
  SecretRepository,
  SecretsService,
  WorkspaceRunner,
} from '@agent-hangar/core';
import { createDockerWorkspaceRunner } from '@agent-hangar/core/runner/docker';
import { FakeWorkspaceRunner } from '@agent-hangar/core/testing';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { createCommandListener } from './commands.js';
import type { CommandListener, CommandRedis } from './commands.js';
import { parseWorkerEnv } from './env.js';
import type { WorkerEnv, WorkspaceRunnerKind } from './env.js';
import { createTurnEventPublisher } from './events.js';
import type { EventStreamRedis, TurnEventPublisher } from './events.js';
import { createLogger } from './logger.js';
import type { WorkerQueues } from './queues.js';

/** The Prisma client type, named without re-exporting Prisma's generated module. */
export type WorkerPrismaClient = ReturnType<typeof createPrismaClient>;

/** The database surface the container owns; the real Prisma client satisfies it. */
export interface ContainerDatabase {
  /** Releases the connection pool. */
  $disconnect(): Promise<void>;
}

/** The Redis surface the container owns; ioredis' `Redis` satisfies it. */
export interface WorkerRedisClient extends EventStreamRedis, CommandRedis {
  /** Opens a second connection with the same options, as pub/sub requires. */
  duplicate(): WorkerRedisClient;
  /** Closes the connection. */
  quit(): Promise<unknown>;
}

/** The three connections the worker keeps open, each for a role that forbids sharing. */
export interface WorkerRedisConnections<TRedis extends WorkerRedisClient> {
  /** Producer connection: queues and the turn event streams. */
  queue: TRedis;
  /** Consumer connection: `maxRetriesPerRequest: null`, as BullMQ workers require. */
  worker: TRedis;
  /** Subscriber connection: once subscribed, ioredis accepts no other command on it. */
  subscriber: WorkerRedisClient;
}

/** Everything a running worker holds. */
export interface WorkerContainer<
  TDatabase extends ContainerDatabase = WorkerPrismaClient,
  TRedis extends WorkerRedisClient = Redis,
> {
  config: AppConfig;
  workerEnv: WorkerEnv;
  logger: Logger;
  clock: Clock;
  prisma: TDatabase;
  repos: Repositories;
  redis: WorkerRedisConnections<TRedis>;
  /** Worker-only: `reveal` is legal here and nowhere else in the application. */
  secrets: SecretsService;
  redactor: Redactor;
  runner: WorkspaceRunner;
  publisher: TurnEventPublisher;
  commands: CommandListener;
  queues: WorkerQueues;
  /** Closes queues, the three connections and the database pool; idempotent. */
  close(): Promise<void>;
}

/** How the container builds each collaborator; tests replace these with in-memory equivalents. */
export interface ContainerFactories<
  TDatabase extends ContainerDatabase,
  TRedis extends WorkerRedisClient,
> {
  createPrismaClient(options: { connectionString: string }): TDatabase;
  disconnectPrisma(client: TDatabase): Promise<void>;
  createRepositories(prisma: TDatabase, redactor: Redactor): Repositories;
  createQueueConnection(url: string): TRedis;
  createWorkerConnection(url: string): TRedis;
  closeConnection(connection: TRedis): Promise<void>;
  createQueues(options: { connection: TRedis }): WorkerQueues;
  createRedactor(): Redactor;
  createLogger(options: { level: string; redactor: Redactor }): Logger;
  createSecrets(repository: SecretRepository, masterKeyPath: string): SecretsService;
  createWorkspaceRunner(
    kind: WorkspaceRunnerKind,
    config: AppConfig,
    clock: Clock,
  ): WorkspaceRunner;
  clock: Clock;
}

/**
 * Builds the secrets service over the file-backed master key.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @param masterKeyPath - `MASTER_KEY_PATH`; the file is created 0600 on first use.
 * @returns A service whose `reveal` decrypts for injection into a workspace.
 */
export function createSecrets(repository: SecretRepository, masterKeyPath: string): SecretsService {
  return createSecretsService({
    repository,
    masterKey: new MasterKeyFile({ path: masterKeyPath }),
  });
}

/**
 * Builds the runner the worker drives.
 *
 * The fake runner is reachable in production code on purpose: `WORKSPACE_RUNNER=fake` is how the
 * UI and the end-to-end harness exercise the whole pipeline on a machine without Docker. It runs
 * nothing, which is why `docker` is the default and why choosing it is an explicit act.
 *
 * @param kind - Which implementation to build.
 * @param config - Instance name and container name prefix for label scoping.
 * @param clock - Time source for snapshot timestamps and uptime.
 * @returns The runner.
 */
export function createWorkspaceRunner(
  kind: WorkspaceRunnerKind,
  config: AppConfig,
  clock: Clock,
): WorkspaceRunner {
  if (kind === 'fake') {
    return new FakeWorkspaceRunner({ clock });
  }
  return createDockerWorkspaceRunner({
    instance: config.AH_INSTANCE,
    namePrefix: config.WORKSPACE_NAME_PREFIX,
    clock,
  });
}

/** The real wiring: every entry is the production factory, referenced rather than wrapped. */
export const defaultContainerFactories: ContainerFactories<WorkerPrismaClient, Redis> = {
  createPrismaClient,
  disconnectPrisma,
  createRepositories,
  createQueueConnection,
  createWorkerConnection,
  closeConnection,
  createQueues,
  createRedactor,
  createLogger,
  createSecrets,
  createWorkspaceRunner,
  clock: systemClock,
};

/** Inputs of {@link createContainer}. */
export interface CreateContainerOptions<
  TDatabase extends ContainerDatabase,
  TRedis extends WorkerRedisClient,
> {
  /** Validated application configuration. */
  config: AppConfig;
  /** Environment the worker-local variables are read from; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Construction seams; production passes {@link defaultContainerFactories}. */
  factories: ContainerFactories<TDatabase, TRedis>;
}

/**
 * Lists the close operations of every queue.
 *
 * @param queues - The application queues.
 * @returns One pending close per queue.
 */
function closeQueues(queues: WorkerQueues): Promise<unknown> {
  return Promise.all([
    queues.chatTurns.close(),
    queues.scheduledJobs.close(),
    queues.workspaceGc.close(),
  ]);
}

/**
 * Builds an idempotent `close` over the collaborators, in the order that keeps them consistent.
 *
 * Queues stop first so no command is issued on a connection that is closing; the subscriber and
 * the consumer connection follow, then the producer, then the database pool. Every release runs
 * even when an earlier one fails: a rejected `quit` must not leave the Postgres pool open for the
 * rest of the process's life.
 *
 * @param steps - Named release functions, in the order they must run.
 * @param logger - Logger for the release that failed.
 * @returns A function that releases everything at most once; a concurrent call joins the first.
 */
function createClose(
  steps: readonly { name: string; run: () => Promise<unknown> }[],
  logger: Logger,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        logger.warn({ step: step.name, err: error }, 'releasing a worker resource failed');
      }
    }
  };
  return (): Promise<void> => (inFlight ??= run());
}

/**
 * Builds the worker container.
 *
 * Resolves rather than returns: no collaborator needs to be awaited today, but the container is
 * the process's only construction point, and a factory that must connect before it can be used —
 * a runner probing the Docker socket, say — has to be able to arrive without changing every call
 * site.
 *
 * @param options - Configuration, environment and construction seams.
 * @returns The container, with every connection open.
 * @throws ConfigError When the worker-local environment is invalid.
 */
export function createContainer<
  TDatabase extends ContainerDatabase,
  TRedis extends WorkerRedisClient,
>(options: CreateContainerOptions<TDatabase, TRedis>): Promise<WorkerContainer<TDatabase, TRedis>> {
  const { config, factories } = options;
  const workerEnv = parseWorkerEnv(options.env);

  const redactor = factories.createRedactor();
  const logger = factories.createLogger({ level: config.LOG_LEVEL, redactor });
  const prisma = factories.createPrismaClient({ connectionString: config.DATABASE_URL });
  const repos = factories.createRepositories(prisma, redactor);

  const queueConnection = factories.createQueueConnection(config.REDIS_URL);
  const workerConnection = factories.createWorkerConnection(config.REDIS_URL);
  const subscriber = queueConnection.duplicate();
  const queues = factories.createQueues({ connection: queueConnection });

  const container: WorkerContainer<TDatabase, TRedis> = {
    config,
    workerEnv,
    logger,
    clock: factories.clock,
    prisma,
    repos,
    redis: { queue: queueConnection, worker: workerConnection, subscriber },
    secrets: factories.createSecrets(repos.secrets, config.MASTER_KEY_PATH),
    redactor,
    runner: factories.createWorkspaceRunner(workerEnv.WORKSPACE_RUNNER, config, factories.clock),
    publisher: createTurnEventPublisher(queueConnection),
    commands: createCommandListener(subscriber, logger),
    queues,
    close: createClose(
      [
        { name: 'queues', run: () => closeQueues(queues) },
        { name: 'redis.subscriber', run: () => subscriber.quit() },
        { name: 'redis.worker', run: () => factories.closeConnection(workerConnection) },
        { name: 'redis.queue', run: () => factories.closeConnection(queueConnection) },
        { name: 'prisma', run: () => factories.disconnectPrisma(prisma) },
      ],
      logger,
    ),
  };
  return Promise.resolve(container);
}
