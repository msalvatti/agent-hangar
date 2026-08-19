/**
 * Prisma implementation of `TurnRepository`.
 *
 * Layer: service (persistence).
 *
 * `error` is redacted on write; `startedAt` is stamped the first time a turn reaches `PREPARING`
 * and never overwritten afterwards (mirrors `InMemoryTurnRepository`, which every later lane's
 * tests run against).
 */
import type { Redactor } from '../../secrets/types.js';
import type { TurnStatus } from '../../workspace/types.js';
import type { Turn, UsageTotals } from '../entities.js';
import type { PrismaClient } from '../generated/client.js';
import type {
  CreateTurnInput,
  TerminalStatus,
  TurnRepository,
  TurnStatusUpdate,
} from '../ports.js';

import { toPrismaTurnStatus, toTurn } from './mappers.js';
import { translatePrismaError } from './prisma-errors.js';

/** Turn rows. */
export class PrismaTurnRepository implements TurnRepository {
  /**
   * @param prisma - Connected Prisma client.
   * @param redactor - Redacts `error` before it is written.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redactor: Redactor,
  ) {}

  /** @inheritDoc */
  async create(input: CreateTurnInput): Promise<Turn> {
    const row = await this.prisma.turn.create({
      data: {
        chatId: input.chatId,
        model: input.model,
        queueJobId: input.queueJobId ?? null,
        status: 'QUEUED',
      },
    });
    return toTurn(row);
  }

  /** @inheritDoc */
  async get(id: string): Promise<Turn | null> {
    const row = await this.prisma.turn.findUnique({ where: { id } });
    return row === null ? null : toTurn(row);
  }

  /** @inheritDoc */
  async setStatus(id: string, status: TurnStatus, update: TurnStatusUpdate = {}): Promise<Turn> {
    try {
      if (status === 'PREPARING') {
        // Only stamps `startedAt` the first time: the `where` clause only matches rows where it
        // is still unset, so a later PREPARING (or a RUNNING that follows it) leaves it alone.
        await this.prisma.turn.updateMany({
          where: { id, startedAt: null },
          data: { startedAt: new Date() },
        });
      }
      const data: {
        status: TurnStatus;
        workspaceId?: string | null;
        queueJobId?: string | null;
        error?: string | null;
      } = { status: toPrismaTurnStatus(status) };
      if (update.workspaceId !== undefined) {
        data.workspaceId = update.workspaceId;
      }
      if (update.queueJobId !== undefined) {
        data.queueJobId = update.queueJobId;
      }
      if (update.error !== undefined) {
        data.error = update.error === null ? null : this.redactor.redact(update.error);
      }
      const row = await this.prisma.turn.update({ where: { id }, data });
      return toTurn(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'Turn', id });
    }
  }

  /** @inheritDoc */
  async finish(
    id: string,
    status: TerminalStatus,
    usage: UsageTotals,
    error?: string,
  ): Promise<Turn> {
    try {
      const row = await this.prisma.turn.update({
        where: { id },
        data: {
          status: toPrismaTurnStatus(status),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          stepCount: usage.stepCount,
          finishedAt: new Date(),
          ...(error === undefined ? {} : { error: this.redactor.redact(error) }),
        },
      });
      return toTurn(row);
    } catch (caught) {
      translatePrismaError(caught, { entity: 'Turn', id });
    }
  }

  /** @inheritDoc */
  async listByChat(chatId: string): Promise<Turn[]> {
    const rows = await this.prisma.turn.findMany({
      where: { chatId },
      orderBy: { queuedAt: 'asc' },
    });
    return rows.map(toTurn);
  }
}
