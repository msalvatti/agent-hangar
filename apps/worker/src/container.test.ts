/**
 * Unit tests for the worker container.
 *
 * Layer: unit.
 * Goal: three Redis connections opened for their three roles, the subscriber duplicated from the
 * producer, the runner chosen by the worker-local environment, a supplied scripted-provider
 * script resolved once at boot for the scripted provider alone, and a close that releases
 * everything once, in order, even when a release fails.
 * Mocks: injected factories over in-memory doubles; no Redis, Postgres or Docker.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, createRedactor, loadConfig } from '@agent-hangar/core';
import type { AppConfig, Clock, Redactor, Repositories, SecretsService } from '@agent-hangar/core';
import {
  createInMemoryRepositories,
  FakeClock,
  FakeWorkspaceRunner,
} from '@agent-hangar/core/testing';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createContainer,
  createSecrets,
  createWorkspaceRunner,
  defaultContainerFactories,
  factoriesFor,
} from './container.js';
import type { ContainerFactories } from './container.js';
import { FAKE_SCRIPT_ENV_KEY } from './fake-provider-script.js';
import { createLogger } from './logger.js';
import {
  createFakeQueues,
  FakeDatabaseClient,
  FakeRedisClient,
  FakeSecretsService,
  TEST_ENV,
} from './testing/index.js';

/** Everything the injectable factories are built over. */
interface FactoryParts {
  database: FakeDatabaseClient;
  makeRedis: (role: string, quitFails?: boolean) => FakeRedisClient;
  queues: ReturnType<typeof createFakeQueues>;
  clock: Clock;
  capture: (options: { level: string; redactor: Redactor }) => Logger;
  queueQuitFails: boolean;
  released: string[];
  runnerCalls: { kind: string }[];
}

/**
 * Builds the injectable factories over in-memory doubles.
 *
 * @param parts - The doubles and the recorders they write into.
 * @returns One factory per construction seam.
 */
function buildFactories(
  parts: FactoryParts,
): ContainerFactories<FakeDatabaseClient, FakeRedisClient> {
  return {
    createPrismaClient: () => parts.database,
    disconnectPrisma: (client) => {
      parts.released.push('prisma');
      return client.$disconnect();
    },
    createRepositories: (_prisma, _redactor): Repositories =>
      createInMemoryRepositories(parts.clock),
    createQueueConnection: () => parts.makeRedis('queue', parts.queueQuitFails),
    createWorkerConnection: () => parts.makeRedis('worker'),
    closeConnection: async (connection) => {
      await connection.quit();
    },
    createQueues: () => parts.queues,
    createRedactor: (): Redactor => createRedactor(),
    createLogger: parts.capture,
    createSecrets: (): SecretsService => new FakeSecretsService(),
    createWorkspaceRunner: (kind) => {
      parts.runnerCalls.push({ kind });
      return new FakeWorkspaceRunner();
    },
    clock: parts.clock,
  };
}

/** What a test needs to assert on after building a container. */
interface Harness {
  config: AppConfig;
  factories: ContainerFactories<FakeDatabaseClient, FakeRedisClient>;
  released: string[];
  connections: FakeRedisClient[];
  database: FakeDatabaseClient;
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
  const connections: FakeRedisClient[] = [];
  const database = new FakeDatabaseClient();
  const logs: string[] = [];
  const runnerCalls: { kind: string }[] = [];
  const clock: Clock = new FakeClock();
  const queues = createFakeQueues();

  const makeRedis = (role: string, quitFails = false): FakeRedisClient => {
    const redis = new FakeRedisClient({
      role,
      quitFails,
      onQuit: (name) => {
        released.push(name);
      },
    });
    connections.push(redis);
    return redis;
  };
  const capture = ({ level, redactor }: { level: string; redactor: Redactor }): Logger =>
    createLogger({
      level,
      redactor,
      destination: {
        write(line: string): void {
          logs.push(line);
        },
      },
    });

  const factories = buildFactories({
    database,
    makeRedis,
    queues,
    clock,
    capture,
    queueQuitFails: options.queueQuitFails ?? false,
    released,
    runnerCalls,
  });

