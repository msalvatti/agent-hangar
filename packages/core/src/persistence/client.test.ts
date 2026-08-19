/**
 * Unit tests for the Prisma client factory and boot helpers.
 *
 * Layer: unit.
 * Goal: the factory forwards pool options to the pg adapter, `assertDatabaseReachable` resolves
 * on `SELECT 1`, maps failures and timeouts to `ConfigError`, and `disconnectPrisma` closes the
 * client.
 * Mocks: `@prisma/adapter-pg` and the generated client (no database); fake timers for the timeout.
 */
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../errors.js';

import {
  assertDatabaseReachable,
  createPrismaClient,
  DEFAULT_REACHABILITY_TIMEOUT_MS,
  disconnectPrisma,
} from './client.js';

const adapterCtor = vi.fn();
const clientCtor = vi.fn();

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: function PrismaPg(config: unknown) {
    adapterCtor(config);
  },
}));

vi.mock('./generated/client.js', () => ({
  PrismaClient: function PrismaClient(options: unknown) {
    clientCtor(options);
  },
}));

describe('createPrismaClient', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Pool limits are passed to the adapter explicitly (pg ignores Prisma URL parameters), and the
   * adapter is handed to the client constructor.
   */
  it('forwards connection string and pool options to the adapter', () => {
    createPrismaClient({
      connectionString: 'postgresql://db',
      max: 3,
      connectionTimeoutMillis: 250,
    });
    expect(adapterCtor).toHaveBeenCalledWith({
      connectionString: 'postgresql://db',
      max: 3,
      connectionTimeoutMillis: 250,
    });
    expect(clientCtor).toHaveBeenCalledWith({ adapter: expect.any(Object) as object });
  });

  /**
   * Omitted options are not sent as `undefined` keys, leaving the pg defaults in force.
   */
  it('omits pool options that are not given', () => {
    createPrismaClient({ connectionString: 'postgresql://db' });
    expect(adapterCtor).toHaveBeenCalledWith({ connectionString: 'postgresql://db' });
  });
});

describe('assertDatabaseReachable', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Success path: the query resolves and the helper resolves without touching the timeout.
   */
  it('resolves when SELECT 1 succeeds', async () => {
    const client = { $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
    await expect(assertDatabaseReachable(client)).resolves.toBeUndefined();
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
  });

  /**
   * Failure path: a driver error becomes a `ConfigError` carrying only the driver's own code.
   * The driver's message holds the connection string, password included, and attaching the error
   * as `cause` would republish it to anything that walks the chain, so neither may travel.
   */
  it('reports a query failure by its driver code and keeps the connection string out', async () => {
    const secret = 'SUPERSECRETPW';
    const failure = Object.assign(
      new Error(`connect ECONNREFUSED postgresql://ah:${secret}@127.0.0.1:3001/db`),
      { code: 'ECONNREFUSED' },
    );
    const client = { $queryRaw: vi.fn().mockRejectedValue(failure) };
    const attempt = assertDatabaseReachable(client);
    await expect(attempt).rejects.toThrow(ConfigError);
    await expect(attempt).rejects.toThrow('database unreachable (ECONNREFUSED)');
    await attempt.catch((error: unknown) => {
      expect((error as ConfigError).cause).toBeUndefined();
      expect(inspect(error, { depth: null })).not.toContain(secret);
    });
  });

  /**
   * Non-Error rejections (drivers occasionally reject with strings) still classify, and still
   * repeat nothing of what was rejected.
   */
  it('reports a non-Error rejection without repeating it', async () => {
    const client = { $queryRaw: vi.fn().mockRejectedValue('postgresql://ah:SUPERSECRETPW@h/db') };
    const attempt = assertDatabaseReachable(client);
    await expect(attempt).rejects.toThrow('database unreachable (unknown)');
    await expect(attempt).rejects.not.toThrow(/SUPERSECRETPW/u);
  });

  /**
   * Timeout path: a query that never answers is abandoned after `timeoutMs` with a message naming
   * the limit; the default limit is exported.
   */
  it('times out with ConfigError', async () => {
    vi.useFakeTimers();
    const client = { $queryRaw: vi.fn().mockReturnValue(new Promise(() => undefined)) };
    const attempt = assertDatabaseReachable(client, 1000);
    const expectation = expect(attempt).rejects.toThrow(
      'database unreachable: no answer to SELECT 1 within 1000 ms',
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    expect(DEFAULT_REACHABILITY_TIMEOUT_MS).toBe(5000);
  });
});

describe('disconnectPrisma', () => {
  /**
   * Delegates to `$disconnect` so callers never touch the client API directly.
   */
  it('disconnects the client', async () => {
    const client = { $disconnect: vi.fn().mockResolvedValue(undefined) };
    await disconnectPrisma(client);
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });
});
