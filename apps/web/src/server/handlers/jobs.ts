/**
 * Scheduled-job routes: create, list, read, edit, delete and manual run.
 *
 * Layer: service (server).
 *
 * The database row and the BullMQ Job Scheduler are two halves of one fact, so every handler here
 * leaves them agreeing: a create whose scheduler cannot be registered deletes the row it just
 * wrote, and a disable removes the scheduler after the row says the job is off. Scheduler keys are
 * `ScheduledJob.id`, which is what makes the upsert idempotent per job.
 */
import {
  jobPatchRequest,
  jobSummary,
  jobUpsertRequest,
  JOB_NAMES,
  KEEP_COMPLETED_JOBS,
  KEEP_FAILED_JOBS,
  listJobsResponse,
  nextRunAt,
  removeScheduledJob,
  runScheduledJobPayload,
  triggerRunResponse,
  upsertScheduledJob,
  validateCronSpec,
} from '@agent-hangar/core';
import type { CreateScheduledJobInput, JobRun, ScheduledJob } from '@agent-hangar/core';

import type { ServerContainer } from '../container';
import { ResourceNotFoundError } from '../errors';
import { jsonResponse, noContent, parseJsonBody, withErrorHandling } from '../http';
import { allowedRepoHosts, assertRepoUrlAllowed } from '../repo-url';
import { assertSameOrigin } from '../same-origin';

import { requireSecrets } from './guards';
import { toJobSummary } from './mappers';

/** Status the manual-run route answers with; the worker has yet to pick the run up. */
export const RUN_ACCEPTED_STATUS = 202;

/** Retention every producer applies, shared with the core producers. */
const RETENTION = {
  removeOnComplete: KEEP_COMPLETED_JOBS,
  removeOnFail: KEEP_FAILED_JOBS,
} as const;

/** Path parameters of the job routes. */
export interface JobParams {
  id: string;
}

/**
 * Loads a job or reports it missing.
 *
 * @param container - The server container.
 * @param id - Job id.
 * @returns The job row.
 * @throws ResourceNotFoundError 404 when there is no such job.
 */
async function requireJob(container: ServerContainer, id: string): Promise<ScheduledJob> {
  const job = await container.repos.scheduledJobs.get(id);
  if (job === null) {
    throw new ResourceNotFoundError('Scheduled job not found');
  }
  return job;
}

/**
 * Reads the status of a job's most recent run.
 *
 * @param container - The server container.
 * @param jobId - Job id.
 * @returns The status, or `null` when the job has never run.
 */
async function lastRunStatus(
  container: ServerContainer,
  jobId: string,
): Promise<JobRun['status'] | null> {
  const [latest] = await container.repos.jobRuns.listByJob(jobId, { limit: 1 });
  return latest?.status ?? null;
}

/**
 * Answers with one job, including the status of its last run.
 *
 * @param container - The server container.
 * @param job - The job row.
 * @param status - HTTP status of the response.
 * @returns The response.
 */
async function jobResponse(
  container: ServerContainer,
  job: ScheduledJob,
  status = 200,
): Promise<Response> {
  return jsonResponse(jobSummary, toJobSummary(job, await lastRunStatus(container, job.id)), {
    status,
  });
}

/**
 * Computes the next fire time of a schedule.
 *
 * @param container - The server container.
 * @param job - Cron expression, timezone and whether the job is enabled.
 * @returns The next fire time, or `null` while the job is disabled.
 * @throws InvalidCronError When the expression or the timezone is invalid.
 */
function computeNextRunAt(
  container: ServerContainer,
  job: { cron: string; timezone: string; enabled: boolean },
): Date | null {
  const spec = validateCronSpec({ cron: job.cron, timezone: job.timezone });
  return job.enabled ? nextRunAt(spec, container.clock.now()) : null;
}

/**
 * Registers or removes the scheduler of a job so Redis agrees with the row.
 *
 * @param container - The server container.
 * @param job - The stored job.
 */
async function syncScheduler(container: ServerContainer, job: ScheduledJob): Promise<void> {
  if (job.enabled) {
    await upsertScheduledJob(container.queues.scheduledJobs, job);
    return;
  }
  await removeScheduledJob(container.queues.scheduledJobs, job.id);
}

/**
 * `POST /api/jobs` — creates a scheduled job and registers its scheduler.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @returns `201` with the job summary.
 */
export function createJob(container: ServerContainer, request: Request): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const body = await parseJsonBody(request, jobUpsertRequest);
    assertRepoUrlAllowed(body.repoUrl, allowedRepoHosts(container.config));
    const input: CreateScheduledJobInput = {
      ...body,
      nextRunAt: computeNextRunAt(container, body),
    };
    const job = await container.repos.scheduledJobs.create(input);
    try {
      await syncScheduler(container, job);
    } catch (error) {
      // A job whose scheduler was never registered would sit in the table looking enabled and
      // never fire, which is worse than a failed request the user can retry.
      await container.repos.scheduledJobs.delete(job.id);
      throw error;
    }
    return jobResponse(container, job, 201);
  });
}

