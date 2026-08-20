/**
 * Maps the `/api/health` response onto the shape the environment card renders.
 *
 * Layer: lib (pure).
 */
import type { HealthResponse } from '@agent-hangar/core';

/** One health check, ready for display. */
export interface HealthCheckSummary {
  id: keyof HealthResponse['checks'];
  label: string;
  ok: boolean;
  detail?: string | undefined;
}

/** Result of {@link summarizeHealth}. */
export interface HealthSummary {
  instance: string;
  checks: HealthCheckSummary[];
  allOk: boolean;
}

/** Display label of each `HealthResponse.checks` entry, in the order they are shown. */
const CHECK_LABELS: Record<keyof HealthResponse['checks'], string> = {
  db: 'Postgres',
  redis: 'Redis',
  docker: 'Docker',
  image: 'Workspace image',
};

const CHECK_IDS = Object.keys(CHECK_LABELS) as (keyof HealthResponse['checks'])[];

/**
 * Maps a health response onto a labelled, ordered list of checks for the environment card.
 *
 * @param health - The `GET /api/health` response.
 * @returns The instance name, one summary per check, and whether every check is healthy.
 */
export function summarizeHealth(health: HealthResponse): HealthSummary {
  const checks = CHECK_IDS.map((id) => {
    const check = health.checks[id];
    return { id, label: CHECK_LABELS[id], ok: check.ok, detail: check.detail };
  });
  return { instance: health.instance, checks, allOk: health.ok };
}
