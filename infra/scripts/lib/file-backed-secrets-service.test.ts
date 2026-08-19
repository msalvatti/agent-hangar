/**
 * Unit tests for `createFileBackedSecretsService`.
 *
 * Layer: unit.
 * Goal: a present, readable master key yields a working service (round-trips a value through the
 * real AES-256-GCM implementation), and a missing key throws before any repository call.
 * Mocks: none — a real temp key file and the real in-memory `SecretRepository`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('createFileBackedSecretsService', () => {
  /**
   * A present, readable key file yields a service that can set and read back a value.
   */
  it('round-trips a value through the real master key file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-svc-'));
    dirs.push(dir);
    const keyPath = join(dir, 'master.key');
    writeFileSync(keyPath, `${'ab'.repeat(32)}\n`, { mode: 0o600 });

    const { secrets } = createInMemoryRepositories();
    const service = createFileBackedSecretsService(secrets, keyPath);
    await service.set('GITHUB_PAT', 'a-value');
    expect(await service.reveal('GITHUB_PAT')).toBe('a-value');
  });

  /**
   * A missing key file throws before touching the repository.
   */
  it('throws when the master key file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-svc-'));
    dirs.push(dir);
    const { secrets } = createInMemoryRepositories();
    expect(() => createFileBackedSecretsService(secrets, join(dir, 'absent.key'))).toThrow();
  });
});