/**
 * `GET /api/jobs` — every scheduled job, newest first.
 *
 * @param container - The server container.
 * @returns `200` with the job summaries.
 */
export function listJobs(container: ServerContainer): Promise<Response> {
  return withErrorHandling(container, async () => {
    const jobs = await container.repos.scheduledJobs.list();
    const summaries = await Promise.all(
      jobs.map(async (job) => toJobSummary(job, await lastRunStatus(container, job.id))),
    );
    return jsonResponse(listJobsResponse, { jobs: summaries });
  });
}

/**
 * `GET /api/jobs/:id` — one scheduled job.
 *
 * @param container - The server container.
 * @param _request - The incoming request; this route reads nothing from it.
 * @param params - Resolved path parameters.
 * @returns `200` with the job summary, or `404`.
 */
export function getJob(
  container: ServerContainer,
  _request: Request,
  params: JobParams,
): Promise<Response> {
  return withErrorHandling(container, async () =>
    jobResponse(container, await requireJob(container, params.id)),
  );
}

/**
 * `PATCH /api/jobs/:id` — applies a partial edit and brings the scheduler back in step.
 *
 * The next fire time is recomputed from the merged values rather than from the patch, so editing
 * only the timezone still moves the schedule.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `200` with the updated job summary.
 */
export function updateJob(
  container: ServerContainer,
  request: Request,
  params: JobParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const existing = await requireJob(container, params.id);
    const patch = await parseJsonBody(request, jobPatchRequest);
    // Merged field by field rather than by spreading the patch: an optional key the client
    // omitted arrives as `undefined`, and spreading it would blank the stored value.
    const merged = {
      name: patch.name ?? existing.name,
      cron: patch.cron ?? existing.cron,
      timezone: patch.timezone ?? existing.timezone,
      prompt: patch.prompt ?? existing.prompt,
      repoUrl: patch.repoUrl ?? existing.repoUrl,
      branch: patch.branch ?? existing.branch,
      enabled: patch.enabled ?? existing.enabled,
    };
    assertRepoUrlAllowed(merged.repoUrl, allowedRepoHosts(container.config));
    const updated = await container.repos.scheduledJobs.update(existing.id, {
      ...merged,
      nextRunAt: computeNextRunAt(container, merged),
    });
    await syncScheduler(container, updated);
    return jobResponse(container, updated);
  });
}

/**
 * `DELETE /api/jobs/:id` — removes the scheduler and the job with its run history.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `204`.
 */
export function deleteJob(
  container: ServerContainer,
  request: Request,
  params: JobParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const job = await requireJob(container, params.id);
    // Removing the scheduler first: a tick that fires between the two steps would otherwise
    // deliver a job whose row is already gone.
    await removeScheduledJob(container.queues.scheduledJobs, job.id);
    await container.repos.scheduledJobs.delete(job.id);
    return noContent();
  });
}

/**
 * `POST /api/jobs/:id/run` — starts one run of a job right now.
 *
 * The run row is created here rather than by the worker, because the client opens the run's event
 * stream on the returned id immediately. The id travels on the payload so the worker adopts this
 * row instead of inserting a second one; pressing "Run now" twice is deliberately two runs, and
 * the overlap policy is what keeps them from piling up.
 *
 * The core manual-run producer is not used because it cannot carry that id; the retention policy
 * it applies is imported rather than restated.
 *
 * @param container - The server container.
 * @param request - The incoming request.
 * @param params - Resolved path parameters.
 * @returns `202` with the created run id.
 */
export function triggerRun(
  container: ServerContainer,
  request: Request,
  params: JobParams,
): Promise<Response> {
  return withErrorHandling(container, async () => {
    assertSameOrigin(request);
    const job = await requireJob(container, params.id);
    await requireSecrets(container);
    const run = await container.repos.jobRuns.create({
      jobId: job.id,
      trigger: 'MANUAL',
      model: container.config.OPENAI_MODEL,
      scheduledFor: container.clock.now(),
    });
    try {
      await container.queues.scheduledJobs.add(
        JOB_NAMES.runScheduledJob,
        runScheduledJobPayload.parse({ jobId: job.id, trigger: 'MANUAL', runId: run.id }),
        RETENTION,
      );
    } catch (error) {
      await container.repos.jobRuns.finish(run.id, {
        status: 'FAILED',
        usage: { inputTokens: 0, outputTokens: 0, stepCount: 0 },
        error: 'Could not enqueue the run',
      });
      throw error;
    }
    return jsonResponse(triggerRunResponse, { runId: run.id }, { status: RUN_ACCEPTED_STATUS });
  });
}
