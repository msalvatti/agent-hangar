/** @vitest-environment node */
/**
 * Unit tests for the server container.
 *
 * Layer: unit.
 * Goal: injected collaborators are used as given, the real ones are built lazily, the process-wide
 * instance is cached across module reloads, and disposal closes every connection exactly once.
 * Mocks: the `bullmq` module (the queues would otherwise open a Redis connection).
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SSE_HEARTBEAT_MS } from '@agent-hangar/core';
import type { AppConfig } from '@agent-hangar/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createServerContainer,
  disposeServerContainer,
  getServerContainer,
  githubOptions,
  poolOptions,
  secretsOptions,
  SSE_BLOCK_MS,
  withStatementTimeout,
} from './container';
import { createTestContainer, TEST_ENV } from './testing/test-container';

vi.mock('bullmq', () => import('./testing/fake-queue'));

/**
 * Runs a block with a controlled `process.env`, so the loader's default source is deterministic.
 *
 * @param env - Variables to expose.
 * @param run - Block to run.
 * @returns Whatever the block returns.
 */
async function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('AH_') || name.startsWith('CONDUCTOR_')) {
      Reflect.deleteProperty(process.env, name);
    }
  }
  Object.assign(process.env, env);
  try {
    return await run();
  } finally {
    for (const name of Object.keys(process.env)) {
      Reflect.deleteProperty(process.env, name);
    }
    Object.assign(process.env, saved);
  }
}

afterEach(async () => {
  await disposeServerContainer();
});

