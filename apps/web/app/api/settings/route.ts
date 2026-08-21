/**
 * `GET /api/settings`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { getSettings } from '@/server/handlers/settings';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @returns The masked status of the stored credentials.
 */
export function GET(request: Request): Promise<Response> {
  return getSettings(getServerContainer(), request);
}
