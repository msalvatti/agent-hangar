/**
 * Prisma implementation of `ChatRepository`.
 *
 * Layer: service (persistence).
 *
 * `title` is redacted on write. Both the schema and spec 02 define it as the first prompt,
 * trimmed, so it is the same free text as `Message.content` and can carry a PAT or an API key;
 * `create` and `rename` are the only two ways a title enters, and both go through the `Redactor`.
 * `repoUrl`, `baseBranch`, `workBranch` and `lastPushedSha` are identifiers and are never
 * redacted — the lane rule forbids redacting those.
 */
import type { Redactor } from '../../secrets/types.js';
import type { ChatStatus } from '../../workspace/types.js';
import type { Chat } from '../entities.js';
import type { PrismaClient } from '../generated/client.js';
import type { ChatRepository, CreateChatInput, RestoreHints } from '../ports.js';

import { toChat, toPrismaChatStatus } from './mappers.js';
import { translatePrismaError } from './prisma-errors.js';

/** Chat rows. */
export class PrismaChatRepository implements ChatRepository {
  /**
   * @param prisma - Connected Prisma client.
   * @param redactor - Redacts `title` before it is written.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redactor: Redactor,
  ) {}

  /** @inheritDoc */
  async create(input: CreateChatInput): Promise<Chat> {
    const row = await this.prisma.chat.create({
      data: {
        title: this.redactor.redact(input.title),
        repoUrl: input.repoUrl,
        baseBranch: input.baseBranch,
        status: 'ACTIVE',
      },
    });
    return toChat(row);
  }

  /** @inheritDoc */
  async getById(id: string): Promise<Chat | null> {
    const row = await this.prisma.chat.findUnique({ where: { id } });
    return row === null ? null : toChat(row);
  }

  /** @inheritDoc */
  async list(status?: ChatStatus): Promise<Chat[]> {
    const rows = await this.prisma.chat.findMany({
      where: status === undefined ? {} : { status: toPrismaChatStatus(status) },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map(toChat);
  }

  /** @inheritDoc */
  async rename(id: string, title: string): Promise<Chat> {
    return this.update(id, { title: this.redactor.redact(title) });
  }

  /** @inheritDoc */
  async setStatus(id: string, status: ChatStatus): Promise<Chat> {
    return this.update(id, {
      status: toPrismaChatStatus(status),
      archivedAt: status === 'ARCHIVED' ? new Date() : null,
    });
  }

  /** @inheritDoc */
  async updateRestoreHints(id: string, hints: RestoreHints): Promise<Chat> {
    const data: { workBranch?: string | null; lastPushedSha?: string | null } = {};
    if (hints.workBranch !== undefined) {
      data.workBranch = hints.workBranch;
    }
    if (hints.lastPushedSha !== undefined) {
      data.lastPushedSha = hints.lastPushedSha;
    }
    return this.update(id, data);
  }

  /** @inheritDoc */
  async touch(id: string): Promise<void> {
    await this.update(id, {});
  }

  /** @inheritDoc */
  async delete(id: string): Promise<void> {
    try {
      await this.prisma.chat.delete({ where: { id } });
    } catch (error) {
      translatePrismaError(error, { entity: 'Chat', id });
    }
  }

  /**
   * Applies a partial update and returns the fresh row. `updatedAt` is set explicitly rather than
   * left to Prisma's `@updatedAt` directive, because an `update` call whose `data` has no other
   * key (an empty patch, as `touch` sends) does not bump it on its own.
   *
   * @param id - Chat to update.
   * @param data - Fields to change.
   */
  private async update(
    id: string,
    data: {
      title?: string;
      status?: ChatStatus;
      archivedAt?: Date | null;
      workBranch?: string | null;
      lastPushedSha?: string | null;
    },
  ): Promise<Chat> {
    try {
      const row = await this.prisma.chat.update({
        where: { id },
        data: { ...data, updatedAt: new Date() },
      });
      return toChat(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'Chat', id });
    }
  }
}
