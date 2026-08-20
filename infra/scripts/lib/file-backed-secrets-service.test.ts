/**
 * Unit tests for `createFileBackedSecretsService`.
 *
 * Layer: unit.
 * Goal: a present, readable, well-formed master key yields a working service (round-trips a value
 * through the real AES-256-GCM implementation); a missing key rejects before any repository call;
 * and a key file the real readers would refuse — malformed contents, a symbolic link — is refused
 * here too instead of producing a service that reports a healthy store.
 * Mocks: none — real temp key files and the real in-memory `SecretRepository`.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createInMemoryRepositories } from '../../../packages/core/src/testing/in-memory-repositories.js';

import { createFileBackedSecretsService } from './file-backed-secrets-service.js';

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
 * Creates a throwaway directory that is removed after the test.
 *
 * @returns Its absolute path.
 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-svc-'));
  dirs.push(dir);
  return dir;
}

describe('createFileBackedSecretsService', () => {
  /**
   * A present, readable key file yields a service that can set and read back a value.
   */
  it('round-trips a value through the real master key file', async () => {
    const dir = tempDir();
    const keyPath = join(dir, 'master.key');
    writeFileSync(keyPath, `${'ab'.repeat(32)}\n`, { mode: 0o600 });

    const { secrets } = createInMemoryRepositories();
    const service = await createFileBackedSecretsService(secrets, keyPath);
    await service.set('GITHUB_PAT', 'a-value');
    expect(await service.reveal('GITHUB_PAT')).toBe('a-value');
  });

  /**
   * A missing key file rejects before touching the repository. The readability probe has to run
   * before the provider is built, because the provider would otherwise mint a fresh key and the
   * check would report a healthy store whose every secret had just become undecryptable.
   */
  it('rejects when the master key file is missing', async () => {
    const dir = tempDir();
    await expect(
      createFileBackedSecretsService(createInMemoryRepositories().secrets, join(dir, 'absent.key')),
    ).rejects.toThrow();
  });

  /**
   * Contents that are not 64 hex characters are readable, so a readability probe alone would call
   * the store healthy; `MasterKeyFile.load()` refuses them, and this factory must surface that
   * refusal rather than hand back a service that fails only once something decrypts.
   */
  it('rejects a readable key file whose contents are malformed', async () => {
    const dir = tempDir();
    const keyPath = join(dir, 'master.key');
    writeFileSync(keyPath, 'not-a-key\n', { mode: 0o600 });

    await expect(
      createFileBackedSecretsService(createInMemoryRepositories().secrets, keyPath),
    ).rejects.toThrow(/64 hex characters/);
  });

  /**
   * A symbolic link is readable through its target, so the readability probe passes; the real
   * readers open the path with `O_NOFOLLOW` and refuse it, and so must this factory.
   */
  it('rejects a key file that is a symbolic link', async () => {
    const dir = tempDir();
    const target = join(dir, 'elsewhere.key');
    writeFileSync(target, `${'ab'.repeat(32)}\n`, { mode: 0o600 });
    const keyPath = join(dir, 'master.key');
    symlinkSync(target, keyPath);

    await expect(
      createFileBackedSecretsService(createInMemoryRepositories().secrets, keyPath),
    ).rejects.toThrow(/symbolic link/);
  });
});
