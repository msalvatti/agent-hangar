/**
 * `/scheduled` list screen: header, jobs table, and empty/loading/error states.
 *
 * Layer: component (screen).
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { ErrorCard } from '@/shared/feedback';
import { PageHeader } from '@/shared/shell/PageHeader';
import { Button } from '@/shared/ui/button';

import { useJobActions } from '../hooks/useJobActions';
import { useJobs } from '../hooks/useJobs';

import { DeleteJobDialog } from './DeleteJobDialog';
import { JobsEmptyState } from './JobsEmptyState';
import { JobsSkeleton } from './JobsSkeleton';
import { JobsTable } from './JobsTable';

/** Props of {@link ScheduledView}. */
export interface ScheduledViewProps {
  /** Opens the job dialog in create mode. Provided by 1H.3; a no-op placeholder until then. */
  onNewJob?: () => void;
  /** Opens the job dialog in edit mode. Provided by 1H.3; a no-op placeholder until then. */
  onEditJob?: (job: JobSummary) => void;
}

/**
 * The scheduled-jobs list screen: header with "New job", the jobs table, and its
 * empty/loading/error states.
 *
 * @param props - Callbacks the job dialog (1H.3) wires up.
 */
export function ScheduledView({ onNewJob, onEditJob }: ScheduledViewProps) {
  const { status, data, error, refetch } = useJobs();
  const { toggleEnabled, runNow, remove, pending, overrides } = useJobActions();
  const [pendingDelete, setPendingDelete] = useState<JobSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleNewJob = () => {
    onNewJob?.();
  };
  const handleEditJob = (job: JobSummary) => {
    onEditJob?.(job);
  };
  const handleRetry = () => {
    void refetch();
  };

  const confirmDelete = async (job: JobSummary) => {
    setDeleting(true);
    await remove(job);
    setDeleting(false);
    setPendingDelete(null);
  };

  const errorMessage = error?.message ?? '';

  return (
    <div className="flex flex-col gap-4 p-6">
      <PageHeader
        title="Scheduled jobs"
        actions={
          <Button onClick={handleNewJob}>
            <Plus /> New job
          </Button>
        }
      />
      {data === undefined && status === 'error' && (
        <ErrorCard
          title="Could not load scheduled jobs"
          message={errorMessage}
          actions={<Button onClick={handleRetry}>Retry</Button>}
        />
      )}
      {data === undefined && status !== 'error' && <JobsSkeleton />}
      {data?.length === 0 && <JobsEmptyState onCreate={handleNewJob} />}
      {data !== undefined && data.length > 0 && (
        <JobsTable
          jobs={data}
          overrides={overrides}
          pending={pending}
          onToggle={(job, enabled) => {
            void toggleEnabled(job, enabled);
          }}
          onEdit={handleEditJob}
          onRunNow={(job) => {
            void runNow(job);
          }}
          onDelete={(job) => {
            setPendingDelete(job);
          }}
        />
      )}
      {pendingDelete !== null && (
        <DeleteJobDialog
          job={pendingDelete}
          open
          onOpenChange={() => {
            // No `AlertDialogTrigger` renders this dialog open; `open` stays externally
            // controlled by `pendingDelete`, so every callback here is a close request
            // (Escape, backdrop click, or Cancel).
            setPendingDelete(null);
          }}
          onConfirm={() => {
            void confirmDelete(pendingDelete);
          }}
          busy={deleting}
        />
      )}
    </div>
  );
}
