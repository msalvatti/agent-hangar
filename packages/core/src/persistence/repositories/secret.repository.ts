/**
 * Prisma implementation of `SecretRepository`.
 *
 * Layer: service (persistence).
 *
 * No `Redactor` is injected here: this repository never receives plaintext, only an already
 * encrypted envelope (ciphertext, iv, authTag). There is nothing in an envelope's columns a
 * redactor could usefully act on.
 */
import { SECRET_KEYS } from '../../secrets/types.js';
import type { SecretEnvelope, SecretKey, SecretStatus } from '../../secrets/types.js';
import type { SecretRecord } from '../entities.js';
import type { PrismaClient } from '../generated/client.js';
import type { SecretRepository } from '../ports.js';

import { toPrismaSecretKey, toSecretRecord } from './mappers.js';

/** Secret rows: one per key, append-or-replace. */
export class PrismaSecretRepository implements SecretRepository {
  /**
   * @param prisma - Connected Prisma client.
   */
  constructor(private readonly prisma: PrismaClient) {}

  /** @inheritDoc */
  async upsert(key: SecretKey, envelope: SecretEnvelope): Promise<void> {
    const prismaKey = toPrismaSecretKey(key);
    // Re-wrapped so the generic buffer parameter matches Prisma's `Bytes` (`Uint8Array<ArrayBuffer>`)
    // regardless of what kind of `ArrayBufferLike` the injected `Redactor`/`SecretsService`
    // originally allocated (the domain `SecretEnvelope` type only promises a plain `Uint8Array`).
    const fields = {
      ciphertext: new Uint8Array(envelope.ciphertext),
      iv: new Uint8Array(envelope.iv),
      authTag: new Uint8Array(envelope.authTag),
      keyVersion: envelope.keyVersion,
      last4: envelope.last4,
    };
    await this.prisma.secret.upsert({
      where: { key: prismaKey },
      create: { key: prismaKey, ...fields },
      update: fields,
    });
  }

  /** @inheritDoc */
  async get(key: SecretKey): Promise<SecretRecord | null> {
    const row = await this.prisma.secret.findUnique({ where: { key: toPrismaSecretKey(key) } });
    return row === null ? null : toSecretRecord(row);
  }

  /** @inheritDoc */
  async remove(key: SecretKey): Promise<void> {
    await this.prisma.secret.deleteMany({ where: { key: toPrismaSecretKey(key) } });
  }

  /** @inheritDoc */
  async status(): Promise<Record<SecretKey, SecretStatus>> {
    const rows = await this.prisma.secret.findMany();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const result = {} as Record<SecretKey, SecretStatus>;
    for (const key of SECRET_KEYS) {
      const row = byKey.get(toPrismaSecretKey(key));
      result[key] =
        row === undefined
          ? { set: false }
          : { set: true, last4: row.last4, updatedAt: row.updatedAt };
    }
    return result;
  }
}
