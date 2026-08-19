/**
 * `doctor`'s secrets-status check: whether GITHUB_PAT/OPENAI_API_KEY are stored, masked to their
 * last four characters.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * Every dependency is injected so the behaviour is testable without a real Postgres or a real
 * master key file: production wiring (`secrets-status.main.ts`) supplies the real database
 * client, repository and master-key-backed service; tests supply an in-memory repository and the
 * real `SecretsService` implementation over a temporary key file.
 *
 * Never calls `SecretsService.reveal` — only `status()`, which never touches plaintext.
 */
import type { RawEnv } from '../../../packages/core/src/config/schema.js';
import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import { SECRET_KEYS } from '../../../packages/core/src/secrets/types.js';
import type { SecretsService } from '../../../packages/core/src/secrets/types.js';

/** Reported on stderr when the database does not answer. */
export const DB_UNREACHABLE_MESSAGE = 'error db-unreachable';

/** Reported on stderr when the master key file is missing or unreadable. */
export const MASTER_KEY_MISSING_MESSAGE = 'error master-key-missing';

/** Exit code for {@link DB_UNREACHABLE_MESSAGE}. */
export const EXIT_DB_UNREACHABLE = 3;

/** Exit code for {@link MASTER_KEY_MISSING_MESSAGE}. */
export const EXIT_MASTER_KEY_MISSING = 4;

/**
 * Collaborators of {@link secretsStatus}, every one of them injectable for tests.
 *
 * `TClient` is whatever {@link SecretsStatusDeps.createDatabaseClient} returns — the real Prisma
 * client in production, a bare object in tests — so no cast is needed on either side.
 */
export interface SecretsStatusDeps<TClient = unknown> {
  /** Environment to read (`process.env` in production). */
  env: RawEnv;
  /** Validates the environment and resolves `DATABASE_URL`/`MASTER_KEY_PATH`. */
  loadConfig: (env: RawEnv) => { DATABASE_URL: string; MASTER_KEY_PATH: string };
  /** Builds a database client from a connection string. */
  createDatabaseClient: (connectionString: string) => TClient;
  /** Resolves once the database answers, or rejects. */
  assertDatabaseReachable: (client: TClient) => Promise<void>;
  /** Builds the secret repository over a reachable client. */
  createSecretRepository: (client: TClient) => SecretRepository;
  /**
   * Builds the secrets service over the repository and the master key at `masterKeyPath`.
   *
   * @throws when the master key file is missing or unreadable.
   */
  createSecretsService: (repository: SecretRepository, masterKeyPath: string) => SecretsService;
}

/**
 * Formats one secret's status line.
 *
 * @param key - Secret key.
 * @param status - Masked status for that key.
 * @returns `KEY=set:last4` or `KEY=unset`.
 */
function formatLine(key: string, status: { set: boolean; last4?: string }): string {
  return status.set ? `${key}=set:${status.last4 ?? ''}` : `${key}=unset`;
}

/**
 * Reports whether GITHUB_PAT and OPENAI_API_KEY are stored, masked to their last four characters.
 *
 * @param deps - Injected collaborators.
 * @returns Lines to print and the process exit code.
 */
export async function secretsStatus<TClient>(
  deps: SecretsStatusDeps<TClient>,
): Promise<{ lines: string[]; exitCode: number }> {
  const config = deps.loadConfig(deps.env);
  const client = deps.createDatabaseClient(config.DATABASE_URL);
  try {
    await deps.assertDatabaseReachable(client);
  } catch {
    return { lines: [DB_UNREACHABLE_MESSAGE], exitCode: EXIT_DB_UNREACHABLE };
  }

  const repository = deps.createSecretRepository(client);
  let service: SecretsService;
  try {
    service = deps.createSecretsService(repository, config.MASTER_KEY_PATH);
  } catch {
    return { lines: [MASTER_KEY_MISSING_MESSAGE], exitCode: EXIT_MASTER_KEY_MISSING };
  }

  const status = await service.status();
  const lines = SECRET_KEYS.map((key) => formatLine(key, status[key]));
  return { lines, exitCode: 0 };
}
