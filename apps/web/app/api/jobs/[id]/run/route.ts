/**
 * `POST /api/jobs/:id/run`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { triggerRun } from '@/server/handlers/jobs';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the job id.
 * @returns The created run.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return triggerRun(getServerContainer(), request, await context.params);
}
