/**
 * Scheduled-job routes: create, list, read, edit, delete and manual run.
 *
 * Layer: service (server).
 *
 * The database row and the BullMQ Job Scheduler are two halves of one fact, and every handler here
 * leaves them agreeing **for requests that do not overlap on the same job**. Postgres and Redis
 * cannot enlist in one transaction, so the agreement is reached by compensation rather than by
 * atomicity: the row is written first and a scheduler operation that fails undoes that write. A
 * failed create deletes the row it just inserted; a failed edit puts the previous values back,
 * which is exactly what the scheduler that is still registered describes. A delete goes the other
 * way round and removes the scheduler first, because a tick firing between the two steps would
 * otherwise deliver a job whose row is already gone.
 *
 * Two limits, and the first is the one the qualification above is about. Two edits of the *same*
 * job in flight together can finish with the row from one and the scheduler from the other, both
 * answering success: each request writes its row and then syncs its own scheduler, and nothing
 * orders the second step the way the first was ordered. Every handler reads the job before it
 * writes, so the snapshot it decided from may already be stale by the time it acts, and no
 * re-read closes it — a request can still re-read before a rival writes and sync after it. Closing
 * this needs a write that fails when the row has moved, and `ScheduledJobRepository` exposes only
 * an unconditional `update`; a conditional one belongs in the persistence port, which is frozen.
 * What is ruled out is the worse half of that race: an undo is skipped when the row no longer
 * carries what this request wrote, so a failed edit never reverts a later edit that succeeded.
 *
 * The second limit is where both stores fail at once. If the compensating write also fails, the
 * halves are left disagreeing; the request still fails, and the mismatch is logged with the job id
 * because there is nowhere left to record it. Editing that job again rewrites both halves.
 * Scheduler keys are `ScheduledJob.id`, which is what makes the upsert idempotent per job. The undo
 * step itself is `./compensate.ts`'s `compensate`, shared with `handlers/chats.ts`.
 */
import {
  jobPatchRequest,
  jobSummary,
  jobUpsertRequest,
  listJobsResponse,
  nextRunAt,
  removeScheduledJob,
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

import { compensate } from './compensate';
import { NO_USAGE, requireSecrets } from './guards';
import { enqueueManualRun } from './manual-run';
import { toJobSummary } from './mappers';

/** Status the manual-run route answers with; the worker has yet to pick the run up. */
export const RUN_ACCEPTED_STATUS = 202;

/** Log message every {@link compensate} call in this file shares, naming what it undoes. */
const COMPENSATE_FAILURE_MESSAGE = 'could not undo a partial scheduled-job write';

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

/** The fields an edit writes; compared to tell this request's row apart from a later one's. */
const EDITABLE_FIELDS = [
  'name',
  'cron',
  'timezone',
  'prompt',
  'repoUrl',
  'branch',
  'enabled',
] as const;

/**
 * Whether a stored job still carries exactly the values an edit wrote.
 *
 * Compared by value rather than by `updatedAt`, which cannot tell two writes apart when they land
 * in the same clock tick.
 *
 * @param stored - The row as it reads now.
 * @param written - The row this request produced.
 * @returns `true` when nothing has been written over it since.
 */
function isUnchangedSince(stored: ScheduledJob, written: ScheduledJob): boolean {
  return (
    EDITABLE_FIELDS.every((field) => stored[field] === written[field]) &&
    (stored.nextRunAt?.getTime() ?? null) === (written.nextRunAt?.getTime() ?? null)
  );
}

/**
 * Restores every editable field of a job to the values it held before an edit.
 *
 * The undo is skipped when the row no longer carries what this request wrote, because another edit
 * has landed on top and has synced a scheduler of its own. Writing the pre-edit snapshot over it
 * would revert an edit that already answered success, which is a worse outcome than the mismatch
 * being repaired: it loses a change the user was told had been saved.
 *
 * @param container - The server container.
 * @param previous - The job as it was before the edit.
 * @param written - The row this request wrote, to recognise a later edit.
 * @returns Resolves once the row is back, once the failure to put it back has been reported, or
 *   once the undo has been declined because a newer edit owns the row.
 */
async function restoreJob(
  container: ServerContainer,
  previous: ScheduledJob,
  written: ScheduledJob,
): Promise<void> {
  const current = await container.repos.scheduledJobs.get(previous.id);
  if (current === null || !isUnchangedSince(current, written)) {
    container.logger.warn(
      { jobId: previous.id },
      'declined to undo a scheduled-job edit a later write already replaced',
    );
    return;
  }
  await compensate(container, { jobId: previous.id }, COMPENSATE_FAILURE_MESSAGE, () =>
    container.repos.scheduledJobs.update(previous.id, {
      name: previous.name,
      cron: previous.cron,
      timezone: previous.timezone,
      prompt: previous.prompt,
      repoUrl: previous.repoUrl,
      branch: previous.branch,
      enabled: previous.enabled,
      nextRunAt: previous.nextRunAt,
    }),
  );
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
      await compensate(container, { jobId: job.id }, COMPENSATE_FAILURE_MESSAGE, () =>
        container.repos.scheduledJobs.delete(job.id),
      );
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
 * The patch is merged onto a snapshot read at the start of the request, so two edits of one job in
 * flight together are last-write-wins on the row and can leave the scheduler describing the other
 * one; see the module header for why that cannot be closed from here. The undo below is the part
 * that is closed: it runs only while the row still carries what this request wrote.
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
    try {
      await syncScheduler(container, updated);
    } catch (error) {
      // The row already carries the new cron and enabled flag while Redis still holds the old
      // scheduler, so the edit is rolled back to the state that scheduler describes.
      await restoreJob(container, existing, updated);
      throw error;
    }
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
    try {
      await container.repos.scheduledJobs.delete(job.id);
    } catch (error) {
      // The row survived the delete, so it still describes a job that is meant to fire; putting
      // its scheduler back is what keeps the two halves saying the same thing.
      await compensate(container, { jobId: job.id }, COMPENSATE_FAILURE_MESSAGE, () =>
        syncScheduler(container, job),
      );
      throw error;
    }
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
 * The producer is `./manual-run.ts`, shared with the cancel route so that the delivery a stopped
 * run is put back on is the same one this route created.
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
      await enqueueManualRun(container.queues.scheduledJobs, { jobId: job.id, runId: run.id });
    } catch (error) {
      await compensate(container, { jobId: job.id }, COMPENSATE_FAILURE_MESSAGE, () =>
        container.repos.jobRuns.finish(run.id, {
          status: 'FAILED',
          usage: NO_USAGE,
          error: 'Could not enqueue the run',
        }),
      );
      throw error;
    }
    return jsonResponse(triggerRunResponse, { runId: run.id }, { status: RUN_ACCEPTED_STATUS });
  });
}
