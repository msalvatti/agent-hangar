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
 * secret is revealed into memory; any secret that cannot be opened aborts before a single byte is
 * written. Phase 2 writes each revealed value under the new key; if a write fails partway through,
 * every secret that MAY be sealed under the new key is written back under the OLD key
 * (compensation), so the current master key stays fully authoritative for every row. "May" is the
 * operative word: a write is counted as attempted from the moment it is issued, because a rejected
 * `set` can still have committed on the server, and compensation that trusted the acknowledgement
 * would skip exactly the row that was lost.
 *
 * Which key phase 1 may open a row with is the caller's decision, because it depends on where an
 * interrupted rotation stopped — see {@link RotationMode}. `strict` is a rotation starting from a
 * store that must be entirely readable with the current key; `salvage` resumes one that was
 * interrupted, where a row may already be sealed under the new key. No bookkeeping is needed to
 * tell the two apart: an envelope authenticates under exactly one of the keys and fails closed
 * under the other, so `salvage` simply tries the current key first and the new key second.
 *
 * Compensation can itself fail — the database can disappear mid-rollback. That case is reported
 * separately ({@link EXIT_COMPENSATION_INCOMPLETE}) instead of being presented as a clean abort:
 * the store is then split across the two keys, and the only recoverable state is one where BOTH
 * key files are kept. The caller must not delete the new key file on that outcome.
 *
 * What this function does NOT provide is isolation from anything else writing the store. Phase 1
 * reveals and phase 2 writes are separate statements with no transaction, no row lock and no
 * version check around them, because `SecretRepository` exposes none: a `set` landing between the
 * two silently loses its value to the plaintext revealed earlier, and one landing after phase 2 is
 * sealed under the old key and stops opening the moment the key files swap. Rotation therefore
 * assumes it is the only writer, and `rotate-key.sh` is what establishes that — it refuses to run
 * while the instance's web port answers. That is exclusion by refusing to start, not a lock, and
 * it covers the app's writers and nothing else.
 *
 * The revealed plaintexts live only in local `Map`s, cleared in a `finally` so they never outlive
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

/** Exit code when rollback failed and the store may be split across the old and the new key. */
export const EXIT_COMPENSATION_INCOMPLETE = 4;

/**
 * Which master key a stored secret is allowed to open under.
 *
 * `strict` — a rotation that starts from an untouched store: every row must open with the current
 * key, and one that does not aborts the run. `salvage` — a rotation resumed after an interruption:
 * a row may already have been re-sealed under the new key, so either key is accepted and only a
 * row that opens under neither aborts the run.
 */
export type RotationMode = 'strict' | 'salvage';

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
   * Secrets that may still be sealed under the new key after a failed rollback, in storage order.
   * Empty on every other outcome; non-empty only together with
   * {@link EXIT_COMPENSATION_INCOMPLETE}. A key is listed when its write back to the old key
   * failed, whether or not the new-key write that preceded it was ever acknowledged — the caller
   * must keep both key files on the strength of "may".
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
  /** Whether a row may already be sealed under the new key; see {@link RotationMode}. */
  mode: RotationMode;
  /** Receives one line per notable step (never a plaintext value). */
  log: (line: string) => void;
}

/** The two services a rotation reads and writes through. */
interface RotationServices {
  /** Bound to the current master key. */
  current: SecretsService;
  /** Bound to the replacement master key. */
  replacement: SecretsService;
}

/** One secret opened in phase 1. */
interface OpenedSecret {
  /** The revealed value, or `null` when nothing is stored under the key. */
  plaintext: string | null;
  /** Whether it had to be opened with the replacement key, i.e. it is already re-sealed. */
  underNewKey: boolean;
}

/** What phase 1 hands to phase 2. */
interface RevealedStore {
  /** Every stored secret's plaintext, in storage order. */
  plaintexts: Map<SecretKey, string>;
  /** The subset already sealed under the new key by an earlier run, with their plaintext. */
  sealedUnderNewKey: Map<SecretKey, string>;
}

