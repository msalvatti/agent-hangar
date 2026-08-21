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
 *
 * `deleteIfIdle` is the one write here that arbitrates rather than overwrites: the "no live turn"
 * precondition travels inside the `DELETE` as a subquery over `Turn`, so a turn committed before
 * the statement began is seen by it and the delete matches nothing. Reading the turns first and
 * deleting by id would leave the decision in the application, which is the race the method exists
 * to remove.
 */
import type { Redactor } from '../../secrets/types.ts';
import { LIVE_RUN_STATUSES } from '../../workspace/lifecycle.ts';
import type { ChatStatus } from '../../workspace/types.ts';
import type { Chat } from '../entities.ts';
import type { PrismaClient } from '../generated/client.ts';
import type { ChatDeleteOutcome, ChatRepository, CreateChatInput, RestoreHints } from '../ports.ts';

import { toChat, toPrismaChatStatus, toPrismaTurnStatus } from './mappers.ts';
import { translatePrismaError } from './prisma-errors.ts';

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

  /**
   * @inheritDoc
   *
   * A `deleteMany` rather than a `delete`, because only the plural form accepts a filter beyond
   * the primary key; the id is still unique, so it removes one row or none. The follow-up read
   * runs only when nothing matched, and is what tells a chat held by a live turn apart from a
   * chat that is no longer there — two answers the caller owes its user differently.
   */
  async deleteIfIdle(id: string): Promise<ChatDeleteOutcome> {
    const live = LIVE_RUN_STATUSES.map(toPrismaTurnStatus);
    const { count } = await this.prisma.chat.deleteMany({
      where: { id, turns: { none: { status: { in: live } } } },
    });
    if (count > 0) {
      return 'DELETED';
    }
    const row = await this.prisma.chat.findUnique({ where: { id }, select: { id: true } });
    return row === null ? 'MISSING' : 'LIVE_TURN';
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
