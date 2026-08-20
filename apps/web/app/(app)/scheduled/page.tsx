/**
 * Scheduled jobs route.
 *
 * Layer: screen.
 */
import type { Metadata } from 'next';

import { ScheduledView } from '@/features/scheduled';

export const metadata: Metadata = { title: 'Scheduled — Agent Hangar' };

/** Renders the scheduled-jobs list screen. */
export default function ScheduledPage() {
  return <ScheduledView />;
}
