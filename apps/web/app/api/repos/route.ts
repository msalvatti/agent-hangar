/**
 * `GET /api/repos`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { listRepos } from '@/server/handlers/repos';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @returns The repositories the stored token can reach.
 */
export function GET(request: Request): Promise<Response> {
  return listRepos(getServerContainer(), request);
}
