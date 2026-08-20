/**
 * `POST /api/chats/:id/archive`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { archiveChat } from '@/server/handlers/chats';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the chat id.
 * @returns The archived chat.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return archiveChat(getServerContainer(), request, await context.params);
}
