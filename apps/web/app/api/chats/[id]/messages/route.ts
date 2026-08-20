/**
 * `POST /api/chats/:id/messages`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { postMessage } from '@/server/handlers/chats';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the chat id.
 * @returns The queued turn.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return postMessage(getServerContainer(), request, await context.params);
}
