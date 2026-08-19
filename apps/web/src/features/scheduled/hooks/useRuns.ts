/**
 * Query hook for a job's runs, polling while any run is active.
 *
 * Layer: hook.
 */
'use client';

import type { RunSummary } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

import { listRuns } from '../services/scheduled-api';

const LIVE_POLL_MS = 10_000;

/** Options of {@link useRuns}. */
export interface UseRunsOptions {
  /** Polls every 10 s while `true` (an active run may still be progressing server-side). */
  live: boolean;
}

/**
 * Loads a job's runs, newest first, polling every 10 s while `live`.
 *
 * @param jobId - Job id.
 * @param options - `live` polling flag.
 * @returns The runs query state.
 */
export function useRuns(jobId: string, options: UseRunsOptions): UseApiQueryResult<RunSummary[]> {
  return useApiQuery(['runs', jobId], (signal) => listRuns(jobId, signal), {
    refetchIntervalMs: options.live ? LIVE_POLL_MS : undefined,
  });
}
