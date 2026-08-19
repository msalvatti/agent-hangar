/**
 * Unit tests for the worker boot sequence.
 *
 * Layer: unit.
 * Goal: success path wires config → Postgres check → Redis ping and returns a shutdown that
 * closes Redis then Postgres exactly once; every failure (config, DB down, Redis down, bad PING
 * reply) surfaces as a `ConfigError` and releases what was already opened.
 * Mocks: injected fakes for every collaborator; no I/O.
 */
import { ConfigError, loadConfig } from '@agent-hangar/core';
import type { AppConfig } from '@agent-hangar/core';
import pino from 'pino';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { boot, describeUrl } from './boot.js';
import type { BootDeps } from './boot.js';

const config: AppConfig = loadConfig({ AH_INSTANCE: 'test', AH_PORT_BASE: '4100' });

function fakeLogger(): Logger {
  return pino({ level: 'silent' });
}

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
  /**
   * Credentials embedded in a connection URL never reach error messages or logs; non-URL
   * strings pass through unchanged.
   */
  it('strips userinfo and tolerates non-URLs', () => {
    expect(describeUrl('redis://user:secret@cache:6379/0')).toBe('redis://cache:6379/0');
    expect(describeUrl('redis://127.0.0.1:6379')).toBe('redis://127.0.0.1:6379');
    expect(describeUrl('not a url')).toBe('not a url');
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
   * Redis down: a rejected PING becomes a `ConfigError` naming the URL, and both clients are
   * released; a successful PING with an unexpected reply is treated the same way.
   */
  it('fails and releases both clients when Redis does not answer PONG', async () => {
    const down = makeDeps();
    down.redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(boot(down.deps)).rejects.toMatchObject({
      code: 'CONFIG_ERROR',
      message: `redis unreachable at ${config.REDIS_URL}: ECONNREFUSED`,
    });
    expect(down.redis.quit).toHaveBeenCalledTimes(1);
    expect(down.prisma.$disconnect).toHaveBeenCalledTimes(1);

    const odd = makeDeps();
    odd.redis.ping.mockResolvedValueOnce('NOPE');
    await expect(boot(odd.deps)).rejects.toThrow('unexpected PING reply "NOPE"');

    const weird = makeDeps();
    weird.redis.ping.mockRejectedValueOnce('string failure');
    await expect(boot(weird.deps)).rejects.toThrow('string failure');
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
