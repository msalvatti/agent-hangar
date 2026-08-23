/**
 * Query hook for one run's persisted detail.
 *
 * Layer: hook.
 */
'use client';

import type { RunDetail } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

import { runKey } from '../lib/query-keys';
import { getRun } from '../services/scheduled-api';

/**
 * Builds the loader `useRun` passes to `useApiQuery`. A pure, exported function so its `runId ===
 * null` guard — otherwise unreachable through the hook itself, since `enabled: false` means the
 * loader never actually runs while `runId` is `null` — is directly testable.
 *
 * @param runId - Run id, or `null` when no run is selected.
 * @returns A loader rejecting immediately when `runId` is `null`, fetching the run otherwise.
 */
export function buildRunLoader(runId: string | null): (signal: AbortSignal) => Promise<RunDetail> {
  return (signal) => {
    if (runId === null) {
      return Promise.reject(new Error('useRun called with no run id'));
    }
    return getRun(runId, signal);
  };
}

/**
 * Stands in for the run id while no run is selected.
 *
 * The query is disabled in that state, so nothing is ever fetched under this key; it exists
 * because a key is a string list and there is no run to name. Written out rather than empty so it
 * cannot collide with a real run's key.
 */
const NO_RUN = 'none';

/**
 * Loads one run's detail; disabled (no request) while `runId` is `null`.
 *
 * @param runId - Run id, or `null` when no run is selected.
 * @returns The run detail query state.
 */
export function useRun(runId: string | null): UseApiQueryResult<RunDetail> {
  return useApiQuery(runKey(runId ?? NO_RUN), buildRunLoader(runId), { enabled: runId !== null });
}
