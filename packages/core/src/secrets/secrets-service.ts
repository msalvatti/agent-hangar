/**
 * The `SecretsService` implementation: encrypt on write, decrypt only for the worker.
 *
 * Layer: service.
 *
 * A credential exists in plaintext only inside {@link SecretsService.set}'s argument and inside
 * the value {@link SecretsService.reveal} hands back. Nothing here keeps a plaintext in closure
 * state, and nothing but `reveal` ever returns one: the repository receives ciphertext plus the
 * four masking characters, and `status` exposes nothing else.
 *
 * Each envelope is bound to its own row: the {@link SecretKey} is fed to GCM as additional
 * authenticated data, so an envelope copied from one row to another fails authentication instead
 * of being decrypted. Without that binding a swap of the two rows would be undetectable — every
 * envelope authenticates under the same master key — and `reveal('OPENAI_API_KEY')` would return
 * the GitHub token, which the caller would then send to a third party.
 */
import type { SecretRepository } from '../persistence/ports.ts';

import { encryptSecret, decryptSecret, last4 } from './crypto.ts';
import { InvalidSecretError } from './errors.ts';
import type { MasterKeyProvider } from './master-key.ts';
import type { SecretKey, SecretStatus, SecretsService } from './types.ts';

/**
 * Builds the additional authenticated data that ties an envelope to one row.
 *
 * The prefix keeps the value unambiguous if the same master key ever seals anything else.
 *
 * @param key - Row the envelope is stored under.
 * @returns The context string passed to `encryptSecret` and `decryptSecret`.
 */
function envelopeContext(key: SecretKey): string {
  return `agent-hangar:secret:${key}`;
}

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
      const sealed = encryptSecret(plaintext, await masterKey.load(), envelopeContext(key));
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
     * Worker-only. Never call from apps/web. The returned plaintext must be passed straight into
     * the `ExecSpec.files` entry of the execution it belongs to and into `Redactor.register()`; do
     * not store it on any object, and never put it in a container's environment.
     */
    async reveal(key: SecretKey): Promise<string | null> {
      const record = await repository.get(key);
      if (record === null) {
        return null;
      }
      return decryptSecret(record, await masterKey.load(), envelopeContext(key));
    },
  };
}
