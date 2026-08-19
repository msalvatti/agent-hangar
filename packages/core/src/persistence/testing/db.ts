/**
 * Integration-test helpers for the compose Postgres: connect, truncate every table, run a block.
 *
 * Layer: test double (integration).
 *
 * These helpers ERASE DATA — `truncateAll` empties every table of the `public` schema — so both
 * entry points refuse to touch anything that is not provably a throwaway test database. Two
 * independent conditions must hold, because one of them alone is an accident waiting to happen:
 *
 * 1. `AH_ALLOW_DESTRUCTIVE_TESTS=1` must be exported. Nothing sets it for you — not the package
 *    scripts, not `.env.local` — so a shell that has it is a shell someone deliberately prepared.
 * 2. The database name must pass `isTestDatabaseName`: the project's
 *    `agent_hangar_<instance>` convention with `test` as a whole word of the instance. The
 *    database `pnpm setup` creates for everyday development (`agent_hangar_default`, or
 *    `agent_hangar_<your-branch>`) therefore does not qualify.
 *
 * Run integration tests against a dedicated instance:
 * `AH_INSTANCE=test pnpm setup`, then
 * `AH_ALLOW_DESTRUCTIVE_TESTS=1 DATABASE_URL=postgresql://…/agent_hangar_test pnpm test:integration`.
 */
import { describe } from 'vitest';

import type { RawEnv } from '../../config/schema.js';
import { ConfigError } from '../../errors.js';
import { createPrismaClient, disconnectPrisma } from '../client.js';
import type { PrismaClient } from '../generated/client.js';

/** The subset of the Prisma client the helpers rely on. */
export interface TruncatableClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string): Promise<number>;
  $disconnect(): Promise<void>;
}

/** Table kept across truncations. */
export const MIGRATIONS_TABLE = '_prisma_migrations';

/** Pool size of the test client (tests run with at most three workers). */
export const TEST_POOL_MAX = 4;

/** Connection timeout of the test client, in ms. */
export const TEST_CONNECTION_TIMEOUT_MS = 5000;

/** Environment variable that must be set before these helpers may erase anything. */
export const DESTRUCTIVE_TESTS_ENV = 'AH_ALLOW_DESTRUCTIVE_TESTS';

/** The only value {@link DESTRUCTIVE_TESTS_ENV} accepts. */
export const DESTRUCTIVE_TESTS_OPT_IN = '1';

/** Database name used in the guidance messages. */
export const EXAMPLE_TEST_DATABASE = 'agent_hangar_test';

/** Prefix the project derives for every database, from `AH_INSTANCE`. */
const DATABASE_PREFIX = 'agent_hangar_';

/** Word the instance must contain for its database to be erasable. */
const TEST_INSTANCE_WORD = 'test';

/**
 * Whether a database name is one these helpers may erase.
 *
 * Requires the project's `agent_hangar_<instance>` prefix plus `test` as an underscore-delimited
 * word of the instance, so `agent_hangar_test` and `agent_hangar_w2b_test` qualify while
 * `agent_hangar_default` and `agent_hangar_ci` do not. The word is compared whole rather than
 * searched for, so a development instance that merely contains those letters
 * (`agent_hangar_latest`) is refused too.
 *
 * @param name - Database name reported by the connection, or taken from `DATABASE_URL`.
 * @returns `true` only for a name that follows the test-instance convention.
 */
function isTestDatabaseName(name: string): boolean {
  if (!name.startsWith(DATABASE_PREFIX)) {
    return false;
  }
  return name.slice(DATABASE_PREFIX.length).split('_').includes(TEST_INSTANCE_WORD);
}

/** Names the database in a refusal message, without ever echoing the connection string. */
function describeDatabase(databaseName: string | undefined): string {
  return databaseName === undefined ? 'the target database' : `database "${databaseName}"`;
}

/**
 * Throws unless the named database may be erased.
 *
 * @param databaseName - Database the caller is about to empty, or `undefined` when unknown.
 * @param env - Environment carrying the opt-in.
 * @throws ConfigError naming what was refused and how to point at a test database.
 */
function assertErasable(databaseName: string | undefined, env: RawEnv): void {
  if (env[DESTRUCTIVE_TESTS_ENV] !== DESTRUCTIVE_TESTS_OPT_IN) {
    throw new ConfigError(
      `Refusing to erase ${describeDatabase(databaseName)}: ${DESTRUCTIVE_TESTS_ENV} is not set to ` +
        `"${DESTRUCTIVE_TESTS_OPT_IN}". These helpers truncate every table, so erasing one has to ` +
        `be opted into explicitly, and only ever for a throwaway test database.`,
    );
  }
  if (databaseName === undefined || !isTestDatabaseName(databaseName)) {
    throw new ConfigError(
      `Refusing to erase ${describeDatabase(databaseName)}: it is not a test database. These ` +
        `helpers truncate every table, so the name must follow agent_hangar_<instance> with ` +
        `"test" as a word of the instance (for example ${EXAMPLE_TEST_DATABASE}). Point ` +
        `DATABASE_URL at a throwaway test database, never at the one pnpm setup created for ` +
        `your development instance.`,
    );
  }
}

