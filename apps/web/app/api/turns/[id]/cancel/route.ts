/**
 * `POST /api/turns/:id/cancel`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { cancelTurn } from '@/server/handlers/turns';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the turn id.
 * @returns An acknowledgement, `202` when the worker still has to act.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return cancelTurn(getServerContainer(), request, await context.params);
}
