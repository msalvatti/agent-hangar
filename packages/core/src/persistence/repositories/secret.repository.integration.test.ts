/**
 * `@db` integration suite for `PrismaSecretRepository`, against a real Postgres.
 *
 * Layer: integration.
 * Goal: `upsert` twice for the same key replaces the row in place (one row, `updatedAt` advances,
 * bytes match the second write); `get` on a missing key returns null; `remove` on a missing key
 * resolves without error; `status()` always names both keys and never exposes ciphertext.
 * Mocks: none — a real compose Postgres.
 */
import { beforeEach, expect, it } from 'vitest';

import type { PrismaClient } from '../generated/client.js';
import { connectTestDb, countRows, describeDb, truncateAll } from '../testing/db.js';

import { PrismaSecretRepository } from './secret.repository.js';

let client: PrismaClient;

describeDb('PrismaSecretRepository', () => {
  beforeEach(async () => {
    client = connectTestDb();
    await truncateAll(client);
  });

  /** upsert() twice for the same key stays one row, with the second write's bytes and a later updatedAt. */
  it('upsert() twice replaces the row in place', async () => {
    const repo = new PrismaSecretRepository(client);
    await repo.upsert('GITHUB_PAT', {
      ciphertext: new Uint8Array([1, 1, 1]),
      iv: new Uint8Array([2, 2, 2]),
      authTag: new Uint8Array([3, 3, 3]),
      keyVersion: 1,
      last4: 'aaaa',
    });
    const first = await repo.get('GITHUB_PAT');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await repo.upsert('GITHUB_PAT', {
      ciphertext: new Uint8Array([9, 9, 9]),
      iv: new Uint8Array([8, 8, 8]),
      authTag: new Uint8Array([7, 7, 7]),
      keyVersion: 2,
      last4: 'bbbb',
    });
    expect(await countRows(client, 'Secret')).toBe(1);
    const second = await repo.get('GITHUB_PAT');
    expect(second?.last4).toBe('bbbb');
    expect(Array.from(second?.ciphertext ?? [])).toEqual([9, 9, 9]);
    expect(second?.updatedAt.getTime()).toBeGreaterThan(first?.updatedAt.getTime() ?? 0);
  });

  /** get() on a missing key returns null. */
  it('get() returns null for a key never stored', async () => {
    const repo = new PrismaSecretRepository(client);
    expect(await repo.get('OPENAI_API_KEY')).toBeNull();
  });

  /** remove() on a missing key resolves without throwing. */
  it('remove() on a missing key resolves', async () => {
    const repo = new PrismaSecretRepository(client);
    await expect(repo.remove('OPENAI_API_KEY')).resolves.toBeUndefined();
  });

  /** status() always names both keys and never exposes ciphertext. */
  it('status() reports both keys and never a ciphertext property', async () => {
    const repo = new PrismaSecretRepository(client);
    await repo.upsert('GITHUB_PAT', {
      ciphertext: new Uint8Array([1]),
      iv: new Uint8Array([2]),
      authTag: new Uint8Array([3]),
      keyVersion: 1,
      last4: 'aaaa',
    });
    const status = await repo.status();
    expect(Object.keys(status).sort()).toEqual(['GITHUB_PAT', 'OPENAI_API_KEY']);
    expect(status.GITHUB_PAT.set).toBe(true);
    expect(status.OPENAI_API_KEY.set).toBe(false);
    expect(Object.keys(status.GITHUB_PAT)).not.toContain('ciphertext');
  });
});
