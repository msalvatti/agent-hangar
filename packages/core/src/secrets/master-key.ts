/**
 * Master key contracts: the AES-256 key every secret envelope is sealed with.
 *
 * Layer: service (port).
 *
 * A {@link MasterKeyProvider} is the only code allowed to materialise key bytes. Everything else
 * receives a {@link MasterKey} and hands it straight to `node:crypto`; the bytes are never
 * logged, serialised, or written anywhere but the key file itself.
 */
import { ConfigError } from '../errors.js';

/** Byte length of an AES-256 key. */
export const MASTER_KEY_BYTES = 32;

/** Version stamped on every envelope written with the current key; bumped on rotation. */
export const MASTER_KEY_VERSION = 1;

/** A 32-byte AES-256 key plus the version recorded on every envelope written with it. */
export interface MasterKey {
  /** Raw key material, exactly {@link MASTER_KEY_BYTES} bytes. */
  readonly key: Buffer;
  /** Value written to `Secret.keyVersion`, so a rotated key can be told apart. */
  readonly version: number;
}

/** Source of the master key. Implementations cache: `load` is called on every secret operation. */
export interface MasterKeyProvider {
  /** Returns the master key, materialising it on first call. */
  load(): Promise<MasterKey>;
}

/**
 * Provider over a caller-supplied key, for tests and for callers that already hold the bytes.
 *
 * Touches no filesystem, so a test never needs a temporary directory to exercise the secrets
 * service.
 */
export class StaticMasterKey implements MasterKeyProvider {
  private readonly masterKey: MasterKey;

  /**
   * @param key - Exactly {@link MASTER_KEY_BYTES} bytes of key material.
   * @param version - Version stamped on envelopes; defaults to {@link MASTER_KEY_VERSION}.
   * @throws ConfigError when `key` is not {@link MASTER_KEY_BYTES} bytes long.
   */
  constructor(key: Buffer, version: number = MASTER_KEY_VERSION) {
    if (key.length !== MASTER_KEY_BYTES) {
      throw new ConfigError(
        `Master key must be ${MASTER_KEY_BYTES} bytes, received ${key.length} bytes.`,
      );
    }
    this.masterKey = { key, version };
  }

  /**
   * Returns the key supplied to the constructor.
   *
   * @returns The master key; the same object on every call.
   */
  load(): Promise<MasterKey> {
    return Promise.resolve(this.masterKey);
  }
}
