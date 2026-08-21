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
import { JOB_RUN_WORKSPACE_KIND } from '../ports.ts';
import type {
  CreateJobRunInput,
  FinishJobRunInput,
  JobRunPush,
  JobRunRepository,
  JobRunStatusUpdate,
} from '../ports.ts';

import { NotFoundError, WorkspaceKindMismatchError } from './errors.ts';
import { asWorkspaceKind, toJobRun, toPrismaJobRunStatus } from './mappers.ts';
import { translatePrismaError } from './prisma-errors.ts';

/**
 * Refuses a workspace reference that does not name a job workspace.
 *
 * The foreign key says the row exists; it cannot say what kind of row it is, and the kind is the
 * whole invariant — a run tears its workspace down when it ends, so a run pointed at a chat's
 * workspace would destroy a container the chat expects to find again. Expressing it as a composite
 * key would mean carrying the kind on `JobRun` as well, which is a column that can disagree with
 * the one it copies, so the check is a statement instead.
 *
 * A statement is enough here in a way it would not be for a status. `Workspace.kind` is written by
 * the insert and by nothing else — no repository method accepts it as an update — so the value
 * read is the value any later statement in this transaction would read, and there is no writer for
 * a conditional write to arbitrate against.
 *
 * @param tx - The transaction the status update runs in.
 * @param workspaceId - Workspace the run is being pointed at.
 * @throws NotFoundError When no workspace carries that id.
 * @throws WorkspaceKindMismatchError When the workspace is not a job workspace.
 */
async function assertJobWorkspace(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  const workspace = await tx.workspace.findUnique({
    where: { id: workspaceId },
    select: { kind: true },
  });
  if (workspace === null) {
    throw new NotFoundError('Workspace', workspaceId);
  }
  const kind = asWorkspaceKind(workspace.kind);
  if (kind !== JOB_RUN_WORKSPACE_KIND) {
    throw new WorkspaceKindMismatchError(workspaceId, JOB_RUN_WORKSPACE_KIND, kind);
  }
}

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
  async recordPush(id: string, push: JobRunPush): Promise<JobRun> {
    try {
      const row = await this.prisma.jobRun.update({
        where: { id },
        data: { workBranch: push.workBranch, lastPushedSha: push.lastPushedSha },
      });
      return toJobRun(row);
    } catch (error) {
      translatePrismaError(error, { entity: 'JobRun', id });
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
          if (update.workspaceId !== null) {
            await assertJobWorkspace(tx, update.workspaceId);
          }
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
