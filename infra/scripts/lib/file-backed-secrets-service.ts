/**
 * Builds the current-key `SecretsService` the host-side diagnostics (`secrets-status.ts`,
 * `openai-check.ts`) use.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * The key is not merely reachable, it is loaded: `status()` never touches the master key (it only
 * reports whether a ciphertext row exists), so a diagnostic that stopped at a readability probe
 * would report a healthy store for malformed key contents, a symbolic link, a non-regular file or
 * a group-reachable directory — every one of which `MasterKeyFile.load()` refuses the moment the
 * worker actually decrypts. A check that passes where the real path fails is worse than no check,
 * so exactly the load the real readers perform runs here.
 *
 * The explicit readability probe still runs first, and it runs before the provider is built: the
 * provider creates a key file when none exists, which is right for the app's first start and
 * wrong for a read-only diagnostic — reporting `master-key-missing` is the whole point, and
 * silently minting a key would make every stored secret undecryptable instead.
 */
import { accessSync, constants } from 'node:fs';

import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import { MasterKeyFile } from '../../../packages/core/src/secrets/master-key-file.js';
import { createSecretsService } from '../../../packages/core/src/secrets/secrets-service.js';
import type { SecretsService } from '../../../packages/core/src/secrets/types.js';

/**
 * Builds a `SecretsService` over `repository` and the master key at `masterKeyPath`, after loading
 * that key exactly as the worker and the web app do.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @param masterKeyPath - Path of the master key file (`MASTER_KEY_PATH`).
 * @returns The service, with the master key already loaded and cached.
 * @throws When the master key file does not exist, is not readable, or is rejected by
 * `MasterKeyFile.load()` (symbolic link, non-regular file, group/other-reachable, malformed
 * contents, insecure containing directory).
 */
export async function createFileBackedSecretsService(
  repository: SecretRepository,
  masterKeyPath: string,
): Promise<SecretsService> {
  accessSync(masterKeyPath, constants.R_OK);
  const masterKey = new MasterKeyFile({ path: masterKeyPath });
  await masterKey.load();
  return createSecretsService({ repository, masterKey });
}
