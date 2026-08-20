/**
 * Scheduled job detail route.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

import { JobDetailView } from '@/features/scheduled';

export const metadata: Metadata = { title: 'Job — Agent Hangar' };

/**
 * Renders the job detail screen for `/scheduled/:id`.
 *
 * @param props - Route params (`id`).
 */
export default async function ScheduledJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JobDetailView jobId={id} />;
}
