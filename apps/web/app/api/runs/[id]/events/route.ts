/**
 * `GET /api/runs/:id/events` — the SSE stream of one scheduled-job run.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { runEvents } from '@/server/handlers/events';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request; its abort signal ends the stream.
 * @param context - Route context carrying the run id.
 * @returns A `text/event-stream` response.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return runEvents(getServerContainer(), request, await context.params);
}
