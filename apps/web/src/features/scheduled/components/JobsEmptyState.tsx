/**
 * Empty state for the jobs table: no scheduled jobs yet.
 *
 * Layer: component.
 */
'use client';

import { CalendarClock } from 'lucide-react';

import { EmptyState } from '@/shared/feedback';
import { Button } from '@/shared/ui/button';

/** Props of {@link JobsEmptyState}. */
export interface JobsEmptyStateProps {
  onCreate: () => void;
}

/**
 * Renders the empty state shown when no scheduled jobs exist yet.
 *
 * @param props - Callback for the "New job" action.
 */
export function JobsEmptyState({ onCreate }: JobsEmptyStateProps) {
  return (
    <EmptyState
      icon={CalendarClock}
      title="No scheduled jobs yet."
      description="Jobs run your prompt in a fresh workspace on a cron schedule."
      action={<Button onClick={onCreate}>New job</Button>}
    />
  );
}
