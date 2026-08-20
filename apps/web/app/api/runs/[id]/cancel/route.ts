/**
 * `POST /api/runs/:id/cancel`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { cancelRun } from '@/server/handlers/runs';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the run id.
 * @returns An acknowledgement, `202` when the worker still has to act.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return cancelRun(getServerContainer(), request, await context.params);
}
