/**
 * `GET /api/repos/branches`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { listBranches } from '@/server/handlers/repos';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @returns The branches of the requested repository.
 */
export function GET(request: Request): Promise<Response> {
  return listBranches(getServerContainer(), request);
}
