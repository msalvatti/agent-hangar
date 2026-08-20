/**
 * In-memory `ScheduledJobRepository` and `JobRunRepository` (unique `JobRun.workspaceId`).
 *
 * Layer: test double.
 */
import { UniqueViolationError } from '../../errors.ts';
import type { JobRun, ScheduledJob } from '../../persistence/entities.ts';
import type {
  CreateJobRunInput,
  CreateScheduledJobInput,
  FinishJobRunInput,
  JobRunRepository,
  JobRunStatusUpdate,
  RunTimes,
  ScheduledJobRepository,
  UpdateScheduledJobInput,
} from '../../persistence/ports.ts';
import type { JobRunStatus } from '../../workspace/types.ts';

import type { InMemoryStore } from './store.ts';

/** Scheduled job rows with cascade delete to runs (and their tool calls). */
export class InMemoryScheduledJobRepository implements ScheduledJobRepository {
  constructor(private readonly store: InMemoryStore) {}

  async create(input: CreateScheduledJobInput): Promise<ScheduledJob> {
    const now = this.store.now();
    const job: ScheduledJob = {
      id: this.store.newId(),
      name: input.name,
      cron: input.cron,
      timezone: input.timezone,
      prompt: input.prompt,
      repoUrl: input.repoUrl,
      branch: input.branch,
      enabled: input.enabled,
      lastRunAt: null,
      nextRunAt: input.nextRunAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.scheduledJobs.set(job.id, job);
    return { ...job };
  }

  async get(id: string): Promise<ScheduledJob | null> {
    const job = this.store.scheduledJobs.get(id);
    return job === undefined ? null : { ...job };
  }

  async list(): Promise<ScheduledJob[]> {
    return [...this.store.scheduledJobs.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((job) => ({ ...job }));
  }

  async update(id: string, patch: UpdateScheduledJobInput): Promise<ScheduledJob> {
    const job = this.store.require(this.store.scheduledJobs, 'ScheduledJob', id);
    Object.assign(job, patch, { updatedAt: this.store.now() });
    return { ...job };
  }

  async delete(id: string): Promise<void> {
    this.store.require(this.store.scheduledJobs, 'ScheduledJob', id);
    const runIds = new Set(
      [...this.store.jobRuns.values()].filter((run) => run.jobId === id).map((run) => run.id),
    );
    for (const [toolCallId, toolCall] of this.store.toolCalls) {
      if (toolCall.jobRunId !== null && runIds.has(toolCall.jobRunId)) {
        this.store.toolCalls.delete(toolCallId);
      }
    }
    for (const runId of runIds) {
      this.store.jobRuns.delete(runId);
    }
    this.store.scheduledJobs.delete(id);
  }

  async listEnabled(): Promise<ScheduledJob[]> {
    return [...this.store.scheduledJobs.values()]
      .filter((job) => job.enabled)
      .map((job) => ({ ...job }));
  }

  async setRunTimes(id: string, times: RunTimes): Promise<ScheduledJob> {
    const job = this.store.require(this.store.scheduledJobs, 'ScheduledJob', id);
    if (times.lastRunAt !== undefined) {
      job.lastRunAt = times.lastRunAt;
    }
    if (times.nextRunAt !== undefined) {
      job.nextRunAt = times.nextRunAt;
    }
    job.updatedAt = this.store.now();
    return { ...job };
  }
}

/** Job run rows. */
export class InMemoryJobRunRepository implements JobRunRepository {
  constructor(private readonly store: InMemoryStore) {}

  async create(input: CreateJobRunInput): Promise<JobRun> {
    this.store.require(this.store.scheduledJobs, 'ScheduledJob', input.jobId);
    const run: JobRun = {
      id: this.store.newId(),
      jobId: input.jobId,
      workspaceId: null,
      status: 'QUEUED',
      trigger: input.trigger,
      model: input.model,
      output: null,
      error: null,
      inputTokens: null,
      outputTokens: null,
      stepCount: 0,
      scheduledFor: input.scheduledFor,
      queuedAt: this.store.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.store.jobRuns.set(run.id, run);
    return { ...run };
  }

  async setStatus(
    id: string,
    status: JobRunStatus,
    update: JobRunStatusUpdate = {},
  ): Promise<JobRun> {
    const run = this.store.require(this.store.jobRuns, 'JobRun', id);
    if (update.workspaceId !== undefined && update.workspaceId !== null) {
      const workspaceId = update.workspaceId;
      const taken = [...this.store.jobRuns.values()].some(
        (other) => other.id !== id && other.workspaceId === workspaceId,
      );
      if (taken) {
        throw new UniqueViolationError('JobRun', 'workspaceId');
      }
    }
    run.status = status;
    if (status === 'PREPARING' && run.startedAt === null) {
      run.startedAt = this.store.now();
    }
    if (update.workspaceId !== undefined) {
      run.workspaceId = update.workspaceId;
    }
    if (update.error !== undefined) {
      run.error = update.error;
    }
    return { ...run };
  }

  async finish(id: string, input: FinishJobRunInput): Promise<JobRun> {
    const run = this.store.require(this.store.jobRuns, 'JobRun', id);
    Object.assign(run, {
      status: input.status,
      output: input.output ?? run.output,
      error: input.error ?? run.error,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      stepCount: input.usage.stepCount,
      finishedAt: this.store.now(),
    });
    return { ...run };
  }

  async listByJob(jobId: string, options: { limit?: number } = {}): Promise<JobRun[]> {
    let runs = [...this.store.jobRuns.values()]
      .filter((run) => run.jobId === jobId)
      .sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime());
    if (options.limit !== undefined) {
      runs = runs.slice(0, options.limit);
    }
    return runs.map((run) => ({ ...run }));
  }

  async get(id: string): Promise<JobRun | null> {
    const run = this.store.jobRuns.get(id);
    return run === undefined ? null : { ...run };
  }

  async findRunningByJob(jobId: string): Promise<JobRun | null> {
    const run = [...this.store.jobRuns.values()].find(
      (candidate) =>
        candidate.jobId === jobId &&
        (candidate.status === 'PREPARING' || candidate.status === 'RUNNING'),
    );
    return run === undefined ? null : { ...run };
  }
}
