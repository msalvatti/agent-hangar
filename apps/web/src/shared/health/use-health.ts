/**
 * Environment health, shared by everything that has to react to it.
 *
 * Layer: shared (hook).
 *
 * It lives here rather than in a feature because two of them need the same answer: the shell draws
 * the sidebar pill from it, and the chat composer refuses to send while the dependency that would
 * run the turn is down. Features do not import each other, so the meeting point is `shared/`.
 *
 * The shared `['health']` key makes one `invalidateQueries(['health'])` refresh every reader at
 * once; it does not pool the requests, because `useApiQuery` keeps no cache across mounts. Two
 * mounted readers therefore poll separately, which is affordable here and nowhere near worth a
 * cache: the route runs two bounded probes and one Redis read, for one user on their own machine.
 */
'use client';

import type { ApiResponse } from '@agent-hangar/core';

import { apiFetch } from '@/shared/api/client';
import { useApiQuery } from '@/shared/api/use-api-query';
import type { UseApiQueryResult } from '@/shared/api/use-api-query';

/**
 * How often the report is re-read while the tab is in use.
 *
 * The same period the worker rewrites its heartbeat with: Docker and the workspace image are that
 * heartbeat's readings, so polling faster would re-read a value that has not changed. A hidden tab
 * does not poll at all, and returning to it refetches at once.
 */
export const HEALTH_POLL_MS = 30_000;

/** Display name of each probe, in the order the dialog lists them. */
export const HEALTH_CHECK_LABELS = {
  db: 'Postgres',
  redis: 'Redis',
  worker: 'Worker',
  docker: 'Docker',
  image: 'Workspace image',
} as const;

/** Key of one probe in the health response. */
export type HealthCheckName = keyof typeof HEALTH_CHECK_LABELS;

/**
 * What to run to repair each probe.
 *
 * Shown only next to a failing check. Docker is the one that is not a command of this repository:
 * nothing here can start the daemon, so the instruction names the application instead.
 */
export const HEALTH_CHECK_FIX: Record<HealthCheckName, string> = {
  db: 'pnpm infra:up',
  redis: 'pnpm infra:up',
  worker: 'pnpm dev',
  docker: 'start Docker Desktop',
  image: 'pnpm infra:image',
};

/**
 * Every probe name, in display order.
 *
 * The worker comes before Docker and the image because it is what measures them: when it is
 * silent those two are unknown rather than broken, and reading the list top-down then names the
 * thing to fix first.
 */
export const HEALTH_CHECK_NAMES: readonly HealthCheckName[] = [
  'db',
  'redis',
  'worker',
  'docker',
  'image',
] as const;

/** Result of {@link useHealth}. */
export interface UseHealthResult extends UseApiQueryResult<ApiResponse<'getHealth'>> {
  /** `true` once a report has arrived and every probe passed. */
  ok: boolean;
  /** Names of the failing probes, in display order; empty until a report has arrived. */
  failingChecks: readonly HealthCheckName[];
  /** Display names of the failing probes. */
  failing: readonly string[];
}

/**
 * Reads the environment health.
 *
 * @param signal - Aborts the request.
 * @returns The health report.
 */
export function getHealth(signal: AbortSignal): Promise<ApiResponse<'getHealth'>> {
  return apiFetch('getHealth', { signal });
}

/**
 * Polls `GET /api/health` and derives the state its readers render from it.
 *
 * @returns The query result plus the derived `ok` flag and the failing probes.
 */
export function useHealth(): UseHealthResult {
  const query = useApiQuery(['health'], (signal) => getHealth(signal), {
    refetchIntervalMs: HEALTH_POLL_MS,
    refetchOnWindowFocus: true,
  });
  const checks = query.data?.checks;
  const failingChecks =
    checks === undefined ? [] : HEALTH_CHECK_NAMES.filter((name) => !checks[name].ok);
  return {
    ...query,
    ok: query.data !== undefined && failingChecks.length === 0,
    failingChecks,
    failing: failingChecks.map((name) => HEALTH_CHECK_LABELS[name]),
  };
}
