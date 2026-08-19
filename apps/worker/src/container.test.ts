/**
 * Unit tests for the worker container.
 *
 * Layer: unit.
 * Goal: three Redis connections opened for their three roles, the subscriber duplicated from the
 * producer, the runner chosen by the worker-local environment, and a close that releases
 * everything once, in order, even when a release fails.
 * Mocks: injected factories over in-memory doubles; no Redis, Postgres or Docker.
 */
import { createRedactor, loadConfig } from '@agent-hangar/core';
import type { AppConfig, Clock, Redactor, Repositories, SecretsService } from '@agent-hangar/core';
import {
  createInMemoryRepositories,
  FakeClock,
  FakeWorkspaceRunner,
} from '@agent-hangar/core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
  createContainer,
  createSecrets,
  createWorkspaceRunner,
  defaultContainerFactories,
} from './container.js';
import type { ContainerDatabase, ContainerFactories, WorkerRedisClient } from './container.js';
import type { EventStreamTransaction } from './events.js';
import { createLogger } from './logger.js';
import { createFakeQueues, FakeSecretsService, TEST_ENV } from './testing/index.js';

/** A Redis stand-in that records its role and whether it was closed. */
class FakeRedis implements WorkerRedisClient {
  quitCalls = 0;
  readonly duplicates: FakeRedis[] = [];

  constructor(
    readonly role: string,
    private readonly onQuit: (role: string) => void,
    private readonly quitFails = false,
  ) {}

  multi(): EventStreamTransaction {
    throw new Error('not used in this test');
  }

  on(_event: 'message', _listener: (channel: string, payload: string) => void): unknown {
    return this;
  }

  subscribe(_channel: string): Promise<unknown> {
    return Promise.resolve(1);
  }

  unsubscribe(_channel: string): Promise<unknown> {
    return Promise.resolve(0);
  }

  duplicate(): WorkerRedisClient {
    const copy = new FakeRedis(`${this.role}:duplicate`, this.onQuit);
    this.duplicates.push(copy);
    return copy;
  }

  quit(): Promise<unknown> {
    this.quitCalls += 1;
    this.onQuit(this.role);
    if (this.quitFails) {
      return Promise.reject(new Error('connection already gone'));
    }
    return Promise.resolve('OK');
  }
}

/** A Prisma stand-in that only has to be disconnectable. */
class FakeDatabase implements ContainerDatabase {
  disconnectCalls = 0;

  $disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    return Promise.resolve();
  }
}

/** What a test needs to assert on after building a container. */
interface Harness {
  config: AppConfig;
  factories: ContainerFactories<FakeDatabase, FakeRedis>;
  released: string[];
  connections: FakeRedis[];
  database: FakeDatabase;
  logs: string[];
  runnerCalls: { kind: string }[];
  queues: ReturnType<typeof createFakeQueues>;
}

/**
 * Builds injectable factories over in-memory doubles.
 *
 * @param options - Whether the producer connection fails to close.
 * @returns The factories plus the handles a test asserts on.
 */
function harness(options: { queueQuitFails?: boolean } = {}): Harness {
  const config = loadConfig(TEST_ENV);
  const released: string[] = [];
  const connections: FakeRedis[] = [];
  const database = new FakeDatabase();
  const logs: string[] = [];
  const runnerCalls: { kind: string }[] = [];
  const clock: Clock = new FakeClock();
  const queues = createFakeQueues();

  const makeRedis = (role: string, quitFails = false): FakeRedis => {
    const redis = new FakeRedis(
      role,
      (name) => {
        released.push(name);
      },
      quitFails,
    );
    connections.push(redis);
    return redis;
  };

  const factories: ContainerFactories<FakeDatabase, FakeRedis> = {
    createPrismaClient: () => database,
    disconnectPrisma: (client) => {
      released.push('prisma');
      return client.$disconnect();
    },
    createRepositories: (_prisma, _redactor): Repositories => createInMemoryRepositories(clock),
    createQueueConnection: () => makeRedis('queue', options.queueQuitFails ?? false),
    createWorkerConnection: () => makeRedis('worker'),
    closeConnection: async (connection) => {
      await connection.quit();
    },
    createQueues: () => queues,
    createRedactor: (): Redactor => createRedactor(),
    createLogger: ({ level, redactor }) =>
      createLogger({
        level,
        redactor,
        destination: {
          write(line: string): void {
            logs.push(line);
          },
        },
      }),
    createSecrets: (): SecretsService => new FakeSecretsService(),
    createWorkspaceRunner: (kind) => {
      runnerCalls.push({ kind });
      return new FakeWorkspaceRunner();
    },
    clock,
  };
  return { config, factories, released, connections, database, logs, runnerCalls, queues };
}

