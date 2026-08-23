/**
 * Unit tests for the worker boot sequence.
 *
 * Layer: unit.
 * Goal: success path wires config → Postgres check → Redis ping and returns a shutdown that
 * closes Redis then Postgres exactly once; every failure (config, DB down, Redis down, bad PING
 * reply) surfaces as a `ConfigError` and releases what was already opened.
 * Mocks: injected fakes for every collaborator; no I/O.
 */
import { inspect } from 'node:util';

import { ConfigError, loadConfig } from '@agent-hangar/core';
import type { AppConfig } from '@agent-hangar/core';
import pino from 'pino';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { boot, describeUrl, REDACTED_URL } from './boot.js';
import type { BootDeps } from './boot.js';

const config: AppConfig = loadConfig({ AH_INSTANCE: 'test', AH_PORT_BASE: '4100' });

/** Collects the boot breadcrumbs, so the lines an operator reads are assertable. */
const written: string[] = [];

function fakeLogger(): Logger {
  return pino(
    { level: 'debug' },
    {
      write(line: string): void {
        written.push(line);
      },
    },
  );
}

/** What the logger was given, in order, as parsed records. */
function records(): Record<string, unknown>[] {
  return written.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  written.length = 0;
});

function makeDeps(overrides: Partial<BootDeps> = {}) {
  const order: string[] = [];
  const prisma = {
    $disconnect: vi.fn(async () => {
      order.push('prisma.disconnect');
      await Promise.resolve();
    }),
  };
  const redis = {
    ping: vi.fn(async () => {
      await Promise.resolve();
      return 'PONG';
    }),
    quit: vi.fn(async () => {
      order.push('redis.quit');
      await Promise.resolve();
      return 'OK';
    }),
  };
  const deps: BootDeps = {
    loadConfig: vi.fn(() => config),
    createPrismaClient: vi.fn(() => prisma),
    assertDatabaseReachable: vi.fn(async () => {
      await Promise.resolve();
    }),
    createRedis: vi.fn(() => redis),
    logger: fakeLogger(),
    ...overrides,
  };
  return { deps, prisma, redis, order };
}

describe('describeUrl', () => {
  /** The target stays useful: scheme, host and path all survive. */
  it('keeps the scheme, host and path of a URL that has an authority', () => {
    expect(describeUrl('redis://user:secret@cache:6379/0')).toBe('redis://cache:6379/0');
    expect(describeUrl('redis://127.0.0.1:6379')).toBe('redis://127.0.0.1:6379');
  });

  /**
   * A credential hides in more than the userinfo, and every spelling below is one the environment
   * schema accepts, because it only asks `URL` to parse the value. The query matters most: ioredis
   * reads query parameters as connection options, so `?password=` is a supported way to configure
   * the password rather than a malformed URL. None of them may reach the boot error.
   */
  it.each([
    ['userinfo', 'redis://ah:SUPERSECRETPW@cache:6379/0', 'redis://cache:6379/0'],
    ['a query password', 'redis://cache:6379?password=SUPERSECRETPW&db=2', 'redis://cache:6379'],
    ['a fragment', 'redis://cache:6379#SUPERSECRETPW', 'redis://cache:6379'],
  ])('drops %s while naming the target', (_name, url, expected) => {
    const described = describeUrl(url);
    expect(described).toBe(expected);
    expect(described).not.toContain('SUPERSECRETPW');
  });

  /**
   * With no authority there is nothing safe left to name: an authority-less URL parses with an
   * empty host and the whole `user:password@host` sitting in its path, so echoing the input would
   * put the password straight into the boot error. So would echoing an unparseable value.
   */
  it.each([
    ['an authority-less URL', 'redis:/ah:SUPERSECRETPW@cache:6379'],
    ['a scheme-only URL', 'redis:ah:SUPERSECRETPW@cache'],
    ['a non-URL', 'not a url SUPERSECRETPW'],
  ])('refuses to echo %s', (_name, url) => {
    const described = describeUrl(url);
    // The stand-in is written out rather than compared with the export it came from: emptied, the
    // constant would let this assert that a URL is described as nothing at all.
    expect(described).toBe('(redacted url)');
    expect(REDACTED_URL).toBe('(redacted url)');
    expect(described).not.toContain('SUPERSECRETPW');
  });
});

