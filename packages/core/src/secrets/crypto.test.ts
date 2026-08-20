/**
 * Unit tests for the AES-256-GCM envelope functions.
 *
 * Layer: unit.
 * Goal: sealing is non-deterministic and reversible, and every way an envelope can be wrong —
 * tampered ciphertext, tampered tag, foreign key, malformed vector, stale key version — fails
 * closed with a `SecretIntegrityError` that quotes nothing.
 * Mocks: none; real `node:crypto` with keys built from `Buffer.alloc`.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AgentHangarError, SecretIntegrityError } from '../errors.ts';
import { assertNoCanary, GITHUB_CANARY, OPENAI_CANARY } from '../testing/canaries.ts';

import type { SealedSecret } from './crypto.ts';
import { AUTH_TAG_BYTES, IV_BYTES, decryptSecret, encryptSecret, last4 } from './crypto.ts';
import { MASTER_KEY_BYTES } from './master-key.ts';
import type { MasterKey } from './master-key.ts';

const masterKey: MasterKey = { key: Buffer.alloc(MASTER_KEY_BYTES, 1), version: 1 };
const CONTEXT = 'agent-hangar:secret:GITHUB_PAT';
const OTHER_CONTEXT = 'agent-hangar:secret:OPENAI_API_KEY';
const otherKey: MasterKey = { key: Buffer.alloc(MASTER_KEY_BYTES, 2), version: 1 };

/**
 * Copies an envelope with one byte of the named field flipped.
 *
 * @param sealed - Envelope to corrupt.
 * @param field - Which buffer to damage.
 * @returns A structurally valid envelope that must no longer authenticate.
 */
function withFlippedByte(sealed: SealedSecret, field: 'ciphertext' | 'authTag'): SealedSecret {
  const damaged = Buffer.from(sealed[field]);
  damaged.writeUInt8(damaged.readUInt8(0) ^ 0xff, 0);
  return field === 'ciphertext'
    ? { ...sealed, ciphertext: damaged }
    : { ...sealed, authTag: damaged };
}

describe('encryptSecret', () => {
  /**
   * The core promise of the envelope: whatever goes in comes back out unchanged, for both of the
   * credentials the app actually stores.
   */
  it.each([GITHUB_CANARY, OPENAI_CANARY])('round-trips a stored credential', (plaintext) => {
    expect(decryptSecret(encryptSecret(plaintext, masterKey, CONTEXT), masterKey, CONTEXT)).toBe(
      plaintext,
    );
  });

  /**
   * Credentials are encoded as UTF-8, so multi-byte characters must survive the round trip rather
   * than come back mangled.
   */
  it('round-trips a value with multi-byte characters', () => {
    const plaintext = 'clé-de-sécurité-🔐-記号';

    expect(decryptSecret(encryptSecret(plaintext, masterKey, CONTEXT), masterKey, CONTEXT)).toBe(
      plaintext,
    );
  });

  /**
   * Reusing an initialisation vector under the same key breaks GCM completely, so two writes of
   * the same value must share nothing but their length.
   */
  it('uses a fresh initialisation vector for every write', () => {
    const first = encryptSecret(GITHUB_CANARY, masterKey, CONTEXT);
    const second = encryptSecret(GITHUB_CANARY, masterKey, CONTEXT);

    expect(Buffer.from(first.iv).equals(second.iv)).toBe(false);
    expect(Buffer.from(first.ciphertext).equals(second.ciphertext)).toBe(false);
    expect(first.ciphertext).toHaveLength(second.ciphertext.length);
  });

  /**
   * The stored column widths and the decrypt guards both assume these sizes, and the key version
   * has to be recorded so a rotated key can be recognised.
   */
  it('produces a 12-byte vector, a 16-byte tag and the key version', () => {
    const sealed = encryptSecret(GITHUB_CANARY, { ...masterKey, version: 3 }, CONTEXT);

    expect(sealed.iv).toHaveLength(IV_BYTES);
    expect(sealed.authTag).toHaveLength(AUTH_TAG_BYTES);
    expect(sealed.keyVersion).toBe(3);
  });

  /**
   * The ciphertext is what reaches Postgres; if the plaintext were recoverable from it by simple
   * inspection the whole envelope would be pointless.
   */
  it('leaves no trace of the plaintext in the ciphertext', () => {
    const sealed = encryptSecret(GITHUB_CANARY, masterKey, CONTEXT);

    assertNoCanary(Buffer.from(sealed.ciphertext).toString('utf8'));
    assertNoCanary(Buffer.from(sealed.ciphertext).toString('hex'));
  });
});

