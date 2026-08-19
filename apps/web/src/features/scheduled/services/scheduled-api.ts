/**
 * Typed HTTP calls for scheduled jobs and their runs, over the shared `apiFetch` client.
 *
 * Layer: service.
 *
 * The contract has no `GET /api/jobs/:id`; a single job is derived client-side from `listJobs`
 * (see `useJob`) rather than added here as a synthetic call.
 */
import type {
  JobPatchRequest,
  JobSummary,
  JobUpsertRequest,
  RunDetail,
  RunSummary,
} from '@agent-hangar/core';

import { apiFetch } from '@/shared/api/client';

/**
 * Lists every scheduled job.
 *
 * @param signal - Aborts the request.
 * @returns The jobs, as returned by the server (unsorted).
 */
export async function listJobs(signal?: AbortSignal): Promise<JobSummary[]> {
  const result = await apiFetch('listJobs', signal === undefined ? {} : { signal });
  return result.jobs;
}

/**
 * Creates a scheduled job.
 *
 * @param body - The job fields.
 * @returns The created job.
 */
export async function createJob(body: JobUpsertRequest): Promise<JobSummary> {
  return apiFetch('createJob', { body });
}

/**
 * Updates a scheduled job.
 *
 * @param id - Job id.
 * @param patch - Fields to change.
 * @returns The updated job.
 */
export async function updateJob(id: string, patch: JobPatchRequest): Promise<JobSummary> {
  return apiFetch('updateJob', { params: { id }, body: patch });
}

/**
 * Deletes a scheduled job and its run history.
 *
 * @param id - Job id.
 */
export async function deleteJob(id: string): Promise<void> {
  await apiFetch('deleteJob', { params: { id } });
}

/**
 * Triggers a manual run of a job.
 *
 * @param id - Job id.
 * @returns The id of the created run.
 */
export async function runJob(id: string): Promise<string> {
  const result = await apiFetch('triggerRun', { params: { id } });
  return result.runId;
}

/**
 * Lists the runs of a job, newest first.
 *
 * @param jobId - Job id.
 * @param signal - Aborts the request.
 * @returns The job's runs.
 */
export async function listRuns(jobId: string, signal?: AbortSignal): Promise<RunSummary[]> {
  const result = await apiFetch(
    'listRuns',
    signal === undefined ? { params: { id: jobId } } : { params: { id: jobId }, signal },
  );
  return result.runs;
}

/**
 * Fetches one run's detail (status, output, tool calls).
 *
 * @param id - Run id.
 * @param signal - Aborts the request.
 * @returns The run detail.
 */
export async function getRun(id: string, signal?: AbortSignal): Promise<RunDetail> {
  return apiFetch('getRun', signal === undefined ? { params: { id } } : { params: { id }, signal });
}