describe('createServerContainer', () => {
  /**
   * Injection is total: a container built entirely from doubles reaches nothing real, which is
   * what makes a route test a unit test.
   */
  it('uses every injected collaborator', () => {
    const { container } = createTestContainer();
    const rebuilt = createServerContainer(container);
    expect(rebuilt.repos).toBe(container.repos);
    expect(rebuilt.redis).toBe(container.redis);
    expect(rebuilt.queues).toBe(container.queues);
    expect(rebuilt.secrets).toBe(container.secrets);
    expect(rebuilt.github).toBe(container.github);
    expect(rebuilt.clock).toBe(container.clock);
    expect(rebuilt.sse).toBe(container.sse);
    // The logger too. A container that built its own would write a route test's diagnostics to
    // standard output instead of into the array the test reads, and every log assertion in this
    // package would pass against a logger nobody could see.
    expect(rebuilt.logger).toBe(container.logger);
  });

  /**
   * The persistence pair is injected together or not at all. Repositories built over one client
   * and a probe run against another describe two different databases: the health route would call
   * a connection nothing reads through, and a test supplying its own repositories would still open
   * a real pool.
   */
  it('builds both halves of the persistence pair when only one is injected', async () => {
    await withEnv(TEST_ENV, async () => {
      const { container } = createTestContainer();
      const { repos, prisma, ...rest } = container;

      const withoutPrisma = createServerContainer({ ...rest, repos });
      const withoutRepos = createServerContainer({ ...rest, prisma });

      expect(withoutPrisma.prisma).not.toBe(prisma);
      expect(withoutPrisma.repos).not.toBe(repos);
      expect(withoutRepos.repos).not.toBe(repos);
      // Built, not merely different: a half-injected pair used to leave the missing half
      // `undefined`, and the first route to reach for it failed on a container that looked whole.
      expect(withoutPrisma.repos.chats).toBeDefined();
      expect(withoutRepos.repos.chats).toBeDefined();
      await withoutPrisma.dispose();
      await withoutRepos.dispose();
    });
  });

  /**
   * And the messaging pair for the same reason: queues opened on one connection and commands sent
   * on another are two connections where the design has one, and the container would then own a
   * socket its own `dispose` does not close.
   */
  it('builds both halves of the messaging pair when only one is injected', async () => {
    await withEnv(TEST_ENV, async () => {
      const { container } = createTestContainer();
      const { redis, queues, ...rest } = container;

      const withoutRedis = createServerContainer({ ...rest, queues });
      const withoutQueues = createServerContainer({ ...rest, redis });

      expect(withoutRedis.redis).not.toBe(redis);
      expect(withoutRedis.queues).not.toBe(queues);
      expect(withoutQueues.queues).not.toBe(queues);
      expect(withoutRedis.queues.chatTurns).toBeDefined();
      expect(withoutQueues.queues.chatTurns).toBeDefined();
      await withoutRedis.dispose();
      await withoutQueues.dispose();
    });
  });

  /**
   * With nothing injected the container reads the environment and builds the real collaborators.
   * None of them connects: the assertion that the call returns at all is the assertion that
   * construction is free of I/O.
   */
  it('builds real collaborators without opening a connection', async () => {
    await withEnv(TEST_ENV, async () => {
      const container = createServerContainer();
      expect(container.config.AH_INSTANCE).toBe('test');
      expect(container.sse).toEqual({ heartbeatMs: SSE_HEARTBEAT_MS, blockMs: SSE_BLOCK_MS });
      expect(typeof container.clock.now()).toBe('object');
      // The client is built lazily. A container is constructed by every route module Next.js
      // loads, including at build time, and one that dialled of its own accord would open a socket
      // per module against a server that may not be running. What is read here is the option on
      // the real client rather than its status, because BullMQ dials the connection it is handed
      // as soon as a queue is built over it — the laziness belongs to the client this container
      // owns, not to everything that is later given it.
      expect(
        (container.redis as unknown as { options: { lazyConnect: boolean } }).options,
      ).toMatchObject({ lazyConnect: true });
      // And the queues are opened over that one client rather than over a second connection of
      // their own, which `dispose` would not close.
      expect(
        (container.queues.chatTurns as unknown as { opts: { connection: unknown } }).opts
          .connection,
      ).toBe(container.redis);
      // The logger names this process, so a line in a shared terminal says which of the two
      // processes wrote it.
      expect(container.logger.bindings()).toMatchObject({ name: 'web' });
      await container.dispose();
    });
  });

  /**
   * Disposal closes the queues, drops the Redis connection and disconnects Prisma, and a second
   * call is a no-op: Next.js may tear a route module down more than once.
   */
  it('disposes every connection exactly once', async () => {
    const { container, doubles } = createTestContainer();
    const rebuilt = createServerContainer(container);
    await rebuilt.dispose();
    await rebuilt.dispose();
    // Once each, not merely at least once: a second `close` reaches a queue whose connection has
    // already gone, and Next.js tears a route module down more than once.
    expect(doubles.queues.chatTurns.closes).toBe(1);
    expect(doubles.queues.scheduledJobs.closes).toBe(1);
    expect(doubles.queues.workspaceGc.closes).toBe(1);
    expect(doubles.redis.closed).toBe(true);
    expect(doubles.prisma.disconnected).toBe(true);
  });

  /**
   * A queue that refuses to close must not take the rest of the shutdown down with it: stopping
   * there would leave the Redis socket and the database pool open for the lifetime of the process.
   * Everything is released, and the failure is raised only once there is nothing left to release.
   */
  it('releases every connection even when a queue refuses to close', async () => {
    const { container, doubles } = createTestContainer();
    const rebuilt = createServerContainer(container);
    const failure = new Error('queue close failed');
    vi.spyOn(doubles.queues.chatTurns, 'close').mockRejectedValue(failure);

    await expect(rebuilt.dispose()).rejects.toBe(failure);

    expect(doubles.queues.scheduledJobs.closed).toBe(true);
    expect(doubles.queues.workspaceGc.closed).toBe(true);
    expect(doubles.redis.closed).toBe(true);
    expect(doubles.prisma.disconnected).toBe(true);
  });

  /**
   * The same holds for the two releases that follow the queues: neither a Redis client that throws
   * on disconnect nor a Prisma pool that refuses to close may stop the other from being released.
   */
  it('raises the pool failure when it is the only one', async () => {
    const { container, doubles } = createTestContainer();
    const rebuilt = createServerContainer(container);
    const failure = new Error('pool close failed');
    vi.spyOn(doubles.prisma, '$disconnect').mockRejectedValue(failure);

    // Every release is attempted and every failure is collected, including the last one. A release
    // whose failure was dropped would let `dispose` resolve over a pool that is still open, and the
    // caller would report a clean shutdown.
    await expect(rebuilt.dispose()).rejects.toBe(failure);
    expect(doubles.queues.chatTurns.closes).toBe(1);
    expect(doubles.redis.closed).toBe(true);
  });

  it('collects a failure from the redis and prisma releases', async () => {
    const { container, doubles } = createTestContainer();
    const rebuilt = createServerContainer(container);
    const failure = new Error('socket already gone');
    vi.spyOn(doubles.redis, 'disconnect').mockImplementation(() => {
      throw failure;
    });
    vi.spyOn(doubles.prisma, '$disconnect').mockRejectedValue(new Error('pool close failed'));

    await expect(rebuilt.dispose()).rejects.toBe(failure);

    expect(doubles.queues.chatTurns.closed).toBe(true);
  });
});

