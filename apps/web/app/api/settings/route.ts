/**
 * `GET /api/settings`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { getSettings } from '@/server/handlers/settings';

export const dynamic = 'force-dynamic';

/**
 * @returns The masked status of the stored credentials.
 */
export function GET(): Promise<Response> {
  return getSettings(getServerContainer());
}
