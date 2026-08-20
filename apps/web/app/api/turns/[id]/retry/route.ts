/**
 * `POST /api/turns/:id/retry`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { retryTurn } from '@/server/handlers/turns';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the turn id.
 * @returns An acknowledgement once the failed turn is back on the queue.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return retryTurn(getServerContainer(), request, await context.params);
}
