/**
 * Environment health for the sidebar footer pill and the details dialog.
 *
 * Layer: feature (hook).
 */
'use client';

import type { ApiResponse } from '@agent-hangar/core';

import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

import { getHealth } from '../services/shell-api';

/** How often the pill re-checks while the tab is in use. */
export const HEALTH_POLL_MS = 30_000;

/** Display name of each probe, in the order the dialog lists them. */
export const HEALTH_CHECK_LABELS = {
  db: 'Postgres',
  redis: 'Redis',
  docker: 'Docker',
  image: 'Workspace image',
} as const;

/** Key of one probe in the health response. */
export type HealthCheckName = keyof typeof HEALTH_CHECK_LABELS;

/** Every probe name, in display order. */
export const HEALTH_CHECK_NAMES: readonly HealthCheckName[] = [
  'db',
  'redis',
  'docker',
  'image',
] as const;

/** Result of {@link useHealth}. */
export interface UseHealthResult extends UseApiQueryResult<ApiResponse<'getHealth'>> {
  /** `true` once a report has arrived and every probe passed. */
  ok: boolean;
  /** Display names of the failing probes. */
  failing: readonly string[];
}

/**
 * Polls `GET /api/health` and derives the pill's state from it.
 *
 * @returns The query result plus the derived `ok` flag and failing probe names.
 */
export function useHealth(): UseHealthResult {
  const query = useApiQuery(['health'], (signal) => getHealth(signal), {
    refetchIntervalMs: HEALTH_POLL_MS,
    refetchOnWindowFocus: true,
  });
  const checks = query.data?.checks;
  const failing =
    checks === undefined
      ? []
      : HEALTH_CHECK_NAMES.filter((name) => !checks[name].ok).map(
          (name) => HEALTH_CHECK_LABELS[name],
        );
  return { ...query, ok: query.data !== undefined && failing.length === 0, failing };
}
