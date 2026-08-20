/**
 * Prisma implementation of `MessageRepository`.
 *
 * Layer: service (persistence).
 *
 * `append` assigns a gap-free, per-chat `seq` under concurrency by locking the parent `Chat` row
 * (`SELECT … FOR UPDATE`) inside an interactive transaction before computing the next value, so
 * concurrent appends to the same chat serialise instead of racing on `MAX(seq)`.
 */
import type { Redactor } from '../../secrets/types.ts';
import type { MessageRole } from '../../workspace/types.ts';
import type { Message } from '../entities.ts';
import type { Prisma, PrismaClient } from '../generated/client.ts';
import type { ListMessagesOptions, MessageRepository } from '../ports.ts';

import { NotFoundError } from './errors.ts';
import { toMessage, toPrismaMessageRole } from './mappers.ts';

/** Row returned by the `SELECT COALESCE(MAX(seq), 0) + 1 AS next` query. */
interface NextSeqRow {
  next: number | bigint;
}

/** Message rows; `seq` is gap-free per chat. */
export class PrismaMessageRepository implements MessageRepository {
  /**
   * @param prisma - Connected Prisma client.
   * @param redactor - Redacts `content` before it is written.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redactor: Redactor,
  ) {}

  /** @inheritDoc */
  async append(
    chatId: string,
    role: MessageRole,
    content: string,
    turnId?: string,
  ): Promise<Message> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "Chat" WHERE id = ${chatId} FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundError('Chat', chatId);
      }
      const rows = await tx.$queryRaw<
        NextSeqRow[]
      >`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM "Message" WHERE "chatId" = ${chatId}`;
      const seq = this.nextSeq(rows);
      const row = await tx.message.create({
        data: {
          chatId,
          seq,
          role: toPrismaMessageRole(role),
          content: this.redactor.redact(content),
          turnId: turnId ?? null,
        },
      });
      return toMessage(row);
    });
  }

  /** @inheritDoc */
  async listByChat(chatId: string, options: ListMessagesOptions = {}): Promise<Message[]> {
    const rows = await this.prisma.message.findMany({
      where: {
        chatId,
        ...(options.before === undefined ? {} : { seq: { lt: options.before } }),
      },
      orderBy: { seq: 'desc' },
      ...(options.limit === undefined ? {} : { take: options.limit }),
    });
    return rows.reverse().map(toMessage);
  }

  /**
   * Reads the next sequence number out of the aggregate query result, converting `bigint` to
   * `number` at this single point (the aggregate is over an `Int` column, so Postgres normally
   * answers with `int4`, but the exact wire type is a `pg` driver detail this guards against).
   *
   * @param rows - Result of the `COALESCE(MAX(seq), 0) + 1` query (always exactly one row).
   */
  private nextSeq(rows: NextSeqRow[]): number {
    const value = rows[0]?.next ?? 1;
    return typeof value === 'bigint' ? Number(value) : value;
  }
}
