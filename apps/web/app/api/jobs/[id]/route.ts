/**
 * `GET`, `PATCH` and `DELETE /api/jobs/:id`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { deleteJob, getJob, updateJob } from '@/server/handlers/jobs';

export const dynamic = 'force-dynamic';

/** Resolved path parameters of this route. */
interface Context {
  params: Promise<{ id: string }>;
}

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the job id.
 * @returns The job.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  return getJob(getServerContainer(), request, await context.params);
}

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the job id.
 * @returns The updated job.
 */
export async function PATCH(request: Request, context: Context): Promise<Response> {
  return updateJob(getServerContainer(), request, await context.params);
}

/**
 * @param request - The incoming request.
 * @param context - Route context carrying the job id.
 * @returns An empty `204`.
 */
export async function DELETE(request: Request, context: Context): Promise<Response> {
  return deleteJob(getServerContainer(), request, await context.params);
}