describe('createContainer', () => {
  /**
   * Three connections are opened for three roles that cannot share one: a producer, a consumer
   * with the blocking-read options, and a subscriber duplicated from the producer because ioredis
   * refuses every other command once a connection is subscribed.
   */
  it('opens a producer, a consumer and a duplicated subscriber', async () => {
    const { config, factories, connections } = harness();

    const container = await createContainer({ config, env: {}, factories });

    expect(container.redis.queue.role).toBe('queue');
    expect(container.redis.worker.role).toBe('worker');
    expect(container.redis.subscriber).toBe(connections[0]?.duplicates[0]);
  });

  /**
   * `createWorkerConnection` is what carries `maxRetriesPerRequest: null`; the container must ask
   * for it rather than opening a second producer connection.
   */
  it('opens the consumer connection through the worker factory', async () => {
    const { config, factories } = harness();
    const spy = vi.spyOn(factories, 'createWorkerConnection');

    await createContainer({ config, env: {}, factories });

    expect(spy).toHaveBeenCalledExactlyOnceWith(config.REDIS_URL);
  });

  /**
   * The worker-local environment picks the runner, and nothing else does.
   */
  it('builds the runner named by the worker environment', async () => {
    const { config, factories, runnerCalls } = harness();

    await createContainer({ config, env: { WORKSPACE_RUNNER: 'fake' }, factories });
    await createContainer({ config, env: {}, factories });

    expect(runnerCalls).toEqual([{ kind: 'fake' }, { kind: 'docker' }]);
  });

  /**
   * The container exposes the configuration and the parsed worker environment so processors and
   * the application wiring read one source.
   */
  it('exposes the configuration and the parsed worker environment', async () => {
    const { config, factories } = harness();

    const container = await createContainer({
      config,
      env: { WORKSPACE_RUNNER: 'fake' },
      factories,
    });

    expect(container.config.AH_INSTANCE).toBe('w2b-unit');
    expect(container.workerEnv.WORKSPACE_RUNNER).toBe('fake');
    expect(container.clock).toBe(factories.clock);
  });

  /**
   * Closing releases queues first, then the subscriber, the consumer, the producer and finally
   * the database pool: a command must never be issued on a connection that is already closing.
   */
  it('releases everything in order', async () => {
    const { config, factories, released, database, queues } = harness();
    const container = await createContainer({ config, env: {}, factories });

    await container.close();

    expect(queues.chatTurns.closed).toBe(true);
    expect(released).toEqual(['queue:duplicate', 'worker', 'queue', 'prisma']);
    expect(database.disconnectCalls).toBe(1);
  });

  /**
   * A second close joins the first instead of releasing twice: SIGINT and SIGTERM are separate
   * handlers and both may fire.
   */
  it('is idempotent', async () => {
    const { config, factories, database } = harness();
    const container = await createContainer({ config, env: {}, factories });

    await Promise.all([container.close(), container.close()]);
    await container.close();

    expect(database.disconnectCalls).toBe(1);
  });

  /**
   * A rejected release must not skip the ones after it: letting a failed `quit` abandon the
   * Postgres pool would keep it open for the rest of the process's life.
   */
  it('keeps releasing after a failure and reports which step failed', async () => {
    const { config, factories, database, logs } = harness({ queueQuitFails: true });
    const container = await createContainer({ config, env: {}, factories });

    await container.close();

    expect(database.disconnectCalls).toBe(1);
    expect(logs.join('')).toContain('releasing a worker resource failed');
  });
});

describe('createWorkspaceRunner', () => {
  /**
   * `fake` builds the in-memory runner, which is what `WORKSPACE_RUNNER=fake` exists for.
   */
  it('builds the fake runner on request', () => {
    const config = loadConfig(TEST_ENV);

    expect(createWorkspaceRunner('fake', config, new FakeClock()).kind).toBe('fake');
  });

  /**
   * `docker` builds the real runner, scoped to this instance's labels. Constructing it opens no
   * connection, so this stays a unit test.
   */
  it('builds the docker runner scoped to the instance', () => {
    const config = loadConfig(TEST_ENV);

    expect(createWorkspaceRunner('docker', config, new FakeClock()).kind).toBe('docker');
  });
});

describe('createSecrets', () => {
  /**
   * The service is built over the file-backed master key; nothing is read until a call needs the
   * key, so construction alone must not touch the filesystem.
   */
  it('builds a secrets service over the configured key path', async () => {
    const repos = createInMemoryRepositories(new FakeClock());

    const secrets = createSecrets(repos.secrets, '/nonexistent/master.key');

    await expect(secrets.status()).resolves.toEqual({
      GITHUB_PAT: { set: false },
      OPENAI_API_KEY: { set: false },
    });
  });
});

describe('defaultContainerFactories', () => {
  /**
   * The production wiring references the real factories rather than wrapping them, so this asserts
   * the whole set is present — a missing entry would only surface at boot.
   */
  it('provides every construction seam', () => {
    expect(Object.keys(defaultContainerFactories).toSorted()).toEqual([
      'clock',
      'closeConnection',
      'createLogger',
      'createPrismaClient',
      'createQueueConnection',
      'createQueues',
      'createRedactor',
      'createRepositories',
      'createSecrets',
      'createWorkerConnection',
      'createWorkspaceRunner',
      'disconnectPrisma',
    ]);
  });
});
