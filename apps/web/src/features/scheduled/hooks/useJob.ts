/**
 * Query hook for one scheduled job, derived from the jobs list.
 *
 * Layer: hook.
 *
 * The API contract has no `GET /api/jobs/:id`; deriving from `listJobs` avoids adding a route
 * that exists only to serve the detail page.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';

import { jobKey } from '../lib/query-keys';
import { listJobs } from '../services/scheduled-api';

/** Result of {@link useJob}. */
export interface UseJobResult {
  status: 'idle' | 'loading' | 'success' | 'error';
  data: JobSummary | undefined;
  /** `true` once the jobs list has loaded and no job with this id exists in it. */
  notFound: boolean;
  error: Error | undefined;
  refetch: () => Promise<void>;
}

/**
 * Loads one job by id, from the shared `['job', id]` query key.
 *
 * @param id - Job id.
 * @returns The job (once loaded), a `notFound` flag, and the query's status/error/refetch.
 */
export function useJob(id: string): UseJobResult {
  const query = useApiQuery(jobKey(id), (signal) => listJobs(signal));
  const job = query.data?.find((candidate) => candidate.id === id);
  return {
    status: query.status,
    data: job,
    notFound: query.status === 'success' && job === undefined,
    error: query.error,
    refetch: query.refetch,
  };
}
