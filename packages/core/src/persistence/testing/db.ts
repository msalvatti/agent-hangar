/**
 * Integration-test helpers for the compose Postgres: connect, truncate every table, run a block.
 *
 * Layer: test double (integration).
 *
 * Tests use a dedicated instance (`AH_INSTANCE=test`), so `truncateAll` may wipe every table of
 * the target database; it skips Prisma's own migration bookkeeping table.
 */
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

/**
 * Creates a client for `DATABASE_URL`.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns A Prisma client for the test database.
 * @throws ConfigError when `DATABASE_URL` is not set.
 */
export function connectTestDb(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PrismaClient {
  const connectionString = env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new ConfigError(
      'DATABASE_URL is not set; start the compose instance (pnpm infra:up) and export .env.local',
    );
  }
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
 * @param client - Connected client.
 */
export async function truncateAll(client: TruncatableClient): Promise<void> {
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
 * @param env - Environment to read `DATABASE_URL` from (defaults to `process.env`).
 * @returns Whatever `fn` returns.
 */
export async function withTestDb<T>(
  fn: (client: PrismaClient) => Promise<T>,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<T> {
  const client = connectTestDb(env);
  try {
    await truncateAll(client);
    return await fn(client);
  } finally {
    await disconnectPrisma(client);
  }
}
