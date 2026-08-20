/**
 * Database reset between specs.
 *
 * Layer: test support (connects to Postgres).
 *
 * The core testing helpers are imported lazily: their barrel pulls in Prisma and Vitest, and in
 * `mock` mode nothing here ever runs, so a mock run must not pay for — or break on — loading them.
 * They also refuse to erase anything that is not an `agent_hangar_<instance>` database with `test`
 * as a word of the instance, and refuse again unless the destructive opt-in is set; both are
 * satisfied deliberately and explicitly here rather than by exporting the opt-in into the shell,
 * where it would also apply to whatever else that shell runs.
 */
import type { E2eEnv } from './env';

/** Opt-in the core helpers demand before they truncate anything. */
const DESTRUCTIVE_OPT_IN = { AH_ALLOW_DESTRUCTIVE_TESTS: '1' } as const;

/**
 * Empties every table of the test database.
 *
 * @param env - The resolved environment, naming the test database.
 */
export async function resetDatabase(env: E2eEnv): Promise<void> {
  const { connectTestDb, truncateAll } = await import('@agent-hangar/core/testing');
  const { disconnectPrisma } = await import('@agent-hangar/core');
  const helperEnv = { ...DESTRUCTIVE_OPT_IN, DATABASE_URL: env.databaseUrl };
  const client = connectTestDb(helperEnv);
  try {
    await truncateAll(client, helperEnv);
  } finally {
    await disconnectPrisma(client);
  }
}
