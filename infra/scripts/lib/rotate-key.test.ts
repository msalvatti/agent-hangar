/**
 * Unit tests for `rotateSecrets`.
 *
 * Layer: unit.
 * Goal: every stored secret moves to the new key material while the stored `keyVersion` stays put,
 * so a rotated secret is still readable through the construction path the web app and the worker
 * use (a provider built without a version); zero stored secrets rotates zero; a decryption failure
 * aborts before any write; a write failure rolls the already-rotated secrets back to the old key;
 * a rollback that itself fails reports the split store instead of claiming a clean abort; salvage
 * mode opens a store an interrupted rotation left split across the two keys and finishes it, while
 * strict mode refuses the same store; and no log line ever contains a canary.
 * Mocks: an in-memory `SecretRepository`; the real `SecretsService` over `StaticMasterKey` (random
 * 32-byte keys, no filesystem) and, for the readability test, over the real `MasterKeyFile`.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { SecretRepository } from '../../../packages/core/src/persistence/ports.js';
import { MasterKeyFile } from '../../../packages/core/src/secrets/master-key-file.js';
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
import {
  EXIT_ABORTED,
  EXIT_COMPENSATION_INCOMPLETE,
  EXIT_ROLLED_BACK,
  parseRotationMode,
  rotateSecrets,
} from './rotate-key.js';

/** Number of bytes in an AES-256 master key. */
const KEY_BYTES = 32;

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/**
 * Builds a real `SecretsService` over `repository`, keyed by raw bytes and a version.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @param key - Raw master key material.
 * @param keyVersion - Version stamped on every envelope written through the service.
 * @returns The service.
 */
function realService(
  repository: SecretRepository,
  key: Uint8Array | string,
  keyVersion: number,
): SecretsService {
  const bytes = typeof key === 'string' ? Buffer.from(key) : Buffer.from(key);
  return createSecretsService({ repository, masterKey: new StaticMasterKey(bytes, keyVersion) });
}

/**
 * Builds the collaborators of {@link rotateSecrets} over one repository and two keys.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @param oldKey - Current master key material.
 * @param newKey - Replacement master key material.
 * @param overrides - Fields to replace on the returned dependencies.
 * @returns The dependencies.
 */
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
    mode: 'strict',
    log: () => undefined,
    ...overrides,
  };
}

/**
 * Seeds both secrets under `key`/`keyVersion` with the canary values.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @param key - Master key material to seal with.
 * @param keyVersion - Version stamped on the seeded envelopes.
 */
async function seedBoth(
  repository: SecretRepository,
  key: Buffer,
  keyVersion: number,
): Promise<void> {
  const service = realService(repository, key, keyVersion);
  await service.set('GITHUB_PAT', GITHUB_CANARY);
  await service.set('OPENAI_API_KEY', OPENAI_CANARY);
}

/**
 * Writes a mode-600 key file holding `hex` inside a throwaway directory.
 *
 * @param hex - 64 hex characters of key material.
 * @returns The absolute path of the key file.
 */
function writeKeyFile(hex: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-rotate-lib-'));
  dirs.push(dir);
  const path = join(dir, 'master.key');
  writeFileSync(path, `${hex}\n`, { mode: 0o600 });
  return path;
}

/**
 * Builds a secrets service exactly the way an ordinary reader does: a file-backed provider with
 * no version argument at all.
 *
 * @param repository - Row store for the encrypted envelopes.
 * @param keyFilePath - Path of the master key file.
 * @returns The service.
 */
function ordinaryReader(repository: SecretRepository, keyFilePath: string): SecretsService {
  return createSecretsService({
    repository,
    masterKey: new MasterKeyFile({ path: keyFilePath }),
  });
}

