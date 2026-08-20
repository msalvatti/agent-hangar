/**
 * `GET`, `PATCH` and `DELETE /api/chats/:id`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { deleteChat, getChat, renameChat } from '@/server/handlers/chats';

export const dynamic = 'force-dynamic';

/** Resolved path parameters of this route. */
interface Context {
  params: Promise<{ id: string }>;
}

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the chat id.
 * @returns The chat with its history.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  return getChat(getServerContainer(), request, await context.params);
}

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the chat id.
 * @returns The renamed chat.
 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return renameChat(getServerContainer(), request, await context.params);
}

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the chat id.
 * @returns An empty `204`.
 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return deleteChat(getServerContainer(), request, await context.params);
}
