/**
 * Unit tests for the integration-test database helpers.
 *
 * Layer: unit.
 * Goal: nothing connects to, or truncates, a database that is not provably a throwaway test one —
 * both the opt-in variable and the name convention are required, and every refusal happens before
 * a client exists or a row is touched. Beyond the guard: `truncateAll` empties every public table
 * except the migrations table in one CASCADE statement, and `withTestDb` truncates, runs the block
 * and always disconnects.
 * Mocks: the client factory module (no database).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../../errors.js';

import {
  connectTestDb,
  DESTRUCTIVE_TESTS_ENV,
  MIGRATIONS_TABLE,
  truncateAll,
  withTestDb,
} from './db.js';

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

const TEST_URL = 'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_test';
const allowed = { DATABASE_URL: TEST_URL, [DESTRUCTIVE_TESTS_ENV]: '1' };

/** The message of the error a call throws, or `''` when it throws nothing. */
function messageOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
  }
  return '';
}

function tables(...names: string[]): { tablename: string }[] {
  return names.map((tablename) => ({ tablename }));
}

/** Queues the two reads `truncateAll` performs: the current database, then its public tables. */
function onDatabase(name: string, ...tableNames: string[]): void {
  fakeClient.$queryRaw
    .mockResolvedValueOnce([{ name }])
    .mockResolvedValueOnce(tables(...tableNames));
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('connectTestDb', () => {
  /**
   * Without `DATABASE_URL` the helper fails with an actionable `ConfigError` instead of letting pg
   * time out later; empty strings count as unset. The advice must describe a dedicated test
   * database — telling anyone to export `.env.local` into a path that truncates every table is
   * how a development database gets erased.
   */
  it('throws ConfigError naming a test database when DATABASE_URL is missing or empty', () => {
    expect(() => connectTestDb({})).toThrow(ConfigError);
    const message = messageOf(() => connectTestDb({ DATABASE_URL: '' }));
    expect(message).toContain('agent_hangar_test');
    expect(message).toContain(DESTRUCTIVE_TESTS_ENV);
    expect(message).not.toContain('.env.local');
    expect(createPrismaClient).not.toHaveBeenCalled();
  });

  /**
   * The heart of the guard: a database that is not provably a throwaway is refused before any
   * client is constructed, so nothing can connect to it, let alone truncate it. Production-shaped
   * targets, the database `pnpm setup` creates for everyday development, a name that merely
   * contains the letters of "test", a URL with no database at all and a string that is not a URL
   * are all refused — even with the opt-in exported.
   */
  it.each([
    ['a production-shaped database', 'postgresql://user:pw@db.example.com:5432/app_production'],
    ['the developer default database', 'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_default'],
    ['another instance of the developer', 'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_my_lane'],
    ['a name that only contains "test"', 'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_latest'],
    ['a URL naming no database', 'postgresql://127.0.0.1:5433'],
    ['a string that is not a URL', 'not-a-url'],
  ])('refuses %s even with the opt-in set', (_label, url) => {
    expect(() => connectTestDb({ DATABASE_URL: url, [DESTRUCTIVE_TESTS_ENV]: '1' })).toThrow(
      /Refusing to erase/,
    );
    expect(createPrismaClient).not.toHaveBeenCalled();
    expect(fakeClient.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * The two conditions are independent: the right database name is not enough on its own, because
   * a shell that never opted in is a shell that did not mean to erase anything.
   */
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['some other value', 'yes'],
    ['0', '0'],
  ])('refuses a real test database when the opt-in is %s', (_label, value) => {
    const env =
      value === undefined
        ? { DATABASE_URL: TEST_URL }
        : { DATABASE_URL: TEST_URL, [DESTRUCTIVE_TESTS_ENV]: value };
    expect(() => connectTestDb(env)).toThrow(DESTRUCTIVE_TESTS_ENV);
    expect(createPrismaClient).not.toHaveBeenCalled();
  });

  /**
   * Both conditions together are accepted, and only then is a client built — with the small pool
   * limits tests need. Instance-suffixed test databases follow the same convention.
   */
  it.each([
    'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_test',
    'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_w2b_test',
  ])('accepts %s with the opt-in set', (url) => {
    connectTestDb({ DATABASE_URL: url, [DESTRUCTIVE_TESTS_ENV]: '1' });
    expect(createPrismaClient).toHaveBeenCalledWith({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 5000,
    });
  });

  /**
   * Default env source is `process.env`, so a real run is gated by the same two conditions.
   */
  it('reads process.env by default', () => {
    vi.stubEnv('DATABASE_URL', TEST_URL);
    vi.stubEnv(DESTRUCTIVE_TESTS_ENV, '1');
    connectTestDb();
    expect(createPrismaClient).toHaveBeenCalledWith(
      expect.objectContaining({ connectionString: TEST_URL }),
    );
  });
});

describe('truncateAll', () => {
  /**
   * The guard is repeated at the destructive call itself, because callers may pass a client they
   * built without `connectTestDb` (the application container's, for example). It asks the
   * connection which database it is on, so a stale URL cannot fool it, and it refuses before a
   * single row is touched.
   */
  it('refuses to truncate a database that is not a test database', async () => {
    fakeClient.$queryRaw.mockResolvedValueOnce([{ name: 'agent_hangar_default' }]);
    await expect(truncateAll(fakeClient, allowed)).rejects.toThrow(/not a test database/);
    expect(fakeClient.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * Same refusal without the opt-in, so neither condition can be skipped by going through this
   * entry point instead of `connectTestDb`.
   */
  it('refuses to truncate without the opt-in', async () => {
    fakeClient.$queryRaw.mockResolvedValueOnce([{ name: 'agent_hangar_test' }]);
    await expect(truncateAll(fakeClient, { DATABASE_URL: TEST_URL })).rejects.toThrow(
      DESTRUCTIVE_TESTS_ENV,
    );
    expect(fakeClient.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * A connection that will not say which database it is on is not one to erase; the unknown name
   * is refused rather than assumed safe.
   */
  it('refuses when the current database cannot be determined', async () => {
    fakeClient.$queryRaw.mockResolvedValueOnce([]);
    await expect(truncateAll(fakeClient, allowed)).rejects.toThrow(/the target database/);
    expect(fakeClient.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * Every public table except `_prisma_migrations` is truncated in a single, order-independent
   * CASCADE statement with identifiers quoted (and embedded quotes escaped).
   */
  it('truncates every table except the migrations table with CASCADE', async () => {
    onDatabase('agent_hangar_test', 'Turn', MIGRATIONS_TABLE, 'Chat', 'Odd"Name');
    await truncateAll(fakeClient, allowed);
    expect(fakeClient.$executeRawUnsafe).toHaveBeenCalledWith(
      'TRUNCATE TABLE "Chat", "Odd""Name", "Turn" RESTART IDENTITY CASCADE',
    );
  });

  /**
   * An empty database (nothing migrated yet) issues no TRUNCATE, which would be a syntax error.
   */
  it('does nothing when there is no table to truncate', async () => {
    onDatabase('agent_hangar_test', MIGRATIONS_TABLE);
    await truncateAll(fakeClient, allowed);
    expect(fakeClient.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  /**
   * Default env source is `process.env` here too.
   */
  it('reads process.env by default', async () => {
    vi.stubEnv(DESTRUCTIVE_TESTS_ENV, '1');
    onDatabase('agent_hangar_test', 'Chat');
    await truncateAll(fakeClient);
    expect(fakeClient.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('withTestDb', () => {
  /**
   * Happy path: connect → truncate → run block (its value is returned) → disconnect.
   */
  it('truncates, runs the block and disconnects', async () => {
    onDatabase('agent_hangar_test', 'Chat');
    const result = await withTestDb(async (client) => {
      expect(client).toBe(fakeClient);
      await Promise.resolve();
      return 42;
    }, allowed);
    expect(result).toBe(42);
    expect(fakeClient.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(fakeClient.$disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * Failure path: when the block throws, the client is still disconnected and the error
   * propagates unchanged.
   */
  it('disconnects even when the block throws', async () => {
    onDatabase('agent_hangar_test');
    await expect(
      withTestDb(() => Promise.reject(new Error('test failed')), allowed),
    ).rejects.toThrow('test failed');
    expect(fakeClient.$disconnect).toHaveBeenCalledTimes(1);
  });

  /**
   * A refused target never reaches the block, never truncates and never even builds a client —
   * the whole point of checking before connecting.
   */
  it('never connects, truncates or runs the block for a refused database', async () => {
    const block = vi.fn(() => Promise.resolve('ran'));
    await expect(
      withTestDb(block, {
        DATABASE_URL: 'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_default',
        [DESTRUCTIVE_TESTS_ENV]: '1',
      }),
    ).rejects.toThrow(ConfigError);
    expect(block).not.toHaveBeenCalled();
    expect(createPrismaClient).not.toHaveBeenCalled();
    expect(fakeClient.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(fakeClient.$disconnect).not.toHaveBeenCalled();
  });

  /**
   * Default env source is `process.env`.
   */
  it('reads process.env by default', async () => {
    vi.stubEnv('DATABASE_URL', TEST_URL);
    vi.stubEnv(DESTRUCTIVE_TESTS_ENV, '1');
    onDatabase('agent_hangar_test', 'Chat');
    await withTestDb(() => Promise.resolve('ok'));
    expect(fakeClient.$disconnect).toHaveBeenCalledTimes(1);
  });
});
