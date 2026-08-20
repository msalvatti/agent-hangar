/**
 * Query hook for the scheduled-jobs list.
 *
 * Layer: hook.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

import { listJobs } from '../services/scheduled-api';

/**
 * Loads every scheduled job, registered under the `['jobs']` query key.
 *
 * @returns The jobs query state.
 */
export function useJobs(): UseApiQueryResult<JobSummary[]> {
  return useApiQuery(['jobs'], (signal) => listJobs(signal));
}
