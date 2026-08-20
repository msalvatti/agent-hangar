/**
 * `GET /api/jobs` and `POST /api/jobs`.
 *
 * Layer: route (wiring only).
 */
import { getServerContainer } from '@/server/container';
import { createJob, listJobs } from '@/server/handlers/jobs';

export const dynamic = 'force-dynamic';

/**
 * @returns Every scheduled job.
 */
export function GET(): Promise<Response> {
  return listJobs(getServerContainer());
}

/**
 * @param request - The incoming request.
 * @returns The created job.
 */
export function POST(request: Request): Promise<Response> {
  return createJob(getServerContainer(), request);
}