describe('withStatementTimeout', () => {
  /**
   * The statement timeout is what actually ends a hung query and hands its pooled connection back,
   * and Postgres reads it out of the startup packet, so it travels on the connection string.
   */
  /**
   * The pool is opened with all three settings. The timeout is what abandons a hung query and
   * gives its connection back; the size is what keeps several checkouts of this app on one machine
   * from exhausting the server's slots; and the connect timeout is what makes a request against a
   * database that is not listening fail in this process rather than wait on the operating system.
   */
  it('opens the pool with a deadline, a size and a connect timeout', () => {
    const config = { DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' } as AppConfig;

    expect(poolOptions(config)).toStrictEqual({
      connectionString: 'postgresql://u:p@127.0.0.1:5432/db?options=-c+statement_timeout%3D5000',
      max: 5,
      connectionTimeoutMillis: 2000,
    });
  });

  /**
   * The secrets service reads the envelopes the settings routes write and the key file the worker
   * decrypts with. Either of them pointing somewhere else is a service that cannot read what this
   * instance stored.
   */
  it('reads secrets from the repository store and the configured key file', async () => {
    const { container } = createTestContainer();
    const directory = await mkdtemp(join(tmpdir(), 'ah-web-container-'));
    const keyPath = join(directory, 'master.key');
    const config = { MASTER_KEY_PATH: keyPath } as AppConfig;

    const options = secretsOptions(config, container.repos);
    await options.masterKey.load();

    expect(options.repository).toBe(container.repos.secrets);
    // The key is created at the configured path and nowhere else: this is the file the worker
    // decrypts with, and a service reading a different one cannot open what this instance stored.
    await expect(stat(keyPath)).resolves.toMatchObject({ size: expect.any(Number) as number });
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * The GitHub client reaches the forge with the token this instance holds, through the base URL
   * it was configured with, and with the redactor that keeps that token out of anything logged. A
   * client built with none of them would dial github.com with no credentials from every install.
   */
  it('reaches the forge with the configured base url and this instance’s token', () => {
    const { container } = createTestContainer();
    const config = { GITHUB_API_BASE_URL: 'https://forge.example.test/api/v3' } as AppConfig;

    const options = githubOptions(config, container.redactor, container.logger, container.secrets);

    expect(options).toMatchObject({
      baseUrl: 'https://forge.example.test/api/v3',
      secrets: container.secrets,
      redactor: container.redactor,
      logger: container.logger,
    });
    expect(typeof options.fetch).toBe('function');
  });

  it('adds the statement timeout to a connection string', () => {
    const applied = withStatementTimeout('postgresql://u:p@127.0.0.1:5432/db', 5000);

    expect(new URL(applied).searchParams.get('options')).toBe('-c statement_timeout=5000');
    expect(new URL(applied).pathname).toBe('/db');
  });

  /**
   * An operator who set `options` keeps every setting they wrote, and still gets the deadline. The
   * rule this protects is that no configuration opts out of it: the timeout is the only thing that
   * abandons a hung query and returns its pooled connection, so a connection string that named a
   * search path used to leave every health poll able to strand a connection for good.
   */
  it('keeps configured options and still applies the timeout', () => {
    const configured = 'postgresql://u:p@127.0.0.1:5432/db?options=-c+search_path%3Dalt';

    const options = new URL(withStatementTimeout(configured, 5000)).searchParams.get('options');

    expect(options).toBe('-c search_path=alt -c statement_timeout=5000');
  });

  /**
   * A `statement_timeout` the operator wrote themselves is the one setting that is replaced rather
   * than kept: this process bounds its own queries, and two conflicting deadlines in one options
   * string would leave which one applies to the order Postgres happens to read them in.
   */
  it('replaces a statement timeout the connection string already named', () => {
    const configured =
      'postgresql://u:p@127.0.0.1:5432/db?options=-c+statement_timeout%3D0+-c+search_path%3Dalt';

    const options = new URL(withStatementTimeout(configured, 5000)).searchParams.get('options');

    expect(options).toBe('-c search_path=alt -c statement_timeout=5000');
  });

  /**
   * The replaced setting leaves a separator behind it. Removed outright, the options either side
   * of it run together — `-c search_path=alt-c work_mem=64MB` is one unreadable setting where
   * there were two, and Postgres refuses the connection rather than starting without a deadline.
   */
  it('does not run two settings together when it removes the one between them', () => {
    const configured =
      'postgresql://u:p@127.0.0.1:5432/db' +
      '?options=-c+search_path%3Dalt+-c+statement_timeout%3D0+-c+work_mem%3D64MB';

    const options = new URL(withStatementTimeout(configured, 5000)).searchParams.get('options');

    expect(options).toBe('-c search_path=alt -c work_mem=64MB -c statement_timeout=5000');
  });

  /**
   * The pattern reads what an operator actually wrote. Postgres accepts any run of spaces between
   * `-c` and the setting, and a value of any length — so a pattern that insisted on one space, or
   * that took a single character of the value, would leave the old deadline in the string beside
   * the new one and let Postgres pick whichever it read last.
   */
  it.each([
    [
      'extra spacing between the flag and the setting',
      '-c  statement_timeout%3D0+-c+work_mem%3D8MB',
    ],
    ['a multi-digit deadline', '-c+statement_timeout%3D120000+-c+work_mem%3D8MB'],
  ])('replaces a timeout written with %s', (_case, written) => {
    const configured = `postgresql://u:p@127.0.0.1:5432/db?options=${written}`;

    const options = new URL(withStatementTimeout(configured, 5000)).searchParams.get('options');

    expect(options).toBe('-c work_mem=8MB -c statement_timeout=5000');
  });
});

describe('getServerContainer', () => {
  /**
   * The instance is cached on `globalThis`, so the Next.js dev server reusing a module does not
   * leak a Prisma pool and a Redis connection per edit.
   */
  it('caches under the key that survives a module reload', async () => {
    await withEnv(TEST_ENV, () => {
      const container = getServerContainer();

      // The key is written out: it is a `Symbol.for`, so what makes two module instances share one
      // container is that both compute the same string. Changed on one side of a reload, the dev
      // server would hold a Prisma pool and a Redis connection per edit.
      expect(
        (globalThis as Record<symbol, unknown>)[Symbol.for('agent-hangar.server-container')],
      ).toBe(container);
      return Promise.resolve();
    });
  });

  it('returns one container per process', async () => {
    await withEnv(TEST_ENV, async () => {
      expect(getServerContainer()).toBe(getServerContainer());
      await disposeServerContainer();
    });
  });

  /**
   * Disposing clears the cache, so the next caller gets a fresh container rather than one whose
   * connections are already closed.
   */
  it('builds a new container after disposal', async () => {
    await withEnv(TEST_ENV, async () => {
      const first = getServerContainer();
      await disposeServerContainer();
      expect(getServerContainer()).not.toBe(first);
      await disposeServerContainer();
    });
  });

  /**
   * Disposing when nothing was ever built is harmless, which matters because shutdown hooks run
   * whether or not a request was served.
   */
  it('tolerates disposal with no cached container', async () => {
    await expect(disposeServerContainer()).resolves.toBeUndefined();
  });
});
