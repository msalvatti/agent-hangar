/**
 * Maps the `/api/health` response onto the shape the environment card renders.
 *
 * Layer: lib (pure).
 *
 * The labels and their order come from the shared health module, so the card and the sidebar
 * dialog name the same probe the same way and a check added to the contract reaches both.
 */
import type { HealthResponse } from '@agent-hangar/core';

import { HEALTH_CHECK_LABELS, HEALTH_CHECK_NAMES } from '@/shared/health';
import type { HealthCheckName } from '@/shared/health';

/** One health check, ready for display. */
export interface HealthCheckSummary {
  id: HealthCheckName;
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

/**
 * Maps a health response onto a labelled, ordered list of checks for the environment card.
 *
 * @param health - The `GET /api/health` response.
 * @returns The instance name, one summary per check, and whether every check is healthy.
 */
export function summarizeHealth(health: HealthResponse): HealthSummary {
  const checks = HEALTH_CHECK_NAMES.map((id) => {
    const check = health.checks[id];
    return { id, label: HEALTH_CHECK_LABELS[id], ok: check.ok, detail: check.detail };
  });
  return { instance: health.instance, checks, allOk: health.ok };
}