/**
 * Extracts the database name from a Postgres connection URL.
 *
 * Query parameters (`?schema=public`, pool settings) are not part of the name, and a URL this
 * cannot read yields `undefined`, which the guard treats as "not a test database".
 *
 * @param connectionString - Value of `DATABASE_URL`.
 * @returns The database name, or `undefined` when the URL does not name one.
 */
function databaseNameOf(connectionString: string): string | undefined {
  const parsed = URL.parse(connectionString);
  if (parsed === null) {
    return undefined;
  }
  const raw = parsed.pathname.replace(/^\//, '');
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    // A malformed percent sequence names no database this guard can identify. Refuse, rather than
    // let a URIError escape a check whose entire job is to fail closed.
    return undefined;
  }
  return name.length === 0 ? undefined : name;
}

/**
 * Creates a client for `DATABASE_URL`, refusing anything that is not a test database.
 *
 * The refusal happens before the client is constructed, so nothing ever connects to a database
 * these helpers would go on to empty.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns A Prisma client for the test database.
 * @throws ConfigError when `DATABASE_URL` is unset, when {@link DESTRUCTIVE_TESTS_ENV} is not
 *   opted in, or when the database is not named like a test database.
 */
export function connectTestDb(env: RawEnv = process.env): PrismaClient {
  const connectionString = env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new ConfigError(
      `DATABASE_URL is not set. These helpers truncate every table, so integration tests need a ` +
        `dedicated test database (for example ${EXAMPLE_TEST_DATABASE}) and ` +
        `${DESTRUCTIVE_TESTS_ENV}=${DESTRUCTIVE_TESTS_OPT_IN}. Create one with ` +
        `"AH_INSTANCE=test pnpm setup"; never point them at your development database.`,
    );
  }
  assertErasable(databaseNameOf(connectionString), env);
  return createPrismaClient({
    connectionString,
    max: TEST_POOL_MAX,
    connectionTimeoutMillis: TEST_CONNECTION_TIMEOUT_MS,
  });
}

/**
 * Truncates every table of the `public` schema (except the migrations table) with CASCADE, so the
 * order does not matter.
 *
 * The guard is repeated here rather than trusted from {@link connectTestDb}, because callers may
 * pass a client they built themselves — the application container's, for instance — and the check
 * asks the connection itself which database it is on, so it cannot be fooled by a stale URL.
 *
 * @param client - Connected client.
 * @param env - Environment carrying the opt-in (defaults to `process.env`).
 * @throws ConfigError before touching any row when the target is not a test database.
 */
