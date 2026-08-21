/**
 * Prisma implementation of `JobRunRepository`.
 *
 * Layer: service (persistence).
 *
 * `output` and `error` are redacted on write. `workspaceId` is unique across runs (a run never
 * reuses a workspace); the database enforces it, and a P2002 on that constraint is translated to
 * `UniqueViolationError('JobRun', 'workspaceId')`. A missing scheduled-job parent surfaces as
 * Postgres foreign-key violation P2003 (not P2025), translated to `NotFoundError('ScheduledJob',
 * jobId)` so callers see what `InMemoryJobRunRepository` raises. `setStatus` runs its guarded
 * `startedAt` stamp and the status update in one transaction, so a failing status update never
 * leaves a QUEUED run that looks started. `finish` is the one conditional write here: it names the
 * live statuses in its own `where`, so a run that already carries an outcome is not overwritten by
 * a second writer and that writer is told it lost.
 */
import type { Redactor } from '../../secrets/types.ts';
import { LIVE_RUN_STATUSES } from '../../workspace/lifecycle.ts';
import type { JobRunStatus } from '../../workspace/types.ts';
import type { JobRun } from '../entities.ts';
import type { Prisma, PrismaClient } from '../generated/client.ts';
import type {
  CreateJobRunInput,
  FinishJobRunInput,
  JobRunRepository,
  JobRunStatusUpdate,
} from '../ports.ts';

import { toJobRun, toPrismaJobRunStatus } from './mappers.ts';
import { translatePrismaError } from './prisma-errors.ts';

/** Job run rows. */
export class PrismaJobRunRepository implements JobRunRepository {
  /**
   * @param prisma - Connected Prisma client.
   * @param redactor - Redacts `output` and `error` before they are written.
   */
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redactor: Redactor,
  ) {}

  /** @inheritDoc */
  async create(input: CreateJobRunInput): Promise<JobRun> {
    try {
      const row = await this.prisma.jobRun.create({
        data: {
          jobId: input.jobId,
          trigger: input.trigger,
          model: input.model,
          scheduledFor: input.scheduledFor,
          status: 'QUEUED',
        },
      });
      return toJobRun(row);
    } catch (error) {
      translatePrismaError(error, {
        entity: 'JobRun',
        parent: { entity: 'ScheduledJob', id: input.jobId },
      });
    }
  }

  /** @inheritDoc */
  async setStatus(
    id: string,
    status: JobRunStatus,
    update: JobRunStatusUpdate = {},
  ): Promise<JobRun> {
    try {
      const row = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (status === 'PREPARING') {
          await tx.jobRun.updateMany({
            where: { id, startedAt: null },
            data: { startedAt: new Date() },
          });
        }
        const data: {
          status: JobRunStatus;
          workspaceId?: string | null;
          error?: string | null;
        } = { status: toPrismaJobRunStatus(status) };
        if (update.workspaceId !== undefined) {
          data.workspaceId = update.workspaceId;
        }
        if (update.error !== undefined) {
          data.error = update.error === null ? null : this.redactor.redact(update.error);
        }
        return tx.jobRun.update({ where: { id }, data });
      });
      return toJobRun(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'JobRun', id });
    }
  }

  /**
   * @inheritDoc
   *
   * The precondition belongs in the `where` clause, so Postgres decides whether this writer is the
   * first one instead of the caller deciding it from a status it read earlier. A run that already
   * holds an outcome then matches nothing, which is an ordinary answer rather than the P2025 a
   * plain `update` would raise.
   *
   * `updateManyAndReturn` rather than an `updateMany` followed by a read, which is the shape
   * `claimStatus` settled on: the row a caller is handed has to be the one this statement wrote. A
   * second round trip would answer `null` for a run this call had genuinely terminalised, once the
   * cascade from a deleted job removed it in between.
   */
  async finish(id: string, input: FinishJobRunInput): Promise<JobRun | null> {
    const rows = await this.prisma.jobRun.updateManyAndReturn({
      where: { id, status: { in: LIVE_RUN_STATUSES.map(toPrismaJobRunStatus) } },
      data: {
        status: toPrismaJobRunStatus(input.status),
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        stepCount: input.usage.stepCount,
        finishedAt: new Date(),
        ...(input.output === undefined
          ? {}
          : { output: input.output === null ? null : this.redactor.redact(input.output) }),
        ...(input.error === undefined
          ? {}
          : { error: input.error === null ? null : this.redactor.redact(input.error) }),
      },
    });
    const row = rows[0];
    return row === undefined ? null : toJobRun(row);
  }

  /** @inheritDoc */
  async listByJob(jobId: string, options: { limit?: number } = {}): Promise<JobRun[]> {
    const rows = await this.prisma.jobRun.findMany({
      where: { jobId },
      orderBy: { queuedAt: 'desc' },
      ...(options.limit === undefined ? {} : { take: options.limit }),
    });
    return rows.map(toJobRun);
  }

  /** @inheritDoc */
  async get(id: string): Promise<JobRun | null> {
    const row = await this.prisma.jobRun.findUnique({ where: { id } });
    return row === null ? null : toJobRun(row);
  }

  /** @inheritDoc */
  async findRunningByJob(jobId: string): Promise<JobRun | null> {
    const row = await this.prisma.jobRun.findFirst({
      where: { jobId, status: { in: ['PREPARING', 'RUNNING'] } },
    });
    return row === null ? null : toJobRun(row);
  }
}
