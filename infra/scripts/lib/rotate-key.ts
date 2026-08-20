/**
 * Master-key rotation: re-encrypts every stored secret under a new key.
 *
 * Layer: service (composition, host-side diagnostic).
 *
 * The key *version* stamped on an envelope is deliberately left where it is. Every ordinary reader
 * builds its master key provider without a version, so it decrypts at {@link MASTER_KEY_VERSION};
 * `decryptSecret` refuses any envelope whose `keyVersion` differs. Advancing the version on
 * rotation would therefore make every rotated credential unreadable by the web app and the worker
 * — the key material is what rotation replaces, and AES-GCM authentication is what tells the two
 * keys apart.
 *
 * Two phases, so a failure never leaves a secret unreadable. Phase 1 is read-only: every set
 * secret is revealed under the current key into memory; any decryption failure aborts before a
 * single byte is written. Phase 2 writes each revealed value under the new key; if a write fails
 * partway through, every secret already rotated is written back under the OLD key (compensation),
 * so the current master key stays fully authoritative for every row.
 *
 * Compensation can itself fail — the database can disappear mid-rollback. That case is reported
 * separately ({@link EXIT_COMPENSATION_INCOMPLETE}) instead of being presented as a clean abort:
 * the store is then split across the two keys, and the only recoverable state is one where BOTH
 * key files are kept. The caller must not delete the new key file on that outcome. Which key opens
 * which row needs no bookkeeping: an envelope authenticates under exactly one of the two keys and
 * fails closed under the other.
 *
 * The revealed plaintexts live only in a local `Map`, cleared in a `finally` so they never outlive
 * this function.
 */
import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import { MASTER_KEY_VERSION } from '../../../packages/core/src/secrets/master-key.js';
import { SECRET_KEYS } from '../../../packages/core/src/secrets/types.js';
import type { SecretKey, SecretsService } from '../../../packages/core/src/secrets/types.js';

/** Exit code when nothing was written because a secret could not be decrypted. */
export const EXIT_ABORTED = 2;

/** Exit code when a partial rotation was fully rolled back onto the current key. */
export const EXIT_ROLLED_BACK = 3;

/** Exit code when rollback failed and the store is split across the old and the new key. */
export const EXIT_COMPENSATION_INCOMPLETE = 4;

/** Outcome of {@link rotateSecrets}. */
export interface RotateSecretsResult {
  /**
   * Number of secrets a completed rotation moved. `0` on every failure outcome, including the
   * one where rows are left under the new key — {@link RotateSecretsResult.strandedKeys} is what
   * reports those, and a caller must never read a `0` here as "the store is untouched".
   */
  rotated: number;
  /** Key version stamped on the stored envelopes; rotation never changes it. */
  keyVersion: number;
  /**
   * `0` success, {@link EXIT_ABORTED} aborted before any write,
   * {@link EXIT_ROLLED_BACK} rolled back after a partial write, and
   * {@link EXIT_COMPENSATION_INCOMPLETE} rollback itself failed — both keys are needed.
   */
  exitCode: 0 | typeof EXIT_ABORTED | typeof EXIT_ROLLED_BACK | typeof EXIT_COMPENSATION_INCOMPLETE;
  /**
   * Secrets left sealed under the new key by a failed rollback, in storage order. Empty on every
   * other outcome; non-empty only together with {@link EXIT_COMPENSATION_INCOMPLETE}.
   */
  strandedKeys: SecretKey[];
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
 * Writes every already-rotated secret back under the old key.
 *
 * @param serviceA - Service bound to the current (old) master key.
 * @param rotated - Secrets written under the new key, with their plaintext.
 * @returns The keys that could not be written back and are still sealed under the new key.
 */
async function compensate(
  serviceA: SecretsService,
  rotated: readonly [SecretKey, string][],
): Promise<SecretKey[]> {
  const stranded: SecretKey[] = [];
  for (const [key, plaintext] of rotated) {
    try {
      await serviceA.set(key, plaintext);
    } catch {
      stranded.push(key);
    }
  }
  return stranded;
}

/**
 * Reveals every stored secret under the current key into memory.
 *
 * Read-only: nothing is written, so an abort here leaves the store exactly as it was. The map is
 * cleared before the failure is reported, so a plaintext never outlives the attempt.
 *
 * @param service - Service bound to the current (old) master key.
 * @param log - Receives the abort line; never a plaintext value.
 * @returns The revealed plaintexts by key, or `null` when one of them could not be decrypted.
 */
async function revealAll(
  service: SecretsService,
  log: (line: string) => void,
): Promise<Map<SecretKey, string> | null> {
  const revealed = new Map<SecretKey, string>();
  for (const key of SECRET_KEYS) {
    try {
      // `reveal` itself distinguishes "nothing stored" (null, nothing to rotate) from a
      // decryption failure (throws) — no separate `status()` call is needed to tell them apart.
      const plaintext = await service.reveal(key);
      if (plaintext !== null) {
        revealed.set(key, plaintext);
      }
    } catch {
      revealed.clear();
      log(`abort: cannot decrypt ${key} with the current master key`);
      return null;
    }
  }
  return revealed;
}

/**
 * Re-encrypts every stored secret from the current master key to a new one.
 *
 * @param deps - Injected collaborators.
 * @returns How many secrets moved, the stored key version, the outcome code, and any secret left
 * under the new key by a failed rollback.
 */
export async function rotateSecrets(deps: RotateSecretsDeps): Promise<RotateSecretsResult> {
  const version = await currentKeyVersion(deps.repos.secrets);
  const serviceA = deps.createService(deps.oldKey, version);
  const serviceB = deps.createService(deps.newKey, version);

  const revealed = await revealAll(serviceA, deps.log);
  if (revealed === null) {
    return { rotated: 0, keyVersion: version, exitCode: EXIT_ABORTED, strandedKeys: [] };
  }

  try {
    const rotated: [SecretKey, string][] = [];
    try {
      for (const [key, plaintext] of revealed) {
        await serviceB.set(key, plaintext);
        rotated.push([key, plaintext]);
      }
    } catch {
      const strandedKeys = await compensate(serviceA, rotated);
      if (strandedKeys.length > 0) {
        deps.log(
          `rollback incomplete: ${strandedKeys.join(', ')} still sealed under the NEW key — keep both key files`,
        );
        return {
          rotated: 0,
          keyVersion: version,
          exitCode: EXIT_COMPENSATION_INCOMPLETE,
          strandedKeys,
        };
      }
      deps.log(`rolled back ${rotated.length} secret(s)`);
      return { rotated: 0, keyVersion: version, exitCode: EXIT_ROLLED_BACK, strandedKeys: [] };
    }

    deps.log(`rotated ${revealed.size} secret(s) under keyVersion ${version}`);
    return { rotated: revealed.size, keyVersion: version, exitCode: 0, strandedKeys: [] };
  } finally {
    revealed.clear();
  }
}
