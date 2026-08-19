/**
 * Prisma implementation of `JobRunRepository`.
 *
 * Layer: service (persistence).
 *
 * `output` and `error` are redacted on write. `workspaceId` is unique across runs (a run never
 * reuses a workspace); the database enforces it, and a P2002 on that constraint is translated to
 * `UniqueViolationError('JobRun', 'workspaceId')`.
 */
import type { Redactor } from '../../secrets/types.js';
import type { JobRunStatus } from '../../workspace/types.js';
import type { JobRun } from '../entities.js';
import type { PrismaClient } from '../generated/client.js';
import type {
  CreateJobRunInput,
  FinishJobRunInput,
  JobRunRepository,
  JobRunStatusUpdate,
} from '../ports.js';

import { toJobRun, toPrismaJobRunStatus } from './mappers.js';
import { translatePrismaError } from './prisma-errors.js';

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
      translatePrismaError(error, { entity: 'ScheduledJob', id: input.jobId });
    }
  }

  /** @inheritDoc */
  async setStatus(
    id: string,
    status: JobRunStatus,
    update: JobRunStatusUpdate = {},
  ): Promise<JobRun> {
    try {
      if (status === 'PREPARING') {
        await this.prisma.jobRun.updateMany({
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
      const row = await this.prisma.jobRun.update({ where: { id }, data });
      return toJobRun(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'JobRun', id });
    }
  }

  /** @inheritDoc */
  async finish(id: string, input: FinishJobRunInput): Promise<JobRun> {
    try {
      const row = await this.prisma.jobRun.update({
        where: { id },
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
      return toJobRun(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'JobRun', id });
    }
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
