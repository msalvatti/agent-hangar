/**
 * Query hook for a job's runs, polling while any run is active.
 *
 * Layer: hook.
 */
'use client';

import type { RunSummary } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

import { runsKey } from '../lib/query-keys';
import { listRuns } from '../services/scheduled-api';

/** How often a live run list reloads itself while a run is in progress. */
export const LIVE_POLL_MS = 10_000;

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
  // The option is omitted rather than set to `undefined` when polling is off: under
  // `exactOptionalPropertyTypes` an optional property accepts a value or no property at all.
  const polling = options.live ? { refetchIntervalMs: LIVE_POLL_MS } : {};
  return useApiQuery(runsKey(jobId), (signal) => listRuns(jobId, signal), polling);
}
