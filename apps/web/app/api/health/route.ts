/**
 * `GET /api/health`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { getHealth } from '@/server/handlers/health';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @returns Reachability of the database, Redis, Docker and the workspace image.
 */
export function GET(request: Request): Promise<Response> {
  return getHealth(getServerContainer(), request);
}
