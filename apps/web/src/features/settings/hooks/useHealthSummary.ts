/**
 * Query hook for the environment card's health summary.
 *
 * Layer: hook.
 */
'use client';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';
import { getHealth, HEALTH_POLL_MS } from '@/shared/health';

import { summarizeHealth } from '../lib/health';
import type { HealthSummary } from '../lib/health';

/**
 * Loads and summarizes `/api/health`, registered under the `['health']` query key, on the same
 * period as the sidebar pill so the two cannot disagree about how current they are.
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
    { refetchIntervalMs: HEALTH_POLL_MS },
  );
}
