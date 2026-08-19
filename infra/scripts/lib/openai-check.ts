/**
 * `doctor`'s OpenAI model check: confirms the configured model id is reachable with the stored
 * key, without spending tokens.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * Reveals `OPENAI_API_KEY` the same way the worker does before a turn — the value is passed
 * straight to the model provider constructor and is never printed, logged, or stored anywhere
 * else. `doctor.sh` only calls this helper when the secrets check already reported the key as
 * set; `no-key` exists so the helper is still safe to run directly.
 */
import type { RawEnv } from '../../../packages/core/src/config/schema.js';
import { ModelProviderError } from '../../../packages/core/src/model/openai/errors.js';
import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import type { SecretsService } from '../../../packages/core/src/secrets/types.js';

/** Exit code when the configured model id is not in the reachable list. */
export const EXIT_MODEL_MISSING = 5;

/** Exit code when the credential is rejected by the provider. */
export const EXIT_AUTH = 6;

/** Exit code for any other provider or connectivity failure. */
export const EXIT_NETWORK = 7;

/** Exit code when no OpenAI key is stored. */
export const EXIT_NO_KEY = 8;

/** Number of reachable model ids listed in a `model-missing` line. */
const LISTED_MODEL_COUNT = 5;

/** A model provider's `listModels`, the only method this helper calls. */
export interface ModelLister {
  listModels: () => Promise<string[]>;
}

/**
 * Collaborators of {@link openaiCheck}, every one of them injectable for tests.
 *
 * `TClient` is whatever {@link OpenaiCheckDeps.createDatabaseClient} returns.
 */
export interface OpenaiCheckDeps<TClient = unknown> {
  /** Environment to read (`process.env` in production). */
  env: RawEnv;
  /** Validates the environment and resolves the fields this check needs. */
  loadConfig: (env: RawEnv) => {
    DATABASE_URL: string;
    MASTER_KEY_PATH: string;
    OPENAI_MODEL: string;
    OPENAI_BASE_URL?: string | undefined;
  };
  /** Builds a database client from a connection string. */
  createDatabaseClient: (connectionString: string) => TClient;
  /** Resolves once the database answers, or rejects. */
  assertDatabaseReachable: (client: TClient) => Promise<void>;
  /** Builds the secret repository over a reachable client. */
  createSecretRepository: (client: TClient) => SecretRepository;
  /** Builds the secrets service over the repository and the master key. */
  createSecretsService: (repository: SecretRepository, masterKeyPath: string) => SecretsService;
  /** Builds the model provider the revealed key is checked against. */
  createProvider: (apiKey: string, baseURL: string | undefined) => ModelLister;
}

/**
 * Reveals `OPENAI_API_KEY`, returning `null` when nothing is stored or it cannot be reached.
 *
 * @param deps - Injected collaborators.
 * @returns The plaintext key, or `null`.
 */
async function revealApiKey<TClient>(deps: OpenaiCheckDeps<TClient>): Promise<string | null> {
  const config = deps.loadConfig(deps.env);
  const client = deps.createDatabaseClient(config.DATABASE_URL);
  await deps.assertDatabaseReachable(client);
  const repository = deps.createSecretRepository(client);
  const service = deps.createSecretsService(repository, config.MASTER_KEY_PATH);
  return service.reveal('OPENAI_API_KEY');
}

/**
 * Formats the `model-missing` line, listing up to {@link LISTED_MODEL_COUNT} reachable ids.
 *
 * @param model - Configured model id that was not found.
 * @param available - Every model id the credential can reach.
 * @returns The line to print.
 */
function formatModelMissing(model: string, available: readonly string[]): string {
  const listed = available.slice(0, LISTED_MODEL_COUNT).join(', ');
  const suffix = available.length > LISTED_MODEL_COUNT ? ', …' : '';
  return `model-missing ${model} (available: ${listed}${suffix})`;
}

/**
 * Checks whether the configured `OPENAI_MODEL` is reachable with the stored `OPENAI_API_KEY`.
 *
 * @param deps - Injected collaborators.
 * @returns The line to print and the process exit code.
 */
export async function openaiCheck<TClient>(
  deps: OpenaiCheckDeps<TClient>,
): Promise<{ line: string; exitCode: number }> {
  let apiKey: string | null;
  try {
    apiKey = await revealApiKey(deps);
  } catch {
    // The failure could be an unreachable database or an unusable master key; doctor.sh only
    // calls this helper once row 9 (Secrets) already reported both as healthy, so this path is a
    // defensive fallback for direct invocation. The underlying error is already discarded rather
    // than inspected: every rejection this codebase's own collaborators produce is a safe,
    // pre-sanitised Error, but the injected deps are an open interface a caller could still hand
    // an unsanitised one, and a fixed message is safer than trusting that in a diagnostic tool.
    return { line: 'network unexpected error', exitCode: EXIT_NETWORK };
  }
  if (apiKey === null || apiKey.length === 0) {
    return { line: 'no-key', exitCode: EXIT_NO_KEY };
  }

  const config = deps.loadConfig(deps.env);
  const provider = deps.createProvider(apiKey, config.OPENAI_BASE_URL);
  try {
    const models = await provider.listModels();
    if (models.includes(config.OPENAI_MODEL)) {
      return { line: `ok ${config.OPENAI_MODEL}`, exitCode: 0 };
    }
    return { line: formatModelMissing(config.OPENAI_MODEL, models), exitCode: EXIT_MODEL_MISSING };
  } catch (error) {
    if (error instanceof ModelProviderError && error.modelErrorCode === 'auth') {
      return { line: 'auth', exitCode: EXIT_AUTH };
    }
    const message = error instanceof ModelProviderError ? error.message : 'unexpected error';
    return { line: `network ${message}`, exitCode: EXIT_NETWORK };
  }
}