describe('decryptSecret', () => {
  /**
   * A single flipped byte anywhere in the ciphertext must fail authentication rather than yield
   * a corrupted credential the worker would then inject into a container.
   */
  it('rejects a tampered ciphertext', () => {
    const sealed = withFlippedByte(encryptSecret(GITHUB_CANARY, masterKey, CONTEXT), 'ciphertext');

    expect(() => decryptSecret(sealed, masterKey, CONTEXT)).toThrow(SecretIntegrityError);
  });

  /**
   * The authentication tag is the only thing standing between a rewritten row and a forged
   * credential, so a damaged tag has to fail too.
   */
  it('rejects a tampered authentication tag', () => {
    const sealed = withFlippedByte(encryptSecret(GITHUB_CANARY, masterKey, CONTEXT), 'authTag');

    expect(() => decryptSecret(sealed, masterKey, CONTEXT)).toThrow(SecretIntegrityError);
  });

  /**
   * A database restored onto a machine with a different master key must refuse to open the rows
   * instead of returning noise.
   */
  it('rejects an envelope opened with a foreign key', () => {
    const sealed = encryptSecret(GITHUB_CANARY, masterKey, CONTEXT);

    expect(() => decryptSecret(sealed, otherKey, CONTEXT)).toThrow(SecretIntegrityError);
  });

  /**
   * A vector of the wrong length would otherwise reach OpenSSL and fail with an opaque message;
   * it is caught by an explicit guard so the caller always sees the domain error.
   */
  it('rejects an initialisation vector of the wrong length', () => {
    const sealed = {
      ...encryptSecret(GITHUB_CANARY, masterKey, CONTEXT),
      iv: randomBytes(IV_BYTES - 1),
    };

    expect(() => decryptSecret(sealed, masterKey, CONTEXT)).toThrow(SecretIntegrityError);
  });

  /**
   * Same guard for the tag: a truncated tag weakens authentication, so it is refused outright.
   */
  it('rejects an authentication tag of the wrong length', () => {
    const sealed = {
      ...encryptSecret(GITHUB_CANARY, masterKey, CONTEXT),
      authTag: randomBytes(AUTH_TAG_BYTES - 1),
    };

    expect(() => decryptSecret(sealed, masterKey, CONTEXT)).toThrow(SecretIntegrityError);
  });

  /**
   * Key rotation is recorded per envelope; a row written under an older key must say so, naming
   * both versions, rather than fail as generic corruption.
   */
  it('rejects an envelope written under another key version', () => {
    const sealed = { ...encryptSecret(GITHUB_CANARY, masterKey, CONTEXT), keyVersion: 2 };

    expect(() => decryptSecret(sealed, masterKey, CONTEXT)).toThrow(/version 2.*version 1/);
    expect(() => decryptSecret(sealed, masterKey, CONTEXT)).toThrow(SecretIntegrityError);
  });

  /**
   * The failure is a typed domain error the API layer can map to a response code, and its message
   * is a fixed string: neither the credential nor the envelope may appear in it.
   */
  it('reports a fixed message and the shared error code', () => {
    const sealed = withFlippedByte(encryptSecret(OPENAI_CANARY, masterKey, CONTEXT), 'ciphertext');
    let caught: unknown;

    try {
      decryptSecret(sealed, masterKey, CONTEXT);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentHangarError);
    expect((caught as SecretIntegrityError).code).toBe('SECRET_INTEGRITY');
    expect((caught as SecretIntegrityError).message).toBe(
      'Stored secret failed integrity verification.',
    );
    expect((caught as SecretIntegrityError).cause).toBeInstanceOf(Error);
    assertNoCanary(String((caught as SecretIntegrityError).stack));
  });
  /**
   * The context is authenticated, not encrypted: an envelope lifted out of one row and dropped
   * into another still authenticates under the same master key, so only this binding stops
   * `reveal` from handing back the wrong credential.
   */
  it('refuses an envelope opened under another context', () => {
    const sealed = encryptSecret(GITHUB_CANARY, masterKey, CONTEXT);

    expect(() => decryptSecret(sealed, masterKey, OTHER_CONTEXT)).toThrow(SecretIntegrityError);
  });

  /**
   * The binding must be exact rather than a prefix check, or a row name that extends another
   * would open its neighbour's envelope.
   */
  it('refuses an envelope opened under a context that merely extends the original', () => {
    const sealed = encryptSecret(GITHUB_CANARY, masterKey, CONTEXT);

    expect(() => decryptSecret(sealed, masterKey, `${CONTEXT}_2`)).toThrow(SecretIntegrityError);
  });
});

describe('last4', () => {
  /**
   * The UI masks everything but the tail; a value shorter than the tail simply yields itself, and
   * an empty value yields nothing at all.
   */
  it.each([
    ['', ''],
    ['abc', 'abc'],
    ['abcd', 'abcd'],
    ['abcde', 'bcde'],
  ])('maps %s to %s', (plaintext, expected) => {
    expect(last4(plaintext)).toBe(expected);
  });
});
