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
 * `reveal` to anything. The plaintext it returns travels from the processor into `Redactor.register`
 * and into the files of one `ExecSpec` — never into `WorkspaceSpec.env`, which forbids a credential
 * outright, because a container's environment is readable by every process it runs for as long as
 * it lives. It is never stored on the container, on a processor context, or in a log record.
 */
import {
  closeConnection,
  createPrismaClient,
  describeClientFailure,
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

import { createWorkspaceClaims } from './claims.js';
import type { WorkspaceClaims } from './claims.js';
import { createCommandListener } from './commands.js';
import type { CommandListener, CommandRedis } from './commands.js';
import { parseWorkerEnv } from './env.js';
import type { WorkerEnv, WorkspaceRunnerKind } from './env.js';
import { createTurnEventPublisher } from './events.js';
import type { EventStreamRedis, TurnEventPublisher } from './events.js';
import { fakeProviderScriptEnv } from './fake-provider-script.js';
import type { HeartbeatRedis } from './heartbeat.js';
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
export interface WorkerRedisClient extends EventStreamRedis, CommandRedis, HeartbeatRedis {
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
  /**
   * Extra variables every workspace container is created with, on top of its credentials.
   *
   * Empty in every run that has not selected the scripted model provider: the only thing it ever
   * carries is a supplied script, and a script is what the scripted provider answers from.
   */
  fakeProviderEnv: Readonly<Record<string, string>>;
  /** Exclusive ownership of a workspace, shared by the turn, run and collection processors. */
  claims: WorkspaceClaims;
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
  // Stryker disable next-line ObjectLiteral: what this passes through is observable only against a
  // daemon — the scope decides the label the runner writes and filters on, and constructing the
  // runner opens no connection. The `@docker` suite is where a container is created and read back
  // with its `ah.instance` label, and the end-to-end run in real mode is where the containers this
  // very call produces are found by that label.
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

/** Clients and collaborators the process built before the container existed. */
export interface BootedRuntime<
  TDatabase extends ContainerDatabase,
  TRedis extends WorkerRedisClient,
> {
  /** Database client the boot already proved reachable. */
  prisma: TDatabase;
  /** Producer connection the boot already pinged. */
  redis: TRedis;
  /** The process's redactor; the same one the boot logger writes through. */
  redactor: Redactor;
  /** The process's logger. */
  logger: Logger;
}

/**
 * Adopts clients the boot sequence already opened into a set of factories.
 *
 * The boot proves Postgres and Redis answer before anything else runs, and it can only do that by
 * connecting. Handing those clients to the container is what keeps the process on one pool and one
 * producer connection instead of two of each.
 *
 * @param base - Factories to start from; production passes {@link defaultContainerFactories}.
 * @param booted - What the boot sequence produced.
 * @returns The same factories, with the already-open clients wired in.
 */
export function factoriesFor<TDatabase extends ContainerDatabase, TRedis extends WorkerRedisClient>(
  base: ContainerFactories<TDatabase, TRedis>,
  booted: BootedRuntime<TDatabase, TRedis>,
): ContainerFactories<TDatabase, TRedis> {
  return {
    ...base,
    createPrismaClient: () => booted.prisma,
    createQueueConnection: () => booted.redis,
    createRedactor: () => booted.redactor,
    createLogger: () => booted.logger,
  };
}

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
        // Described, never repeated: a Prisma or ioredis failure puts the connection string —
        // password included — in its message, and the redactor knows the credentials this process
        // revealed, not the ones it was configured with.
        logger.warn(
          { step: step.name, failure: describeClientFailure(error) },
          'releasing a worker resource failed',
        );
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
 * @throws ConfigError When the worker-local environment is invalid, or when it names a scripted
 *   provider script that cannot be read. Both are read here so a misconfiguration stops the
 *   process at boot instead of failing every turn it accepts.
 */
export function createContainer<
  TDatabase extends ContainerDatabase,
  TRedis extends WorkerRedisClient,
>(options: CreateContainerOptions<TDatabase, TRedis>): Promise<WorkerContainer<TDatabase, TRedis>> {
  const { config, factories } = options;
  const workerEnv = parseWorkerEnv(options.env);
  const fakeProviderEnv = fakeProviderScriptEnv(
    config.AGENT_MODEL_PROVIDER,
    workerEnv.FAKE_PROVIDER_SCRIPT_PATH,
  );

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
    fakeProviderEnv,
    claims: createWorkspaceClaims(),
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