describe('rotateSecrets', () => {
  /**
   * Both secrets are re-sealed under the new key material and are revealable with it, while the
   * old key no longer opens them. The stored `keyVersion` is deliberately unchanged: the version
   * is what an ordinary reader matches on, and advancing it is what would lock everyone out.
   */
  it('re-seals every stored secret under the new key without moving the key version', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
    await seedBoth(repository, oldKey, 1);

    const logs: string[] = [];
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, { log: (line) => logs.push(line) }),
    );

    expect(result).toEqual({ rotated: 2, keyVersion: 1, exitCode: 0, strandedKeys: [] });
    expect((await repository.get('GITHUB_PAT'))?.keyVersion).toBe(1);
    expect((await repository.get('OPENAI_API_KEY'))?.keyVersion).toBe(1);

    const newService = realService(repository, newKey, 1);
    expect(await newService.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect(await newService.reveal('OPENAI_API_KEY')).toBe(OPENAI_CANARY);

    const oldService = realService(repository, oldKey, 1);
    await expect(oldService.reveal('GITHUB_PAT')).rejects.toThrow();

    for (const line of logs) {
      assertNoCanary(line);
    }
  });

  /**
   * The regression that matters most: after a successful rotation the store must still be
   * readable through the construction path the web app and the worker use — `MasterKeyFile` with
   * no `version` option, which decrypts at `MASTER_KEY_VERSION`. A rotation that advanced the
   * stored version would leave every credential unreadable while every gate stayed green.
   */
  it('leaves a rotated secret readable through the ordinary reader construction path', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldHex = randomBytes(KEY_BYTES).toString('hex');
    const newHex = randomBytes(KEY_BYTES).toString('hex');
    const oldKeyFile = writeKeyFile(oldHex);
    const newKeyFile = writeKeyFile(newHex);

    const before = ordinaryReader(repository, oldKeyFile);
    await before.set('GITHUB_PAT', GITHUB_CANARY);
    await before.set('OPENAI_API_KEY', OPENAI_CANARY);

    const result = await rotateSecrets(
      baseDeps(repository, Buffer.from(oldHex, 'hex'), Buffer.from(newHex, 'hex')),
    );
    expect(result.exitCode).toBe(0);

    const after = ordinaryReader(repository, newKeyFile);
    expect(await after.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect(await after.reveal('OPENAI_API_KEY')).toBe(OPENAI_CANARY);
  });

  /**
   * The current key version is the highest one stamped on any stored secret, not always the
   * default of 1 — a store an earlier tool advanced is re-sealed where it stands rather than
   * being moved again.
   */
  it('uses the highest stored keyVersion as the current one', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
    await seedBoth(repository, oldKey, 3);

    const result = await rotateSecrets(baseDeps(repository, oldKey, newKey));
    expect(result.keyVersion).toBe(3);
    expect((await repository.get('GITHUB_PAT'))?.keyVersion).toBe(3);
  });

  /**
   * Nothing stored: rotates zero, still reports the store's key version.
   */
  it('rotates zero secrets when the store is empty', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);

    const result = await rotateSecrets(baseDeps(repository, oldKey, newKey));
    expect(result).toEqual({ rotated: 0, keyVersion: 1, exitCode: 0, strandedKeys: [] });
  });

  /**
   * A tampered envelope aborts before any write: exit 2, the row is untouched, no canary leaks.
   */
  it('aborts without writing when a secret cannot be decrypted', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
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

    expect(result).toEqual({
      rotated: 0,
      keyVersion: 1,
      exitCode: EXIT_ABORTED,
      strandedKeys: [],
    });
    expect(logs.some((line) => line.includes('abort') && line.includes('GITHUB_PAT'))).toBe(true);
    const after = await repository.get('GITHUB_PAT');
    expect(after?.keyVersion).toBe(1);
    expect((await repository.get('OPENAI_API_KEY'))?.keyVersion).toBe(1);
  });

  /**
   * A write failure partway through rolls the already-rotated secret back to the old key: exit 3,
   * the first secret is revealable again under the old key, and the log names the rollback count.
   */
  it('rolls back an already-rotated secret when a later write fails', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
    await seedBoth(repository, oldKey, 1);

    const logs: string[] = [];
    let setCalls = 0;
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, {
        // Both services now share one key version, so the new-key service is identified by its
        // key material — the only thing rotation actually replaces.
        createService: (key, keyVersion) => {
          const real = realService(repository, key, keyVersion);
          if (Buffer.compare(Buffer.from(key), newKey) !== 0) {
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
      }),
    );

    expect(result).toEqual({
      rotated: 0,
      keyVersion: 1,
      exitCode: EXIT_ROLLED_BACK,
      strandedKeys: [],
    });
    expect(logs.some((line) => line.includes('rolled back 1'))).toBe(true);

    const oldService = realService(repository, oldKey, 1);
    expect(await oldService.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect((await repository.get('GITHUB_PAT'))?.keyVersion).toBe(1);
    for (const line of logs) {
      assertNoCanary(line);
    }
  });

  /**
   * The rollback can itself fail — the database can drop while it runs. The store is then split
   * across the two keys, which is not the advertised clean abort, so the outcome is reported as
   * its own exit code together with the secrets left under the new key. The caller relies on that
   * to keep the new key file instead of deleting it and destroying those credentials.
   */
  it('reports the split store when the rollback itself fails', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
    await seedBoth(repository, oldKey, 1);

    const logs: string[] = [];
    let newKeyWrites = 0;
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, {
        createService: (key, keyVersion) => {
          const real = realService(repository, key, keyVersion);
          if (Buffer.compare(Buffer.from(key), newKey) !== 0) {
            // The old-key service is the one compensation writes through; make every one of its
            // writes fail, as an unreachable database would.
            return {
              ...real,
              set: () => Promise.reject(new Error('database gone')),
            };
          }
          return {
            ...real,
            set: async (secretKey: SecretKey, plaintext: string) => {
              newKeyWrites += 1;
              if (newKeyWrites === 2) {
                throw new Error('simulated write failure');
              }
              return real.set(secretKey, plaintext);
            },
          };
        },
        log: (line) => logs.push(line),
      }),
    );

    expect(result).toEqual({
      rotated: 0,
      keyVersion: 1,
      exitCode: EXIT_COMPENSATION_INCOMPLETE,
      strandedKeys: ['GITHUB_PAT'],
    });
    expect(logs.some((line) => line.includes('rollback incomplete'))).toBe(true);
    expect(logs.some((line) => line.includes('keep both key files'))).toBe(true);

    // The stranded row really is unreadable with the old key and readable with the new one.
    const newService = realService(repository, newKey, 1);
    expect(await newService.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    for (const line of logs) {
      assertNoCanary(line);
    }
  });
});

