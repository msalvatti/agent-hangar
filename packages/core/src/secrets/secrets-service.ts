/**
 * The `SecretsService` implementation: encrypt on write, decrypt only for the worker.
 *
 * Layer: service.
 *
 * A credential exists in plaintext only inside {@link SecretsService.set}'s argument and inside
 * the value {@link SecretsService.reveal} hands back. Nothing here keeps a plaintext in closure
 * state, and nothing but `reveal` ever returns one: the repository receives ciphertext plus the
 * four masking characters, and `status` exposes nothing else.
 */
import type { SecretRepository } from '../persistence/ports.js';

import { encryptSecret, decryptSecret, last4 } from './crypto.js';
import { InvalidSecretError } from './errors.js';
import type { MasterKeyProvider } from './master-key.js';
import type { SecretKey, SecretStatus, SecretsService } from './types.js';

/** Collaborators of {@link createSecretsService}. */
export interface SecretsServiceDeps {
  /** Row store for the encrypted envelopes. */
  repository: SecretRepository;
  /** Source of the master key; providers cache, so `load` is called on every operation. */
  masterKey: MasterKeyProvider;
}

/**
 * Builds the secrets service over a repository and a master key provider.
 *
 * @param deps - Repository and master key provider.
 * @returns A service that never exposes plaintext except through `reveal`.
 */
export function createSecretsService(deps: SecretsServiceDeps): SecretsService {
  const { repository, masterKey } = deps;

  return {
    async set(key: SecretKey, plaintext: string): Promise<{ last4: string }> {
      if (plaintext.length === 0) {
        throw new InvalidSecretError();
      }
      const sealed = encryptSecret(plaintext, await masterKey.load());
      const masked = last4(plaintext);
      await repository.upsert(key, { ...sealed, last4: masked });
      return { last4: masked };
    },

    remove(key: SecretKey): Promise<void> {
      return repository.remove(key);
    },

    status(): Promise<Record<SecretKey, SecretStatus>> {
      return repository.status();
    },

    /**
     * Worker-only. Never call from apps/web. The returned plaintext must be passed straight to
     * `WorkspaceRunner.create()` env and to `Redactor.register()`; do not store it on any object.
     */
    async reveal(key: SecretKey): Promise<string | null> {
      const record = await repository.get(key);
      if (record === null) {
        return null;
      }
      return decryptSecret(record, await masterKey.load());
    },
  };
}
