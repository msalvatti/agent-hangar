/**
 * Unit tests for the in-memory master key provider.
 *
 * Layer: unit.
 * Goal: `StaticMasterKey` hands back exactly the key it was given, stamps the right version, and
 * refuses key material that is not 32 bytes.
 * Mocks: none — the provider touches nothing.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../errors.js';

import { MASTER_KEY_BYTES, MASTER_KEY_VERSION, StaticMasterKey } from './master-key.js';

describe('StaticMasterKey', () => {
  /**
   * The provider is the test seam for every other secrets test, so it must return the exact bytes
   * it was constructed with and default to the current key version.
   */
  it('returns the supplied key with the default version', async () => {
    const key = Buffer.alloc(MASTER_KEY_BYTES, 7);

    const masterKey = await new StaticMasterKey(key).load();

    expect(masterKey.key.equals(key)).toBe(true);
    expect(masterKey.version).toBe(MASTER_KEY_VERSION);
  });

  /**
   * Rotation is modelled by the version number alone, so a caller-supplied version has to survive
   * untouched down to the envelope.
   */
  it('preserves a caller-supplied version', async () => {
    const masterKey = await new StaticMasterKey(Buffer.alloc(MASTER_KEY_BYTES), 2).load();

    expect(masterKey.version).toBe(2);
  });

  /**
   * Repeated loads must not allocate a new key: callers compare versions and reuse the buffer on
   * every encrypt and decrypt.
   */
  it('returns the same master key object on every load', async () => {
    const provider = new StaticMasterKey(Buffer.alloc(MASTER_KEY_BYTES));

    expect(await provider.load()).toBe(await provider.load());
  });

  /**
   * AES-256 needs exactly 32 bytes; a short or long key would otherwise fail deep inside
   * `node:crypto` with an opaque message, so it is rejected at construction.
   */
  it.each([0, MASTER_KEY_BYTES - 1, MASTER_KEY_BYTES + 1])(
    'rejects a key of %i bytes',
    (length) => {
      expect(() => new StaticMasterKey(Buffer.alloc(length))).toThrow(ConfigError);
    },
  );
});