  return { config, factories, released, connections, database, logs, runnerCalls, queues };
}

/** A supplied script, in the shape a caller writes on disk. */
const SUPPLIED_SCRIPT = {
  default: [
    {
      events: [
        { type: 'text.done', text: 'Answered from the supplied script.' },
        { type: 'response.done', responseId: 'fake-1', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    },
  ],
};

/** Directory the supplied script is written into, and the file inside it. */
let scriptDirectory: string;
let scriptPath: string;

beforeAll(() => {
  scriptDirectory = mkdtempSync(join(tmpdir(), 'ah-container-script-'));
  scriptPath = join(scriptDirectory, 'script.json');
  writeFileSync(scriptPath, JSON.stringify(SUPPLIED_SCRIPT), 'utf8');
});

afterAll(() => {
  rmSync(scriptDirectory, { recursive: true, force: true });
});

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
   * A supplied script is read once, where the process reads its environment, and carried on the
   * container for every workspace create to compose in. Reading it per create would repeat work
   * that cannot change and would turn one unreadable file into a failure of every turn.
   */
  it('resolves a supplied scripted-provider script at boot', async () => {
    const { config, factories } = harness();

    const container = await createContainer({
      config,
      env: { FAKE_PROVIDER_SCRIPT_PATH: scriptPath },
      factories,
    });

    expect(JSON.parse(container.fakeProviderEnv[FAKE_SCRIPT_ENV_KEY] ?? '')).toEqual(
      SUPPLIED_SCRIPT,
    );
  });

  /**
   * The scripted provider is the only way in. A deployment running the real provider composes
   * nothing extra into a container even when the variable names a readable script, so the
   * variable cannot become a way of making a real agent say and do arbitrary things.
   */
  it('resolves nothing for a provider that is not the scripted one', async () => {
    const { config, factories } = harness();

    const container = await createContainer({
      config: { ...config, AGENT_MODEL_PROVIDER: 'openai' },
      env: { FAKE_PROVIDER_SCRIPT_PATH: scriptPath },
      factories,
    });

    expect(container.fakeProviderEnv).toEqual({});
  });

  /**
   * Nothing is added when no script was named, which is every ordinary run.
   */
  it('resolves nothing when no script was named', async () => {
    const { config, factories } = harness();

    const container = await createContainer({ config, env: {}, factories });

    expect(container.fakeProviderEnv).toEqual({});
  });

  /**
   * A script that cannot be read stops the process where the operator is still watching, instead
   * of letting the worker start and fail every turn it accepts.
   */
  it('refuses to build when a named script cannot be read', () => {
    const { config, factories } = harness();
    const env = { FAKE_PROVIDER_SCRIPT_PATH: join(scriptDirectory, 'absent.json') };

    expect(() => createContainer({ config, env, factories })).toThrow(ConfigError);
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
    expect(database.disconnects).toBe(1);
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

    expect(database.disconnects).toBe(1);
  });

  /**
   * A rejected release must not skip the ones after it: letting a failed `quit` abandon the
   * Postgres pool would keep it open for the rest of the process's life.
   */
  it('keeps releasing after a failure and reports which step failed', async () => {
    const { config, factories, database, logs } = harness({ queueQuitFails: true });
    const container = await createContainer({ config, env: {}, factories });

    await container.close();

    expect(database.disconnects).toBe(1);
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

describe('factoriesFor', () => {
  /**
   * The boot sequence proves Postgres and Redis answer by connecting to them; the container must
   * adopt those clients rather than opening a second pool and a second producer connection.
   */
  it('adopts the clients and collaborators the boot already built', async () => {
    const { config, factories } = harness();
    const prisma = new FakeDatabaseClient();
    const redis = new FakeRedisClient({ role: 'boot' });
    const redactor = createRedactor();
    const logger = createLogger({ level: 'silent', redactor });

    const container = await createContainer({
      config,
      env: {},
      factories: factoriesFor(factories, { prisma, redis, redactor, logger }),
    });

    expect(container.prisma).toBe(prisma);
    expect(container.redis.queue).toBe(redis);
    expect(container.redactor).toBe(redactor);
    expect(container.logger).toBe(logger);
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
