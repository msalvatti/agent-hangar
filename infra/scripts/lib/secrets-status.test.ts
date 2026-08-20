/**
 * Unit tests for `secretsStatus`.
 *
 * Layer: unit.
 * Goal: unset/set status lines (masked to the last four characters, never the plaintext), an
 * unreachable database exits 3, a missing master key exits 4, and no canary ever reaches the
 * printed lines.
 * Mocks: an in-memory `SecretRepository` and the real `SecretsService` over a temp key file.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GITHUB_CANARY, assertNoCanary } from '../../../packages/core/src/testing/canaries.js';
import { createInMemoryRepositories } from '../../../packages/core/src/testing/in-memory-repositories.js';

import { createFileBackedSecretsService } from './file-backed-secrets-service.js';
import {
  DB_UNREACHABLE_MESSAGE,
  EXIT_DB_UNREACHABLE,
  EXIT_MASTER_KEY_MISSING,
  MASTER_KEY_MISSING_MESSAGE,
  secretsStatus,
} from './secrets-status.js';
import type { SecretsStatusDeps } from './secrets-status.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempKeyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-status-'));
  dirs.push(dir);
  const keyPath = join(dir, 'master.key');
  writeFileSync(keyPath, `${'cd'.repeat(32)}\n`, { mode: 0o600 });
  return keyPath;
}

function baseDeps(overrides: Partial<SecretsStatusDeps> = {}): SecretsStatusDeps {
  return {
    env: {},
    loadConfig: () => ({ DATABASE_URL: 'unused', MASTER_KEY_PATH: tempKeyPath() }),
    createDatabaseClient: () => ({}),
    assertDatabaseReachable: () => Promise.resolve(),
    createSecretRepository: () => createInMemoryRepositories().secrets,
    createSecretsService: createFileBackedSecretsService,
    ...overrides,
  };
}

describe('secretsStatus', () => {
  /**
   * Neither key stored: both lines report `unset`, exit 0.
   */
  it('reports both keys unset on a fresh store', async () => {
    const result = await secretsStatus(baseDeps());
    expect(result).toEqual({
      lines: ['GITHUB_PAT=unset', 'OPENAI_API_KEY=unset'],
      exitCode: 0,
    });
  });

  /**
   * A stored key reports `set:<last4>` and never the plaintext or the canary.
   */
  it('reports a stored key masked to its last four characters', async () => {
    const repository = createInMemoryRepositories().secrets;
    const keyPath = tempKeyPath();
    const service = await createFileBackedSecretsService(repository, keyPath);
    await service.set('GITHUB_PAT', GITHUB_CANARY);

    const result = await secretsStatus(
      baseDeps({
        loadConfig: () => ({ DATABASE_URL: 'unused', MASTER_KEY_PATH: keyPath }),
        createSecretRepository: () => repository,
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines[0]).toBe(`GITHUB_PAT=set:${GITHUB_CANARY.slice(-4)}`);
    expect(result.lines[1]).toBe('OPENAI_API_KEY=unset');
    for (const line of result.lines) {
      assertNoCanary(line);
    }
  });

  /**
   * An unreachable database exits 3 with the documented message, before any repository call.
   */
  it('exits 3 when the database is unreachable', async () => {
    const result = await secretsStatus(
      baseDeps({
        assertDatabaseReachable: () => Promise.reject(new Error('refused')),
      }),
    );
    expect(result).toEqual({ lines: [DB_UNREACHABLE_MESSAGE], exitCode: EXIT_DB_UNREACHABLE });
  });

  /**
   * A missing master key exits 4 with the documented message.
   */
  it('exits 4 when the master key file is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ah-secrets-status-'));
    dirs.push(dir);
    const result = await secretsStatus(
      baseDeps({
        loadConfig: () => ({ DATABASE_URL: 'unused', MASTER_KEY_PATH: join(dir, 'absent.key') }),
      }),
    );
    expect(result).toEqual({
      lines: [MASTER_KEY_MISSING_MESSAGE],
      exitCode: EXIT_MASTER_KEY_MISSING,
    });
  });

  /**
   * `SecretStatus.last4` is typed optional even for a `set` entry (the real service always
   * populates it); a status report that omits it anyway must still print a sane line instead of
   * interpolating `undefined`.
   */
  it('falls back to an empty mask when a set entry omits last4', async () => {
    const result = await secretsStatus(
      baseDeps({
        createSecretsService: () =>
          Promise.resolve({
            set: () => Promise.reject(new Error('not used')),
            remove: () => Promise.reject(new Error('not used')),
            reveal: () => Promise.reject(new Error('not used')),
            status: () =>
              Promise.resolve({
                GITHUB_PAT: { set: true },
                OPENAI_API_KEY: { set: false },
              }),
          }),
      }),
    );
    expect(result.lines[0]).toBe('GITHUB_PAT=set:');
  });
});