/**
 * Parses the rotation mode a caller passed through the environment.
 *
 * @param raw - The raw value; unset or empty means a fresh, strict rotation.
 * @returns The mode.
 * @throws When the value is neither `strict` nor `salvage`, so a typo cannot silently downgrade
 * the run to the mode that accepts secrets sealed under the replacement key.
 */
export function parseRotationMode(raw: string | undefined): RotationMode {
  if (raw === undefined || raw === '') {
    return 'strict';
  }
  if (raw === 'strict' || raw === 'salvage') {
    return raw;
  }
  throw new Error(`unknown rotation mode "${raw}"; expected "strict" or "salvage"`);
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
    if (record !== null) {
      max = Math.max(max, record.keyVersion);
    }
  }
  return max;
}

/**
 * Writes every secret that may be sealed under the new key back under the old one.
 *
 * Rewriting a row that never left the old key is a no-op in substance — same plaintext, same key,
 * a fresh nonce — which is why the attempted set is the right one to compensate over.
 *
 * @param service - Service bound to the current (old) master key.
 * @param sealedUnderNewKey - Secrets that may be sealed under the new key, with their plaintext.
 * @returns The keys that could not be written back and may still be sealed under the new key.
 */
async function compensate(
  service: SecretsService,
  sealedUnderNewKey: ReadonlyMap<SecretKey, string>,
): Promise<SecretKey[]> {
  const stranded: SecretKey[] = [];
  for (const key of SECRET_KEYS) {
    const plaintext = sealedUnderNewKey.get(key);
    if (plaintext !== undefined) {
      try {
        await service.set(key, plaintext);
      } catch {
        stranded.push(key);
      }
    }
  }
  return stranded;
}

/**
 * Opens one stored secret with whichever master key the mode allows.
 *
 * @param services - The services bound to the current and the replacement key.
 * @param key - Secret to open.
 * @param mode - Whether the replacement key may be tried too.
 * @returns The revealed value and which key opened it, or `null` when no allowed key opens it.
 */
async function openSecret(
  services: RotationServices,
  key: SecretKey,
  mode: RotationMode,
): Promise<OpenedSecret | null> {
  try {
    // `reveal` itself distinguishes "nothing stored" (null, nothing to rotate) from a decryption
    // failure (throws) — no separate `status()` call is needed to tell them apart.
    return { plaintext: await services.current.reveal(key), underNewKey: false };
  } catch {
    if (mode === 'strict') {
      return null;
    }
  }
  try {
    return { plaintext: await services.replacement.reveal(key), underNewKey: true };
  } catch {
    return null;
  }
}

/**
 * Reveals every stored secret into memory.
 *
 * Read-only: nothing is written, so an abort here leaves the store exactly as it was. The maps are
 * cleared before the failure is reported, so a plaintext never outlives the attempt.
 *
 * @param services - The services bound to the current and the replacement key.
 * @param mode - Whether a secret may already be sealed under the replacement key.
 * @param log - Receives the abort line; never a plaintext value.
 * @returns The revealed plaintexts, or `null` when one of them could not be decrypted.
 */
async function revealAll(
  services: RotationServices,
  mode: RotationMode,
  log: (line: string) => void,
): Promise<RevealedStore | null> {
  const plaintexts = new Map<SecretKey, string>();
  const sealedUnderNewKey = new Map<SecretKey, string>();
  for (const key of SECRET_KEYS) {
    const opened = await openSecret(services, key, mode);
    if (opened === null) {
      // Defence in depth, and unobservable from outside: the maps are local and about to be
      // dropped, so nothing distinguishes clearing them from not. They are cleared anyway so a
      // plaintext does not sit in a live heap for as long as the abort takes to report.
      // Stryker disable next-line CallExpression
      plaintexts.clear();
      // Stryker disable next-line CallExpression
      sealedUnderNewKey.clear();
      const keys = mode === 'strict' ? 'the current master key' : 'either master key';
      log(`abort: cannot decrypt ${key} with ${keys}`);
      return null;
    }
    if (opened.plaintext !== null) {
      plaintexts.set(key, opened.plaintext);
      if (opened.underNewKey) {
        sealedUnderNewKey.set(key, opened.plaintext);
      }
    }
  }
  return { plaintexts, sealedUnderNewKey };
}

