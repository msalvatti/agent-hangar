/**
 * `POST /api/chats/:id/restore`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { restoreChat } from '@/server/handlers/chats';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the chat id.
 * @returns The reactivated chat.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return restoreChat(getServerContainer(), request, await context.params);
}
