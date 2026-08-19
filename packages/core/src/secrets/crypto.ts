/**
 * AES-256-GCM envelope encryption for stored credentials.
 *
 * Layer: utility (pure).
 *
 * Every write gets a fresh random initialisation vector, so encrypting the same credential twice
 * produces unrelated ciphertext, and every read verifies the GCM authentication tag before a
 * single plaintext byte is returned. Tampering with the ciphertext, the tag, the vector or the
 * key therefore fails closed with a {@link SecretIntegrityError}.
 *
 * No secret is ever compared here, so `crypto.timingSafeEqual` has nothing to guard: the tag
 * verification that decides authenticity happens in constant time inside OpenSSL.
 *
 * Failures never quote the envelope, the key or the plaintext — the message is a fixed string and
 * the underlying `node:crypto` error is attached as `cause`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { SecretIntegrityError } from '../errors.js';

import type { MasterKey } from './master-key.js';
import type { SecretEnvelope } from './types.js';

/** Cipher used for every envelope. */
export const ALGORITHM = 'aes-256-gcm';

/** Length of the per-write initialisation vector, the size GCM is defined for. */
export const IV_BYTES = 12;

/** Length of the GCM authentication tag. */
export const AUTH_TAG_BYTES = 16;

/** Number of plaintext characters kept for UI masking. */
export const LAST4_LENGTH = 4;

/**
 * The sealed part of a {@link SecretEnvelope}: everything except `last4`, which is a display
 * concern and plays no part in encryption.
 */
export type SealedSecret = Omit<SecretEnvelope, 'last4'>;

/**
 * Seals a credential under the master key.
 *
 * @param plaintext - Credential to encrypt; never logged, never returned.
 * @param masterKey - Key and version to seal with.
 * @returns A fresh envelope whose initialisation vector is unique to this call.
 */
export function encryptSecret(plaintext: string, masterKey: MasterKey): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: masterKey.version };
}

/**
 * Opens a sealed credential, verifying its authentication tag first.
 *
 * @param sealed - Envelope as stored, in any `Uint8Array` representation.
 * @param masterKey - Key the envelope was sealed with.
 * @returns The credential in plaintext.
 * @throws SecretIntegrityError when the envelope was written with another key version, is
 * malformed, or fails authentication.
 */
export function decryptSecret(sealed: SealedSecret, masterKey: MasterKey): string {
  if (sealed.keyVersion !== masterKey.version) {
    throw new SecretIntegrityError(
      `Stored secret was sealed with master key version ${sealed.keyVersion}, but the current key is version ${masterKey.version}.`,
    );
  }
  if (sealed.iv.length !== IV_BYTES || sealed.authTag.length !== AUTH_TAG_BYTES) {
    throw new SecretIntegrityError(
      'Stored secret envelope has an initialisation vector or authentication tag of the wrong length.',
    );
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey.key, sealed.iv);
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch (cause) {
    throw new SecretIntegrityError(undefined, { cause });
  }
}

/**
 * Extracts the masking hint shown in the UI.
 *
 * @param plaintext - Credential being stored.
 * @returns The last {@link LAST4_LENGTH} characters, or the whole value when it is shorter — the
 * UI still renders it behind a mask, and a credential that short is not a real one.
 */
export function last4(plaintext: string): string {
  return plaintext.slice(-LAST4_LENGTH);
}
