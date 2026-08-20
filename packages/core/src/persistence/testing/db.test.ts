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

import { ConfigError } from '../../errors.ts';

import {
  CI_ENV,
  connectTestDb,
  countRows,
  describeDb,
  DESTRUCTIVE_TESTS_ENV,
  MIGRATIONS_TABLE,
  rawSelect,
  seedChat,
  shouldRunDbSuite,
  sqlTemplate,
  truncateAll,
  withTestDb,
} from './db.ts';

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
    ['a URL with a malformed escape', 'postgresql://127.0.0.1:5433/%zz'],
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
    // Prisma URLs routinely carry parameters; they are not part of the database name.
    'postgresql://ah:ah@127.0.0.1:5433/agent_hangar_test?schema=public&connection_limit=5',
  ])('accepts %s with the opt-in set', (url) => {
    connectTestDb({ DATABASE_URL: url, [DESTRUCTIVE_TESTS_ENV]: '1' });
    expect(createPrismaClient).toHaveBeenCalledWith({
      connectionString: url,
      max: 4,
      connectionTimeoutMillis: 5000,
    });
  });

  /**
   * The refusal is printed and logged, so it must never repeat a credential. An authority-less
   * connection URL parses with an empty host and puts user, password and host into the pathname,
   * which the name reader would otherwise hand to the message verbatim.
   */
  it.each([
    ['an authority-less URL', 'postgresql:/ah:PLANTED_PW@127.0.0.1:5432/agent_hangar_dev'],
    ['a normal URL with credentials', 'postgresql://ah:PLANTED_PW@127.0.0.1:5432/agent_hangar_dev'],
    ['a path that is not a plain name', 'postgresql://host/PLANTED_PW@x'],
  ])('refuses %s without repeating what it was given', (_name, connectionString) => {
    vi.stubEnv(DESTRUCTIVE_TESTS_ENV, '1');
    let message = '';
    try {
      connectTestDb({ DATABASE_URL: connectionString, [DESTRUCTIVE_TESTS_ENV]: '1' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Refusing to erase');
    expect(message).not.toContain('PLANTED_PW');
    expect(createPrismaClient).not.toHaveBeenCalled();
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

describe('shouldRunDbSuite', () => {
  /** `DATABASE_URL` present is enough on its own: the suite is meant to run. */
  it('returns run: true when DATABASE_URL is set', () => {
    const decision = shouldRunDbSuite({ DATABASE_URL: TEST_URL });
    expect(decision.run).toBe(true);
    expect(decision.reason).toContain('DATABASE_URL');
  });

  /**
   * Locally, without a database, the suite is skipped rather than failed — the reason names how
   * to start one so the skip is actionable, not just silent.
   */
  it('returns run: false with an actionable reason when DATABASE_URL and CI are both unset', () => {
    const decision = shouldRunDbSuite({});
    expect(decision.run).toBe(false);
    expect(decision.reason).toContain('DATABASE_URL not set');
    expect(decision.reason).toContain('AH_INSTANCE=test');
  });

  /**
   * In CI, silently skipping would report green without the suite ever touching a database, so
   * this throws instead of returning a decision a caller could ignore.
   */
  it('throws ConfigError when DATABASE_URL is unset and CI is truthy', () => {
    expect(() => shouldRunDbSuite({ [CI_ENV]: '1' })).toThrow(ConfigError);
    expect(() => shouldRunDbSuite({ [CI_ENV]: 'true' })).toThrow(/DATABASE_URL is required in CI/);
  });

  /** Default env source is `process.env`. */
  it('reads process.env by default', () => {
    vi.stubEnv('DATABASE_URL', TEST_URL);
    expect(shouldRunDbSuite().run).toBe(true);
  });
});

describe('describeDb', () => {
  /**
   * Registered directly at collection time (describe bodies run synchronously, `it` bodies run
   * later), with the environment pinned around each call so the outcome does not depend on
   * whatever is exported in the shell actually running this suite.
   */
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedCi = process.env[CI_ENV];

  process.env.DATABASE_URL = TEST_URL;
  Reflect.deleteProperty(process.env, CI_ENV);
  let ranWhenDatabaseUrlSet = false;
  describeDb('probe suite (DATABASE_URL set)', () => {
    it('runs for real', () => {
      ranWhenDatabaseUrlSet = true;
      expect(true).toBe(true);
    });
  });

  delete process.env.DATABASE_URL;
  Reflect.deleteProperty(process.env, CI_ENV);
  describeDb('probe suite (DATABASE_URL unset)', () => {
    it('never actually runs', () => {
      throw new Error('a skipped @db suite must not execute its body');
    });
  });

  if (savedDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = savedDatabaseUrl;
  }
  if (savedCi === undefined) {
    Reflect.deleteProperty(process.env, CI_ENV);
  } else {
    process.env[CI_ENV] = savedCi;
  }

  /** The non-skipped probe above actually executed its `it`. */
  it('runs the wrapped suite when DATABASE_URL was set at registration time', () => {
    expect(ranWhenDatabaseUrlSet).toBe(true);
  });
});

describe('seedChat', () => {
  /** Defaults fill every field the caller does not override. */
  it('inserts a Chat with sensible defaults and returns its id', async () => {
    const create = vi.fn(() => Promise.resolve({ id: 'chat-1' }));
    const id = await seedChat({ chat: { create } });
    expect(id).toBe('chat-1');
    expect(create).toHaveBeenCalledWith({
      data: {
        title: 'Test chat',
        repoUrl: 'https://github.com/agent-hangar/example',
        baseBranch: 'main',
        status: 'ACTIVE',
      },
    });
  });

  /** Overrides replace only the fields they name. */
  it('applies overrides on top of the defaults', async () => {
    const create = vi.fn(() => Promise.resolve({ id: 'chat-2' }));
    await seedChat({ chat: { create } }, { title: 'Custom', status: 'ARCHIVED' });
    expect(create).toHaveBeenCalledWith({
      data: {
        title: 'Custom',
        repoUrl: 'https://github.com/agent-hangar/example',
        baseBranch: 'main',
        status: 'ARCHIVED',
      },
    });
  });
});

describe('rawSelect', () => {
  /** Thin pass-through: the tagged template and its values reach `$queryRaw` unchanged. */
  it('forwards the tagged template and values to $queryRaw', async () => {
    const queryRaw = vi.fn(() => Promise.resolve([{ content: '[REDACTED]' }]));
    const client = { $queryRaw: queryRaw } as unknown as Parameters<typeof rawSelect>[0];
    const rows = await rawSelect<{ content: string }>(
      client,
      sqlTemplate('SELECT content FROM "Message" WHERE id = '),
      'msg-1',
    );
    expect(rows).toEqual([{ content: '[REDACTED]' }]);
    expect(queryRaw).toHaveBeenCalledWith(expect.anything(), 'msg-1');
  });
});

describe('sqlTemplate', () => {
  /** The wrapped array has both a text part and a matching `raw` part, as a real tag expects. */
  it('wraps a SQL string as a two-part TemplateStringsArray ending in a placeholder', () => {
    const template = sqlTemplate('SELECT id FROM "Chat" WHERE id = ');
    expect(Array.from(template)).toEqual(['SELECT id FROM "Chat" WHERE id = ', '']);
    expect(Array.from(template.raw)).toEqual(['SELECT id FROM "Chat" WHERE id = ', '']);
  });
});

describe('countRows', () => {
  /** Builds a whitelisted, quoted COUNT query and converts the bigint result to a number. */
  it('counts the rows of a whitelisted table', async () => {
    const queryRawUnsafe = vi.fn(() => Promise.resolve([{ count: 5n }]));
    const client = { $queryRawUnsafe: queryRawUnsafe } as unknown as Parameters<
      typeof countRows
    >[0];
    const count = await countRows(client, 'Message');
    expect(count).toBe(5);
    expect(queryRawUnsafe).toHaveBeenCalledWith('SELECT COUNT(*)::bigint AS count FROM "Message"');
  });

  /** An empty table (no rows, or the aggregate returning no row at all) counts as zero. */
  it('returns 0 when the aggregate yields no row', async () => {
    const queryRawUnsafe = vi.fn(() => Promise.resolve<{ count: bigint }[]>([]));
    const client = { $queryRawUnsafe: queryRawUnsafe } as unknown as Parameters<
      typeof countRows
    >[0];
    const count = await countRows(client, 'Secret');
    expect(count).toBe(0);
  });

  /** A table outside the whitelist is refused before any query is built. */
  it('refuses a table name outside the whitelist', async () => {
    const queryRawUnsafe = vi.fn(() => Promise.resolve([{ count: 0n }]));
    const client = { $queryRawUnsafe: queryRawUnsafe } as unknown as Parameters<
      typeof countRows
    >[0];
    await expect(
      countRows(client, 'Users; DROP TABLE "Chat"' as unknown as Parameters<typeof countRows>[1]),
    ).rejects.toThrow(ConfigError);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});
