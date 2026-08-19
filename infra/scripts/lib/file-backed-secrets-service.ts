/**
 * Builds the current-key `SecretsService` the host-side diagnostics (`secrets-status.ts`,
 * `openai-check.ts`) use.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * Read access to the master key file is checked explicitly before the service is built: `status()`
 * never touches the key (it only reports whether a ciphertext row exists), so a missing or
 * unreadable key would otherwise go unnoticed by these read-only checks — the whole point of
 * surfacing it separately as `master-key-missing`. Every other refusal (symbolic link, wrong file
 * type, group/other-readable) is `MasterKeyFile`'s job for whichever caller actually decrypts.
 */
import { accessSync, constants } from 'node:fs';

import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import { MasterKeyFile } from '../../../packages/core/src/secrets/master-key-file.js';
import { createSecretsService } from '../../../packages/core/src/secrets/secrets-service.js';
import type { SecretsService } from '../../../packages/core/src/secrets/types.js';

/**
 * Builds a `SecretsService` over `repository` and the master key at `masterKeyPath`.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @param masterKeyPath - Path of the master key file (`MASTER_KEY_PATH`).
 * @returns The service.
 * @throws When the master key file does not exist or is not readable.
 */
export function createFileBackedSecretsService(
  repository: SecretRepository,
  masterKeyPath: string,
): SecretsService {
  accessSync(masterKeyPath, constants.R_OK);
  return createSecretsService({
    repository,
    masterKey: new MasterKeyFile({ path: masterKeyPath }),
  });
}
