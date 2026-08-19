/**
 * Unit tests for `rotateSecrets`.
 *
 * Layer: unit.
 * Goal: both secrets move to `keyVersion + 1` and are revealable under the new key but not the
 * old one, zero stored secrets rotates zero, a decryption failure aborts before any write, a
 * write failure rolls the already-rotated secrets back to the old key, and no log line ever
 * contains a canary.
 * Mocks: an in-memory `SecretRepository`; the real `SecretsService`/`StaticMasterKey` over random
 * 32-byte keys (no filesystem).
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import { StaticMasterKey } from '../../../packages/core/src/secrets/master-key.js';
import { createSecretsService } from '../../../packages/core/src/secrets/secrets-service.js';
import type { SecretKey, SecretsService } from '../../../packages/core/src/secrets/types.js';
import {
  GITHUB_CANARY,
  OPENAI_CANARY,
  assertNoCanary,
} from '../../../packages/core/src/testing/canaries.js';
import { createInMemoryRepositories } from '../../../packages/core/src/testing/in-memory-repositories.js';

import type { RotateSecretsDeps } from './rotate-key.js';
import { rotateSecrets } from './rotate-key.js';

/** Builds a real `SecretsService` over `repository`, keyed by raw bytes and a version. */
function realService(
  repository: SecretRepository,
  key: Uint8Array | string,
  keyVersion: number,
): SecretsService {
  const bytes = typeof key === 'string' ? Buffer.from(key) : Buffer.from(key);
  return createSecretsService({ repository, masterKey: new StaticMasterKey(bytes, keyVersion) });
}

function baseDeps(
  repository: SecretRepository,
  oldKey: Buffer,
  newKey: Buffer,
  overrides: Partial<RotateSecretsDeps> = {},
): RotateSecretsDeps {
  return {
    repos: { secrets: repository },
    createService: (key, keyVersion) => realService(repository, key, keyVersion),
    oldKey,
    newKey,
    log: () => undefined,
    ...overrides,
  };
}

/** Seeds both secrets under `key`/`keyVersion` with the canary values. */
async function seedBoth(
  repository: SecretRepository,
  key: Buffer,
  keyVersion: number,
): Promise<void> {
  const service = realService(repository, key, keyVersion);
  await service.set('GITHUB_PAT', GITHUB_CANARY);
  await service.set('OPENAI_API_KEY', OPENAI_CANARY);
}

describe('rotateSecrets', () => {
  /**
   * Both secrets move to keyVersion 2, are revealable under the new key, and the old key can no
   * longer decrypt the rotated envelopes.
   */
  it('rotates every stored secret to the next key version', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    await seedBoth(repository, oldKey, 1);

    const logs: string[] = [];
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, { log: (line) => logs.push(line) }),
    );

    expect(result).toEqual({ rotated: 2, keyVersion: 2, exitCode: 0 });
    expect((await repository.get('GITHUB_PAT'))?.keyVersion).toBe(2);
    expect((await repository.get('OPENAI_API_KEY'))?.keyVersion).toBe(2);

    const newService = realService(repository, newKey, 2);
    expect(await newService.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect(await newService.reveal('OPENAI_API_KEY')).toBe(OPENAI_CANARY);

    const oldService = realService(repository, oldKey, 1);
    await expect(oldService.reveal('GITHUB_PAT')).rejects.toThrow();

    for (const line of logs) {
      assertNoCanary(line);
    }
  });

  /**
   * The current key version is the highest one stamped on any stored secret, not always the
   * default of 1 — a previous rotation may already have advanced the store further.
   */
  it('uses the highest stored keyVersion as the current one', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    await seedBoth(repository, oldKey, 3);

    const result = await rotateSecrets(baseDeps(repository, oldKey, newKey));
    expect(result.keyVersion).toBe(4);
    expect((await repository.get('GITHUB_PAT'))?.keyVersion).toBe(4);
  });

  /**
   * Nothing stored: rotates zero, still reports the next key version.
   */
  it('rotates zero secrets when the store is empty', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);

    const result = await rotateSecrets(baseDeps(repository, oldKey, newKey));
    expect(result).toEqual({ rotated: 0, keyVersion: 2, exitCode: 0 });
  });

  /**
   * A tampered envelope aborts before any write: exit 2, the row is untouched, no canary leaks.
   */
  it('aborts without writing when a secret cannot be decrypted', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    await seedBoth(repository, oldKey, 1);

    const before = await repository.get('GITHUB_PAT');
    if (before === null) {
      throw new Error('fixture setup failed');
    }
    // Flip one ciphertext byte to simulate tampering / a wrong current key.
    const tampered = new Uint8Array(before.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await repository.upsert('GITHUB_PAT', { ...before, ciphertext: tampered });

    const logs: string[] = [];
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, { log: (line) => logs.push(line) }),
    );

    expect(result).toEqual({ rotated: 0, keyVersion: 1, exitCode: 2 });
    expect(logs.some((line) => line.includes('abort') && line.includes('GITHUB_PAT'))).toBe(true);
    const after = await repository.get('GITHUB_PAT');
    expect(after?.keyVersion).toBe(1);
    expect((await repository.get('OPENAI_API_KEY'))?.keyVersion).toBe(1);
  });

  /**
   * A write failure partway through rolls the already-rotated secret back to the old key: exit 3,
   * the first key is revealable again under the old key, and the log names the rollback count.
   */
  it('rolls back an already-rotated secret when a later write fails', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    await seedBoth(repository, oldKey, 1);

    let setCalls = 0;
    const deps = baseDeps(repository, oldKey, newKey, {
      createService: (key, keyVersion) => {
        const real = realService(repository, key, keyVersion);
        if (keyVersion === 1) {
          return real;
        }
        return {
          ...real,
          set: async (secretKey: SecretKey, plaintext: string) => {
            setCalls += 1;
            if (setCalls === 2) {
              throw new Error('simulated write failure');
            }
            return real.set(secretKey, plaintext);
          },
        };
      },
      log: (line) => logs.push(line),
    });
    const logs: string[] = [];

    const result = await rotateSecrets(deps);
    expect(result).toEqual({ rotated: 0, keyVersion: 1, exitCode: 3 });
    expect(logs.some((line) => line.includes('rolled back 1'))).toBe(true);

    const oldService = realService(repository, oldKey, 1);
    expect(await oldService.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect((await repository.get('GITHUB_PAT'))?.keyVersion).toBe(1);
    for (const line of logs) {
      assertNoCanary(line);
    }
  });
});