export async function truncateAll(
  client: TruncatableClient,
  env: RawEnv = process.env,
): Promise<void> {
  const current = await client.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  assertErasable(current[0]?.name, env);
  const rows = await client.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;
  const tables = rows
    .map((row) => row.tablename)
    .filter((name) => name !== MIGRATIONS_TABLE)
    .sort();
  if (tables.length === 0) {
    return;
  }
  const list = tables.map((name) => `"${name.replaceAll('"', '""')}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Connects, truncates, runs `fn`, and always disconnects.
 *
 * @param fn - Test body receiving the client.
 * @param env - Environment to read `DATABASE_URL` and the opt-in from (defaults to `process.env`).
 * @returns Whatever `fn` returns.
 * @throws ConfigError before connecting when the target is not a test database.
 */
export async function withTestDb<T>(
  fn: (client: PrismaClient) => Promise<T>,
  env: RawEnv = process.env,
): Promise<T> {
  const client = connectTestDb(env);
  try {
    await truncateAll(client, env);
    return await fn(client);
  } finally {
    await disconnectPrisma(client);
  }
}

/** Environment variable that fails a `@db` suite loudly instead of letting it skip silently. */
export const CI_ENV = 'CI';

/** Decision `describeDb` reaches about whether to run its suite. */
export interface DbSuiteDecision {
  /** Whether the suite should execute against a real database. */
  run: boolean;
  /** Human-readable explanation, printed either as a skip notice or a thrown message. */
  reason: string;
}

/**
 * Decides whether a `@db` suite should run, without touching a database.
 *
 * `DATABASE_URL` present → run. Absent in CI → the suite must not silently pass, so this throws
 * rather than returning a decision the caller could ignore. Absent locally → skip, with a
 * message telling the developer how to start the test database.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @throws ConfigError when `DATABASE_URL` is unset and {@link CI_ENV} is truthy.
 */
export function shouldRunDbSuite(env: RawEnv = process.env): DbSuiteDecision {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.length > 0) {
    return { run: true, reason: '@db suite running against DATABASE_URL' };
  }
  const ci = env[CI_ENV];
  if (ci !== undefined && ci.length > 0) {
    throw new ConfigError(
      'DATABASE_URL is required in CI for @db suites. A suite that silently skipped here would ' +
        'report green without ever touching the database it is meant to prove correct.',
    );
  }
  return {
    run: false,
    reason: `DATABASE_URL not set — @db suite skipped (start compose with AH_INSTANCE=${EXAMPLE_TEST_DATABASE.slice(
      DATABASE_PREFIX.length,
    )})`,
  };
}

/**
 * Registers a `describe` block that only runs against a real database.
 *
 * Locally, without `DATABASE_URL`, the block is registered with `describe.skip` and a warning is
 * printed once so the skip is visible instead of silent. In CI, {@link shouldRunDbSuite} throws
 * before this function can skip anything.
 *
 * @param title - Suite title; prefixed with `@db ` so reporters and filters can find it.
 * @param fn - The `describe` body (`it` calls, `beforeEach`, …).
 */
export function describeDb(title: string, fn: () => void): void {
  const decision = shouldRunDbSuite();
  const fullTitle = `@db ${title}`;
  if (!decision.run) {
    // Deliberate, human-facing local skip notice — not an application log path.
    console.warn(decision.reason);
    describe.skip(fullTitle, fn);
    return;
  }
  describe(fullTitle, fn);
}

/** Fields accepted to seed a `Chat` row directly, bypassing `PrismaChatRepository`. */
export interface SeedChatOverrides {
  title?: string;
  repoUrl?: string;
  baseBranch?: string;
  status?: 'ACTIVE' | 'ARCHIVED';
}

/** The subset of the Prisma client {@link seedChat} relies on. */
export interface ChatSeedClient {
  chat: {
    create(args: {
      data: { title: string; repoUrl: string; baseBranch: string; status: 'ACTIVE' | 'ARCHIVED' };
    }): Promise<{ id: string }>;
  };
}

/**
 * Inserts a minimal `Chat` row directly through Prisma, for tests of child entities that need a
 * parent to exist (`Message`, `Turn`, `Workspace`).
 *
 * @param client - Connected test client.
 * @param overrides - Fields to override; sensible defaults fill the rest.
 * @returns The id of the inserted chat.
 */
export async function seedChat(
  client: ChatSeedClient,
  overrides: SeedChatOverrides = {},
): Promise<string> {
  const chat = await client.chat.create({
    data: {
      title: overrides.title ?? 'Test chat',
      repoUrl: overrides.repoUrl ?? 'https://github.com/agent-hangar/example',
      baseBranch: overrides.baseBranch ?? 'main',
      status: overrides.status ?? 'ACTIVE',
    },
  });
  return chat.id;
}

/** The subset of the Prisma client {@link rawSelect} relies on. */
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

/**
 * Thin wrapper over `$queryRaw`, so tests can read a column's raw stored value — bypassing the
 * repository mappers — to assert redaction happened before the write, not after the read.
 *
 * @param client - Connected test client.
 * @param sql - Tagged-template SQL.
 * @param values - Interpolated values (parameterised by Prisma, never string-concatenated).
 */
export async function rawSelect<T>(
  client: RawQueryClient,
  sql: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  return client.$queryRaw<T[]>(sql, ...values);
}

/** The subset of the Prisma client {@link countRows} relies on. */
export interface RawUnsafeQueryClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

/** Table names `countRows` accepts; anything else is refused before a query is built. */
const COUNTABLE_TABLES = [
  'Chat',
  'Message',
  'Turn',
  'Workspace',
  'ScheduledJob',
  'JobRun',
  'ToolCallLog',
  'Secret',
] as const;

/** A table `countRows` can count. */
export type CountableTable = (typeof COUNTABLE_TABLES)[number];

/**
 * Counts the rows of one table, for cascade-delete assertions.
 *
 * The table name is checked against a fixed whitelist before it is interpolated into raw SQL —
 * `$queryRawUnsafe` cannot parameterise an identifier, so this is what keeps the call injection-
 * safe even though the parameter type already restricts callers to the whitelist at compile time.
 *
 * @param client - Connected test client.
 * @param table - One of {@link CountableTable}.
 * @throws ConfigError when `table` is not on the whitelist.
 */
export async function countRows(
  client: RawUnsafeQueryClient,
  table: CountableTable,
): Promise<number> {
  if (!COUNTABLE_TABLES.includes(table)) {
    throw new ConfigError(`Unknown table for countRows: "${table}"`);
  }
  const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM "${table}"`,
  );
  return Number(rows[0]?.count ?? 0n);
}
