/**
 * Prisma implementation of `ToolCallLogRepository`.
 *
 * Layer: service (persistence).
 *
 * `args` is redacted (as JSON) and narrowed to a JSON-safe value on write; `resultHead` is
 * redacted and truncated to {@link RESULT_HEAD_MAX_BYTES} on write, while `resultBytes` keeps the
 * untruncated length so callers can show a "truncated" indicator.
 */
import type { Redactor } from '../../secrets/types.js';
import type { ToolCallLog } from '../entities.js';
import type { PrismaClient } from '../generated/client.js';
import type { FinishToolCallInput, StartToolCallInput, ToolCallLogRepository } from '../ports.js';

import { PersistenceMappingError } from './errors.js';
import {
  toInputJson,
  toPrismaToolCallStatus,
  toToolCallLog,
  truncateResultHead,
} from './mappers.js';
import { translatePrismaError } from './prisma-errors.js';

/** Tool-call log rows. */
export class PrismaToolCallLogRepository implements ToolCallLogRepository {
  /**
   * @param prisma - Connected Prisma client.
   * @param redactor - Redacts `args` and `resultHead` before they are written.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redactor: Redactor,
  ) {}

  /** @inheritDoc */
  async start(input: StartToolCallInput): Promise<ToolCallLog> {
    this.assertExactlyOneParent(input);
    const row = await this.prisma.toolCallLog.create({
      data: {
        workspaceId: input.workspaceId,
        turnId: input.turnId ?? null,
        jobRunId: input.jobRunId ?? null,
        callId: input.callId,
        seq: input.seq,
        toolName: input.toolName,
        args: toInputJson(this.redactor.redactJson(input.args)),
        status: 'RUNNING',
      },
    });
    return toToolCallLog(row);
  }

  /** @inheritDoc */
  async finish(id: string, input: FinishToolCallInput): Promise<ToolCallLog> {
    try {
      const row = await this.prisma.toolCallLog.update({
        where: { id },
        data: {
          status: toPrismaToolCallStatus(input.status),
          exitCode: input.exitCode,
          resultBytes: input.resultBytes,
          durationMs: input.durationMs,
          finishedAt: new Date(),
          resultHead:
            input.resultHead === null
              ? null
              : truncateResultHead(this.redactor.redact(input.resultHead)),
        },
      });
      return toToolCallLog(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'ToolCallLog', id });
    }
  }

  /** @inheritDoc */
  async listByTurn(turnId: string): Promise<ToolCallLog[]> {
    const rows = await this.prisma.toolCallLog.findMany({
      where: { turnId },
      orderBy: { seq: 'asc' },
    });
    return rows.map(toToolCallLog);
  }

  /** @inheritDoc */
  async listByJobRun(jobRunId: string): Promise<ToolCallLog[]> {
    const rows = await this.prisma.toolCallLog.findMany({
      where: { jobRunId },
      orderBy: { seq: 'asc' },
    });
    return rows.map(toToolCallLog);
  }

  /**
   * Defends the invariant documented on `ToolCallLog` (`entities.ts`): exactly one of
   * `turnId`/`jobRunId` is set. The port's input type does not encode this as a union, so a
   * caller mistake would otherwise write an orphaned or double-parented row.
   *
   * @param input - Input passed to {@link start}.
   * @throws PersistenceMappingError when both or neither parent is set.
   */
  private assertExactlyOneParent(input: StartToolCallInput): void {
    const hasTurn = input.turnId !== undefined;
    const hasJobRun = input.jobRunId !== undefined;
    if (hasTurn === hasJobRun) {
      throw new PersistenceMappingError(
        'StartToolCallInput must set exactly one of turnId or jobRunId.',
      );
    }
  }
}
