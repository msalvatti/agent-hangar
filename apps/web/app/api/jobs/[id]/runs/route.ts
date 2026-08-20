/**
 * `GET /api/jobs/:id/runs`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { listRuns } from '@/server/handlers/runs';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the job id.
 * @returns The run history.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return listRuns(getServerContainer(), request, await context.params);
}
