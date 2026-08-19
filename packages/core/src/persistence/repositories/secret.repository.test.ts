/**
 * Unit tests for `PrismaSecretRepository`.
 *
 * Layer: unit.
 * Goal: `upsert` writes the same ciphertext fields to `create` and `update`; `get`/`remove` map
 * correctly; `status()` always reports both secret keys, `set: false` when a row is absent and
 * `set: true` with `last4`/`updatedAt` (never ciphertext) when present.
 * Mocks: a Prisma client double exposing only `secret.*` — no database.
 */
import { describe, expect, it, vi } from 'vitest';

import type { PrismaClient } from '../generated/client.js';

import { PrismaSecretRepository } from './secret.repository.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const envelope = {
  ciphertext: new Uint8Array([1, 2, 3]),
  iv: new Uint8Array([4, 5, 6]),
  authTag: new Uint8Array([7, 8, 9]),
  keyVersion: 1,
  last4: 'abcd',
};

const secretRow = { key: 'GITHUB_PAT', ...envelope, createdAt: NOW, updatedAt: NOW };

function fakePrisma() {
  const secret = {
    upsert: vi.fn(() => Promise.resolve(secretRow)),
    findUnique: vi.fn((): Promise<typeof secretRow | null> => Promise.resolve(secretRow)),
    deleteMany: vi.fn(() => Promise.resolve({ count: 1 })),
    findMany: vi.fn(() => Promise.resolve([secretRow])),
  };
  return { client: { secret } as unknown as PrismaClient, secret };
}

describe('PrismaSecretRepository', () => {
  /** upsert() writes the same fields to both create and update. */
  it('upsert() writes ciphertext/iv/authTag/keyVersion/last4 to both create and update', async () => {
    const { client, secret } = fakePrisma();
    const repo = new PrismaSecretRepository(client);
    await repo.upsert('GITHUB_PAT', envelope);
    expect(secret.upsert).toHaveBeenCalledWith({
      where: { key: 'GITHUB_PAT' },
      create: { key: 'GITHUB_PAT', ...envelope },
      update: envelope,
    });
  });

  /** get() maps a found row and returns null when absent. */
  it('get() returns the mapped record or null', async () => {
    const { client, secret } = fakePrisma();
    const repo = new PrismaSecretRepository(client);
    const record = await repo.get('GITHUB_PAT');
    expect(record?.key).toBe('GITHUB_PAT');
    secret.findUnique = vi.fn(() => Promise.resolve(null));
    expect(await repo.get('OPENAI_API_KEY')).toBeNull();
  });

  /** remove() is idempotent: deleteMany never throws when nothing matches. */
  it('remove() deletes by key', async () => {
    const { client, secret } = fakePrisma();
    const repo = new PrismaSecretRepository(client);
    await repo.remove('GITHUB_PAT');
    expect(secret.deleteMany).toHaveBeenCalledWith({ where: { key: 'GITHUB_PAT' } });
  });

  /** status() reports both keys, set:false for the absent one, and never leaks ciphertext. */
  it('status() reports both keys with set:false for the one that has no row', async () => {
    const { client } = fakePrisma();
    const repo = new PrismaSecretRepository(client);
    const status = await repo.status();
    expect(status.GITHUB_PAT).toEqual({ set: true, last4: 'abcd', updatedAt: NOW });
    expect(status.OPENAI_API_KEY).toEqual({ set: false });
    expect(Object.keys(status.GITHUB_PAT)).not.toContain('ciphertext');
  });

  /** status() reports set:false for both keys when no row exists at all. */
  it('status() reports set:false for both keys when none are stored', async () => {
    const { client, secret } = fakePrisma();
    secret.findMany = vi.fn(() => Promise.resolve([]));
    const repo = new PrismaSecretRepository(client);
    const status = await repo.status();
    expect(status.GITHUB_PAT).toEqual({ set: false });
    expect(status.OPENAI_API_KEY).toEqual({ set: false });
  });
});
