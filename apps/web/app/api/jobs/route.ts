/**
 * `GET /api/jobs` and `POST /api/jobs`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { createJob, listJobs } from '@/server/handlers/jobs';

export const dynamic = 'force-dynamic';

/**
 * @param request - The incoming request.
 * @returns Every scheduled job.
 */
export function GET(request: Request): Promise<Response> {
  return listJobs(getServerContainer(), request);
}

/**
 * @param request - The incoming request.
 * @returns The created job.
 */
export function POST(request: Request): Promise<Response> {
  return createJob(getServerContainer(), request);
}
