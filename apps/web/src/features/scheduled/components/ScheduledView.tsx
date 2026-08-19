/**
 * `/scheduled` list screen: header, jobs table, job dialog, and empty/loading/error states.
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
import { JobDialog } from './JobDialog';
import { JobsEmptyState } from './JobsEmptyState';
import { JobsSkeleton } from './JobsSkeleton';
import { JobsTable } from './JobsTable';

/** State of the create/edit dialog: closed, or open for create (`null`) or edit (a job). */
interface JobDialogState {
  open: boolean;
  job: JobSummary | null;
}

const CLOSED_DIALOG: JobDialogState = { open: false, job: null };

/**
 * The scheduled-jobs list screen: header with "New job", the jobs table, the create/edit dialog,
 * and empty/loading/error states.
 */
export function ScheduledView() {
  const { status, data, error, refetch } = useJobs();
  const { toggleEnabled, runNow, remove, pending, overrides } = useJobActions();
  const [pendingDelete, setPendingDelete] = useState<JobSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dialog, setDialog] = useState<JobDialogState>(CLOSED_DIALOG);

  const openNewJobDialog = () => {
    setDialog({ open: true, job: null });
  };
  const openEditJobDialog = (job: JobSummary) => {
    setDialog({ open: true, job });
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
          <Button onClick={openNewJobDialog}>
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
      {data?.length === 0 && <JobsEmptyState onCreate={openNewJobDialog} />}
      {data !== undefined && data.length > 0 && (
        <JobsTable
          jobs={data}
          overrides={overrides}
          pending={pending}
          onToggle={(job, enabled) => {
            void toggleEnabled(job, enabled);
          }}
          onEdit={openEditJobDialog}
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
      <JobDialog
        open={dialog.open}
        job={dialog.job}
        onOpenChange={(open) => {
          setDialog((previous) => ({ ...previous, open }));
        }}
      />
    </div>
  );
}