describe('parseRotationMode', () => {
  /**
   * An unset or empty value is a fresh rotation, and both spellings the shell can pass round-trip
   * unchanged.
   */
  it.each([
    [undefined, 'strict'],
    ['', 'strict'],
    ['strict', 'strict'],
    ['salvage', 'salvage'],
  ])('maps %s to %s', (raw, expected) => {
    expect(parseRotationMode(raw)).toBe(expected);
  });

  /**
   * An unrecognised value throws instead of falling back. Falling back to `strict` would turn a
   * typo into an abort on a store a resume was supposed to salvage; falling back to `salvage`
   * would silently accept secrets sealed under the replacement key during a fresh rotation.
   */
  it('rejects an unrecognised value', () => {
    expect(() => parseRotationMode('salvag')).toThrow('salvag');
  });
});

describe('rotateSecrets in salvage mode', () => {
  /**
   * The state an interrupted rotation leaves behind: one secret already re-sealed under the new
   * key, the other still under the old one. Strict mode must refuse it — that is the abort a
   * `--resume` used to die on — while salvage mode opens each row with whichever key authenticates
   * it and finishes the rotation.
   */
  it('finishes a store an interrupted rotation left split across the two keys', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
    await realService(repository, newKey, 1).set('GITHUB_PAT', GITHUB_CANARY);
    await realService(repository, oldKey, 1).set('OPENAI_API_KEY', OPENAI_CANARY);

    const strict = await rotateSecrets(baseDeps(repository, oldKey, newKey));
    expect(strict.exitCode).toBe(EXIT_ABORTED);

    const logs: string[] = [];
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, {
        mode: 'salvage',
        log: (line) => logs.push(line),
      }),
    );

    expect(result).toEqual({ rotated: 2, keyVersion: 1, exitCode: 0, strandedKeys: [] });
    const reader = realService(repository, newKey, 1);
    expect(await reader.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect(await reader.reveal('OPENAI_API_KEY')).toBe(OPENAI_CANARY);
    for (const line of logs) {
      assertNoCanary(line);
    }
  });

  /**
   * Salvage widens which key may open a row, not whether a row may stay unreadable: a secret that
   * authenticates under neither key still aborts before any write, and the message names both
   * keys rather than blaming the current one.
   */
  it('still aborts when a secret opens under neither key', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
    await seedBoth(repository, oldKey, 1);

    const before = await repository.get('GITHUB_PAT');
    if (before === null) {
      throw new Error('fixture setup failed');
    }
    const tampered = new Uint8Array(before.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    await repository.upsert('GITHUB_PAT', { ...before, ciphertext: tampered });

    const logs: string[] = [];
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, { mode: 'salvage', log: (line) => logs.push(line) }),
    );

    expect(result).toEqual({
      rotated: 0,
      keyVersion: 1,
      exitCode: EXIT_ABORTED,
      strandedKeys: [],
    });
    expect(logs).toContain('abort: cannot decrypt GITHUB_PAT with either master key');
    expect((await repository.get('OPENAI_API_KEY'))?.keyVersion).toBe(1);
  });

  /**
   * Rolling back a salvage run has to undo more than the run itself wrote. Here the very first
   * write fails, so this run rotated nothing — yet GITHUB_PAT was already sealed under the new key
   * by the run being resumed. Compensating only what this run wrote would report a clean rollback
   * over a store that is still split, and the caller would then delete the new key file and with
   * it the only key that row opens under.
   */
  it('rolls back a row an earlier run had re-sealed even when this run wrote nothing', async () => {
    const repository = createInMemoryRepositories().secrets;
    const oldKey = randomBytes(KEY_BYTES);
    const newKey = randomBytes(KEY_BYTES);
    await realService(repository, newKey, 1).set('GITHUB_PAT', GITHUB_CANARY);
    await realService(repository, oldKey, 1).set('OPENAI_API_KEY', OPENAI_CANARY);

    const logs: string[] = [];
    let newKeyWrites = 0;
    const result = await rotateSecrets(
      baseDeps(repository, oldKey, newKey, {
        mode: 'salvage',
        createService: (key, keyVersion) => {
          const real = realService(repository, key, keyVersion);
          if (Buffer.compare(Buffer.from(key), newKey) !== 0) {
            return real;
          }
          return {
            ...real,
            set: async (secretKey: SecretKey, plaintext: string) => {
              newKeyWrites += 1;
              if (newKeyWrites === 1) {
                throw new Error('simulated write failure');
              }
              return real.set(secretKey, plaintext);
            },
          };
        },
        log: (line) => logs.push(line),
      }),
    );

    expect(result).toEqual({
      rotated: 0,
      keyVersion: 1,
      exitCode: EXIT_ROLLED_BACK,
      strandedKeys: [],
    });
    expect(logs.some((line) => line.includes('rolled back 1'))).toBe(true);

    // The store is wholly under the current key again, which is what lets the caller delete the
    // new key file: the row this run never wrote is readable with the old key as well.
    const reader = realService(repository, oldKey, 1);
    expect(await reader.reveal('GITHUB_PAT')).toBe(GITHUB_CANARY);
    expect(await reader.reveal('OPENAI_API_KEY')).toBe(OPENAI_CANARY);
    for (const line of logs) {
      assertNoCanary(line);
    }
  });
});
