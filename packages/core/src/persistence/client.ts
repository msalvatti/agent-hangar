/**
 * Prisma client factory over `@prisma/adapter-pg`, plus a fail-fast reachability check.
 *
 * Layer: service (infrastructure).
 *
 * Driver adapters are mandatory in Prisma 7 and `$connect()` is lazy, so a process that boots
 * against an unreachable database only finds out on its first query. `assertDatabaseReachable`
 * runs a real `SELECT 1` with a timeout so web and worker fail at boot with a clear message.
 */
import { PrismaPg } from '@prisma/adapter-pg';

import { ConfigError, describeClientFailure } from '../errors.ts';

import { PrismaClient } from './generated/client.ts';

/** Pool options explicit because pg ignores Prisma URL parameters such as `connection_limit`. */
export interface CreatePrismaClientOptions {
  /** A `postgresql://` connection string (see `DATABASE_URL`). */
  connectionString: string;
  /** Maximum pool size (pg default: 10). */
  max?: number;
  /** Time to wait for a connection from the pool, in ms (pg default: no limit). */
  connectionTimeoutMillis?: number;
}

/** The subset of the Prisma client used by the boot helpers; keeps them testable without Prisma. */
export interface DatabaseClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $disconnect(): Promise<void>;
}

/** Default timeout of {@link assertDatabaseReachable}. */
export const DEFAULT_REACHABILITY_TIMEOUT_MS = 5000;

/**
 * Creates a Prisma client backed by a pg pool.
 *
 * @param options - Connection string and pool limits.
 * @returns A client; no connection is opened until the first query.
 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    // Spread conditionally because these are optional properties and this project forbids handing
    // one an explicit `undefined`; the adapter reads an absent option and an option set to nothing
    // as the same instruction, so neither spelling can be told apart from outside.
    // Stryker disable next-line ConditionalExpression
    ...(options.max === undefined ? {} : { max: options.max }),
    // Stryker disable next-line ConditionalExpression
    ...(options.connectionTimeoutMillis === undefined
      ? {}
      : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
  });
  return new PrismaClient({ adapter });
}

/**
 * Runs `SELECT 1` and throws when the database does not answer in time.
 *
 * @param client - Prisma client (or any object with `$queryRaw`).
 * @param timeoutMs - Maximum wait before giving up.
 * @throws ConfigError when the query fails or times out.
 */
export async function assertDatabaseReachable(
  client: Pick<DatabaseClient, '$queryRaw'>,
  timeoutMs: number = DEFAULT_REACHABILITY_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  // Held by identity so the catch can recognise this exact object. Testing `instanceof ConfigError`
  // instead would also wave through a ConfigError raised by the client — and `client` is an
  // injectable interface, so a wrapper rejecting `new ConfigError(connectionString, { cause })`
  // would carry both the string and the chain straight past the sanitising branch below.
  const timedOut = new ConfigError(
    `database unreachable: no answer to SELECT 1 within ${String(timeoutMs)} ms`,
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timedOut);
    }, timeoutMs);
  });
  // The timer is disarmed on every way out, success and failure alike. Both the race and this
  // clean-up are internal to one call, so a timer left armed only rejects a promise the race has
  // already settled and handled — nothing outside can see the difference, which is why the
  // directive sits where it does.
  const probe = Promise.race([client.$queryRaw`SELECT 1`, timeout]).finally(
    // Stryker disable next-line ArrowFunction
    () => {
      clearTimeout(timer);
    },
  );
  try {
    await probe;
  } catch (error) {
    if (error === timedOut) {
      throw error;
    }
    // Neither the driver's message nor the error itself may travel: both carry the connection
    // string, password included, and `cause` republishes it to anything walking the chain.
    throw new ConfigError(`database unreachable (${describeClientFailure(error)})`);
  }
}

/**
 * Closes the client and its pool.
 *
 * @param client - Prisma client (or any object with `$disconnect`).
 */
export async function disconnectPrisma(client: Pick<DatabaseClient, '$disconnect'>): Promise<void> {
  await client.$disconnect();
}
