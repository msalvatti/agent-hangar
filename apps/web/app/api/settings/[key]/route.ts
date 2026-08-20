/**
 * `PUT` and `DELETE /api/settings/:key`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { deleteSetting, putSetting } from '@/server/handlers/settings';

export const dynamic = 'force-dynamic';

/** Resolved path parameters of this route. */
interface Context {
  params: Promise<{ key: string }>;
}

/**
 * @param request - The incoming request; its body is the only plaintext credential in the system.
 * @param context - Route context carrying the setting key.
 * @returns The masked confirmation.
 */
export async function PUT(request: Request, context: Context): Promise<Response> {
  return putSetting(getServerContainer(), request, await context.params);
}

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the setting key.
 * @returns An empty `204`.
 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return deleteSetting(getServerContainer(), request, await context.params);
}