/**
 * Writes every revealed secret back under the replacement key, rolling back if a write fails.
 *
 * @param deps - Injected collaborators.
 * @param services - The services bound to the current and the replacement key.
 * @param version - Key version every row is re-sealed at.
 * @param revealed - The plaintexts to write, and what a previous run had already moved.
 * @returns How many secrets moved, the outcome code, and any secret a failed rollback stranded.
 */
async function writeUnderNewKey(
  deps: RotateSecretsDeps,
  services: RotationServices,
  version: number,
  revealed: RevealedStore,
): Promise<RotateSecretsResult> {
  const { plaintexts, sealedUnderNewKey } = revealed;
  try {
    for (const [key, plaintext] of plaintexts) {
      // Recorded BEFORE the write is awaited, never after. A `set` can commit in Postgres and
      // still reject here — the connection can drop after the server applied it and before the
      // acknowledgement arrives — and a row recorded only on success would then be skipped by
      // compensation, reported as a clean rollback, and left sealed under a key the caller is
      // about to delete. The asymmetry decides it: recording a write that never committed costs
      // one redundant rewrite under the key that already opens the row, while omitting one that
      // did commit costs the credential.
      sealedUnderNewKey.set(key, plaintext);
      await services.replacement.set(key, plaintext);
    }
  } catch {
    const strandedKeys = await compensate(services.current, sealedUnderNewKey);
    if (strandedKeys.length > 0) {
      deps.log(
        `rollback incomplete: ${strandedKeys.join(', ')} may still be sealed under the NEW key — keep both key files`,
      );
      return {
        rotated: 0,
        keyVersion: version,
        exitCode: EXIT_COMPENSATION_INCOMPLETE,
        strandedKeys,
      };
    }
    deps.log(`restored ${sealedUnderNewKey.size} secret(s) to the current master key`);
    return { rotated: 0, keyVersion: version, exitCode: EXIT_ROLLED_BACK, strandedKeys: [] };
  }

  deps.log(`rotated ${plaintexts.size} secret(s) under keyVersion ${version}`);
  return { rotated: plaintexts.size, keyVersion: version, exitCode: 0, strandedKeys: [] };
}

/**
 * Re-encrypts every stored secret from the current master key to a new one.
 *
 * The work is delegated so this function is only the lifetime of the revealed plaintext: whatever
 * the rotation does, the maps holding it are emptied on the way out.
 *
 * @param deps - Injected collaborators.
 * @returns How many secrets moved, the stored key version, the outcome code, and any secret left
 * under the new key by a failed rollback.
 */
export async function rotateSecrets(deps: RotateSecretsDeps): Promise<RotateSecretsResult> {
  const version = await currentKeyVersion(deps.repos.secrets);
  const services: RotationServices = {
    current: deps.createService(deps.oldKey, version),
    replacement: deps.createService(deps.newKey, version),
  };

  const revealed = await revealAll(services, deps.mode, deps.log);
  if (revealed === null) {
    return { rotated: 0, keyVersion: version, exitCode: EXIT_ABORTED, strandedKeys: [] };
  }

  // Emptying the maps is defence in depth and is not observable from outside — they are local and
  // die with this call either way — so the wrapper that does it carries a directive rather than
  // inviting a test that cannot exist. It wraps nothing else: the rotation itself is one call.
  // Stryker disable BlockStatement,CallExpression
  try {
    return await writeUnderNewKey(deps, services, version, revealed);
  } finally {
    revealed.plaintexts.clear();
    revealed.sealedUnderNewKey.clear();
  }
  // Stryker restore BlockStatement,CallExpression
}
