/**
 * `GET /api/chats/:id/events` — the SSE transcript stream.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { chatEvents } from '@/server/handlers/events';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request; its abort signal ends the stream.
 * @param context - Route context carrying the chat id.
 * @returns A `text/event-stream` response.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return chatEvents(getServerContainer(), request, await context.params);
}
