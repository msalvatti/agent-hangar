/**
 * Unit tests for the integration-test database helpers.
 *
 * Layer: unit.
 * Goal: `connectTestDb` requires `DATABASE_URL` and builds a client with test pool limits;
 * `truncateAll` truncates every public table except the migrations table in one CASCADE
 * statement; `withTestDb` truncates, runs the block and always disconnects.
 * Mocks: the client factory module (no database).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../../errors.js';

import { connectTestDb, MIGRATIONS_TABLE, truncateAll, withTestDb } from './db.js';

const fakeClient = {
  $queryRaw: vi.fn(),
  $executeRawUnsafe: vi.fn(),
  $disconnect: vi.fn(),
};
const createPrismaClient = vi.fn((_options: unknown) => fakeClient);
const disconnectPrisma = vi.fn(async (client: { $disconnect: () => Promise<void> }) => {
  await client.$disconnect();
});

vi.mock('../client.js', () => ({
  createPrismaClient: (options: unknown) => createPrismaClient(options),
  disconnectPrisma: (client: { $disconnect: () => Promise<void> }) => disconnectPrisma(client),
}));

function tables(...names: string[]): { tablename: string }[] {
  return names.map((tablename) => ({ tablename }));
}

describe('connectTestDb', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Without `DATABASE_URL` the helper fails with an actionable `ConfigError` (how to start the
   * compose instance) instead of letting pg time out later; empty strings count as unset.
   */
  it('throws ConfigError when DATABASE_URL is missing or empty', () => {
    expect(() => connectTestDb({})).toThrow(ConfigError);
    expect(() => connectTestDb({ DATABASE_URL: '' })).toThrow(/pnpm infra:up/);
  });

  /**
   * With `DATABASE_URL` set the client is created with small pool limits suited to tests.
   */
  it('creates a client with test pool limits', () => {
    connectTestDb({ DATABASE_URL: 'postgresql://test' });
    expect(createPrismaClient).toHaveBeenCalledWith({
      connectionString: 'postgresql://test',
      max: 4,
      connectionTimeoutMillis: 5000,
    });
  });

  /**
   * Default env source is `process.env` (pinned for the assertion).
   */
  it('reads process.env by default', () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://from-process-env';
    try {
      connectTestDb();
      expect(createPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({ connectionString: 'postgresql://from-process-env' }),
      );
    } finally {
      if (saved === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = saved;
      }
    }
  });
});

describe('truncateAll', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Every public table except `_prisma_migrations` is truncated in a single, order-independent
   * CASCADE statement with identifiers quoted (and embedded quotes escaped).
   */
  it('truncates every table except the migrations table with CASCADE', async () => {
    fakeClient.$queryRaw.mockResolvedValueOnce(
      tables('Turn', MIGRATIONS_TABLE, 'Chat', 'Odd"Name'),
    );
    await truncateAll(fakeClient);
    expect(fakeClient.$executeRawUnsafe).toHaveBeenCalledWith(
      'TRUNCATE TABLE "Chat", "Odd""Name", "Turn" RESTART IDENTITY CASCADE',
    );
  });

  /**
   * An empty database (nothing migrated yet) issues no TRUNCATE, which would be a syntax error.
   */
  it('does nothing when there is no table to truncate', async () => {
    fakeClient.$queryRaw.mockResolvedValueOnce(tables(MIGRATIONS_TABLE));
    await truncateAll(fakeClient);
    expect(fakeClient.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('withTestDb', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Happy path: connect → truncate → run block (its value is returned) → disconnect.
   */
  it('truncates, runs the block and disconnects', async () => {
    fakeClient.$queryRaw.mockResolvedValueOnce(tables('Chat'));
    const result = await withTestDb(
      async (client) => {
        expect(client).toBe(fakeClient);
        await Promise.resolve();
        return 42;
      },
      { DATABASE_URL: 'postgresql://test' },
    );
    expect(result).toBe(42);
    expect(fakeClient.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(fakeClient.$disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * Failure path: when the block throws, the client is still disconnected and the error
   * propagates unchanged.
   */
  it('disconnects even when the block throws', async () => {
    fakeClient.$queryRaw.mockResolvedValueOnce(tables());
    await expect(
      withTestDb(() => Promise.reject(new Error('test failed')), {
        DATABASE_URL: 'postgresql://test',
      }),
    ).rejects.toThrow('test failed');
    expect(fakeClient.$disconnect).toHaveBeenCalledTimes(1);
  });
});
