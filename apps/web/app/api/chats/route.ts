/**
 * `GET /api/chats` and `POST /api/chats`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { createChat, listChats } from '@/server/handlers/chats';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @returns The sidebar list.
 */
export function GET(request: Request): Promise<Response> {
  return listChats(getServerContainer(), request);
}

/**
 * @param request - The incoming request.
 * @returns The created chat and its first turn.
 */
export function POST(request: Request): Promise<Response> {
  return createChat(getServerContainer(), request);
}
