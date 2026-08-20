/**
 * Public API of the shared health module.
 *
 * Layer: shared (barrel).
 */
export {
  getHealth,
  HEALTH_CHECK_FIX,
  HEALTH_CHECK_LABELS,
  HEALTH_CHECK_NAMES,
  HEALTH_POLL_MS,
  useHealth,
} from './use-health';
export type { HealthCheckName, UseHealthResult } from './use-health';
