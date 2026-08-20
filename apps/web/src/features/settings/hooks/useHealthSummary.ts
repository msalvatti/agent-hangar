/**
 * Query hook for the environment card's health summary, polling every 30 s.
 *
 * Layer: hook.
 */
'use client';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';
import { getHealth } from '@/shared/health';

import { summarizeHealth } from '../lib/health';
import type { HealthSummary } from '../lib/health';

const REFETCH_INTERVAL_MS = 30_000;

/**
 * Loads and summarizes `/api/health`, registered under the `['health']` query key, polling every
 * 30 s so the environment card stays current without a manual refresh.
 *
 * @returns The health summary query state.
 */
export function useHealthSummary(): UseApiQueryResult<HealthSummary> {
  return useApiQuery(
    ['health'],
    async (signal) => {
      const health = await getHealth(signal);
      return summarizeHealth(health);
    },
    { refetchIntervalMs: REFETCH_INTERVAL_MS },
  );
}
