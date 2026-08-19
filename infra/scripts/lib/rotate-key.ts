/**
 * Master-key rotation: re-encrypts every stored secret under a new key with `keyVersion + 1`.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * Two phases, so a failure never leaves a secret unreadable. Phase 1 is read-only: every set
 * secret is revealed under the current key into memory; any decryption failure aborts before a
 * single byte is written. Phase 2 writes each revealed value under the new key; if a write fails
 * partway through, every secret already rotated is written back under the OLD key
 * (compensation), so the current master key stays fully authoritative for every row regardless of
 * where the failure happened. The revealed plaintexts live only in a local `Map`, cleared in a
 * `finally` so they never outlive this function.
 */
import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import { MASTER_KEY_VERSION } from '../../../packages/core/src/secrets/master-key.js';
import { SECRET_KEYS } from '../../../packages/core/src/secrets/types.js';
import type { SecretKey, SecretsService } from '../../../packages/core/src/secrets/types.js';

/** Outcome of {@link rotateSecrets}. */
export interface RotateSecretsResult {
  /** Number of secrets successfully re-encrypted under the new key. */
  rotated: number;
  /** Key version stamped on the rotated secrets (`current + 1`). */
  keyVersion: number;
  /** `0` success, `2` aborted before any write, `3` rolled back after a partial write. */
  exitCode: 0 | 2 | 3;
}

/** Collaborators of {@link rotateSecrets}. */
export interface RotateSecretsDeps {
  /** Row store for the encrypted envelopes. */
  repos: { secrets: SecretRepository };
  /** Builds a `SecretsService` bound to `repos.secrets` for a given key and version. */
  createService: (key: Uint8Array | string, keyVersion: number) => SecretsService;
  /** Current master key material. */
  oldKey: Uint8Array | string;
  /** New master key material. */
  newKey: Uint8Array | string;
  /** Receives one line per notable step (never a plaintext value). */
  log: (line: string) => void;
}

/**
 * Reads the highest `keyVersion` stamped on any stored secret, or {@link MASTER_KEY_VERSION} when
 * nothing is stored yet.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @returns The current key version.
 */
async function currentKeyVersion(repository: SecretRepository): Promise<number> {
  let max = MASTER_KEY_VERSION;
  for (const key of SECRET_KEYS) {
    const record = await repository.get(key);
    if (record !== null && record.keyVersion > max) {
      max = record.keyVersion;
    }
  }
  return max;
}

/**
 * Re-encrypts every stored secret from the current master key to a new one.
 *
 * @param deps - Injected collaborators.
 * @returns How many secrets moved, the resulting key version, and the outcome code.
 */
export async function rotateSecrets(deps: RotateSecretsDeps): Promise<RotateSecretsResult> {
  const current = await currentKeyVersion(deps.repos.secrets);
  const nextVersion = current + 1;
  const serviceA = deps.createService(deps.oldKey, current);
  const serviceB = deps.createService(deps.newKey, nextVersion);

  const revealed = new Map<SecretKey, string>();

  try {
    for (const key of SECRET_KEYS) {
      try {
        // `reveal` itself distinguishes "nothing stored" (null, nothing to rotate) from a
        // decryption failure (throws) — no separate `status()` call is needed to tell them apart.
        const plaintext = await serviceA.reveal(key);
        if (plaintext !== null) {
          revealed.set(key, plaintext);
        }
      } catch {
        deps.log(`abort: cannot decrypt ${key} with the current master key`);
        return { rotated: 0, keyVersion: current, exitCode: 2 };
      }
    }

    const rotated: [SecretKey, string][] = [];
    try {
      for (const [key, plaintext] of revealed) {
        await serviceB.set(key, plaintext);
        rotated.push([key, plaintext]);
      }
    } catch {
      for (const [key, plaintext] of rotated) {
        await serviceA.set(key, plaintext);
      }
      deps.log(`rolled back ${rotated.length} secret(s)`);
      return { rotated: 0, keyVersion: current, exitCode: 3 };
    }

    deps.log(`rotated ${revealed.size} secret(s) to keyVersion ${nextVersion}`);
    return { rotated: revealed.size, keyVersion: nextVersion, exitCode: 0 };
  } finally {
    revealed.clear();
  }
}