describe('boot', () => {
  /**
   * Success path: the connection strings from config reach the factories, both checks run, and
   * the result exposes config and clients.
   */
  it('boots with validated config, a reachable database and Redis', async () => {
    const { deps, prisma, redis } = makeDeps();
    const result = await boot(deps);
    expect(result.config).toBe(config);
    expect(result.prisma).toBe(prisma);
    expect(result.redis).toBe(redis);
    expect(deps.createPrismaClient).toHaveBeenCalledWith({ connectionString: config.DATABASE_URL });
    expect(deps.assertDatabaseReachable).toHaveBeenCalledWith(prisma);
    expect(deps.createRedis).toHaveBeenCalledWith(config.REDIS_URL);
    expect(redis.ping).toHaveBeenCalledTimes(1);
  });

  /**
   * Boot leaves a trail, and the trail is the only thing an operator has when a worker comes up
   * against the wrong instance or stops between the two reachability checks. Each line has to say
   * which stage was reached — a breadcrumb with no words is a blank line in the terminal — and the
   * first has to name the instance, because two checkouts write into the same terminal history and
   * "booting worker" belonging to either of them tells nobody which one came up.
   */
  it('leaves a named trail through both reachability checks', async () => {
    const { deps } = makeDeps();

    await boot(deps);

    expect(records()).toStrictEqual([
      expect.objectContaining({ msg: 'booting worker', instance: 'test' }),
      expect.objectContaining({ msg: 'postgres reachable' }),
      expect.objectContaining({ msg: 'redis reachable' }),
    ]);
  });

  /**
   * Shutdown ordering: Redis is closed before Postgres (no query can be issued by a late job
   * after the database is gone), and a second call is a no-op.
   */
  it('shuts down Redis then Postgres exactly once', async () => {
    const { deps, prisma, redis, order } = makeDeps();
    const { shutdown } = await boot(deps);
    await shutdown();
    await shutdown();
    expect(order).toEqual(['redis.quit', 'prisma.disconnect']);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    // Both ends of the shutdown are announced. A worker that logged only its intention leaves an
    // operator unable to tell a clean stop from one that hung with the pools still open.
    expect(records().map((record) => record.msg)).toStrictEqual([
      'booting worker',
      'postgres reachable',
      'redis reachable',
      'shutting down',
      'shutdown complete',
    ]);
  });

  /**
   * A second signal arriving while shutdown is still running must join the run in flight, not
   * resolve immediately: main.ts exits the process once the returned promise settles, so an
   * early-resolving second call would kill the process with both clients still open.
   */
  it('makes a concurrent second call wait for the shutdown already in flight', async () => {
    const { deps, prisma, redis } = makeDeps();
    let releaseQuit: () => void = () => undefined;
    redis.quit.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          releaseQuit = (): void => {
            resolve('OK');
          };
        }),
    );
    const { shutdown } = await boot(deps);

    const first = shutdown();
    const second = shutdown();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(prisma.$disconnect).not.toHaveBeenCalled();

    releaseQuit();
    await Promise.all([first, second]);
    expect(secondSettled).toBe(true);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * A failing `redis.quit()` must not strand the database pool: `closed` is already set, so the
   * caller cannot retry, and skipping `$disconnect()` would keep Postgres connections open for
   * the life of the process. The shutdown still rejects, so the caller exits non-zero.
   */
  it('disconnects Postgres and still rejects when Redis fails to quit', async () => {
    const { deps, prisma, redis } = makeDeps();
    const failure = new Error('quit failed');
    redis.quit.mockRejectedValueOnce(failure);
    const { shutdown } = await boot(deps);
    await expect(shutdown()).rejects.toBe(failure);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * The mirror case: a failing `$disconnect()` is reported rather than swallowed, after Redis
   * has already been closed.
   */
  it('rejects when Postgres fails to disconnect', async () => {
    const { deps, prisma, redis } = makeDeps();
    const failure = new Error('disconnect failed');
    prisma.$disconnect.mockRejectedValueOnce(failure);
    const { shutdown } = await boot(deps);
    await expect(shutdown()).rejects.toBe(failure);
    expect(redis.quit).toHaveBeenCalledTimes(1);
  });

  /**
   * When both releases fail, the first failure is the one surfaced — it is the one that explains
   * the shutdown — and both clients were still asked to close.
   */
  it('reports the first failure when both clients fail to close', async () => {
    const { deps, prisma, redis } = makeDeps();
    const first = new Error('quit failed');
    redis.quit.mockRejectedValueOnce(first);
    prisma.$disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
    const { shutdown } = await boot(deps);
    await expect(shutdown()).rejects.toBe(first);
    expect(redis.quit).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * Invalid configuration fails before any client is created.
   */
  it('propagates configuration errors before creating clients', async () => {
    const { deps } = makeDeps({
      loadConfig: () => {
        throw new ConfigError('bad env');
      },
    });
    await expect(boot(deps)).rejects.toThrow(ConfigError);
    expect(deps.createPrismaClient).not.toHaveBeenCalled();
  });

  /**
   * Database down: the reachability error propagates, the client is disconnected, and Redis is
   * never opened.
   */
  it('fails and releases the database client when Postgres is unreachable', async () => {
    const { deps, prisma } = makeDeps({
      assertDatabaseReachable: () => Promise.reject(new ConfigError('database unreachable: x')),
    });
    prisma.$disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
    await expect(boot(deps)).rejects.toThrow('database unreachable: x');
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(deps.createRedis).not.toHaveBeenCalled();
  });

  /**
   * Redis down: a rejected PING becomes a `ConfigError` naming the URL with its password blanked
   * and the driver's own code, and both clients are released. The driver's message is deliberately
   * absent — ioredis puts the connection string in it — so a password planted there must not
   * appear anywhere in the reported error; a successful PING with an unexpected reply is treated
   * the same way.
   */
  it('fails and releases both clients when Redis does not answer PONG', async () => {
    const secret = 'SUPERSECRETPW';
    const down = makeDeps();
    down.redis.ping.mockRejectedValueOnce(
      Object.assign(new Error(`connect ECONNREFUSED redis://u:${secret}@127.0.0.1:6379`), {
        code: 'ECONNREFUSED',
      }),
    );
    const failure = boot(down.deps);
    await expect(failure).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      message: `redis unreachable at ${describeUrl(config.REDIS_URL)} (ECONNREFUSED)`,
    });
    await failure.catch((error: unknown) => {
      expect(inspect(error, { depth: null })).not.toContain(secret);
    });
    expect(down.redis.quit).toHaveBeenCalledTimes(1);
    expect(down.prisma.$disconnect).toHaveBeenCalledTimes(1);

    const odd = makeDeps();
    odd.redis.ping.mockResolvedValueOnce('NOPE');
    await expect(boot(odd.deps)).rejects.toThrow('unexpected PING reply "NOPE"');

    const weird = makeDeps();
    weird.redis.ping.mockRejectedValueOnce(`redis://u:${secret}@h:6379`);
    const weirdFailure = boot(weird.deps);
    await expect(weirdFailure).rejects.toThrow('(unknown)');
    await expect(weirdFailure).rejects.not.toThrow(new RegExp(secret, 'u'));
  });

  /**
   * Cleanup failures during a failed boot never mask the original error.
   */
  it('ignores cleanup failures while reporting the boot error', async () => {
    const { deps, prisma, redis } = makeDeps();
    redis.ping.mockRejectedValueOnce(new Error('down'));
    redis.quit.mockRejectedValueOnce(new Error('quit failed'));
    prisma.$disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
    await expect(boot(deps)).rejects.toThrow('redis unreachable');
  });
});
