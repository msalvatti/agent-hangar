/**
 * `GET /api/runs/:id`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { getRun } from '@/server/handlers/runs';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the run id.
 * @returns The run with its output and tool calls.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return getRun(getServerContainer(), request, await context.params);
}
