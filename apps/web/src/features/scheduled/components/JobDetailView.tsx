/**
 * `/scheduled/[id]` detail screen: header, runs table, run drawer, and empty/loading/error states.
 *
 * Layer: component (screen).
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { History } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { EmptyState, ErrorCard } from '@/shared/feedback';
import { PageHeader } from '@/shared/shell/PageHeader';
import { Button } from '@/shared/ui/button';

import { useJob } from '../hooks/useJob';
import { resolveEnabled, useJobActions } from '../hooks/useJobActions';
import { useRunActions } from '../hooks/useRunActions';
import { useRuns } from '../hooks/useRuns';

import { DeleteJobDialog } from './DeleteJobDialog';
import { JobDialog } from './JobDialog';
import { JobHeader } from './JobHeader';
import { RunDrawer } from './RunDrawer';
import { RunsSkeleton } from './RunsSkeleton';
import { RunsTable } from './RunsTable';

/** Props of {@link JobDetailView}. */
export interface JobDetailViewProps {
  jobId: string;
}

/**
 * The job detail screen: header, runs table, and the run drawer (deep-linkable via `?run=`).
 *
 * @param props - The job id from the route.
 */
export function JobDetailView({ jobId }: JobDetailViewProps) {
  const jobQuery = useJob(jobId);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const drawerRunId = searchParams.get('run');

  const { toggleEnabled, remove, pending, overrides } = useJobActions();
  const { runNow } = useRunActions();

  const runsQuery = useRuns(jobId, { live: true });
  const job = jobQuery.data;
  // Computed on every render (rather than inline in the error card below) so both sides of the
  // fallback are exercised across the component's normal render cycle: `runsQuery.error` is
  // `undefined` on every render before a failure, and only becomes set together with `status`.
  const runsErrorMessage = runsQuery.error?.message ?? '';
  const jobErrorMessage = jobQuery.error?.message ?? '';

  const openDrawer = (runId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('run', runId);
    router.replace(`/scheduled/${jobId}?${next.toString()}`);
  };
  const closeDrawer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('run');
    const query = next.toString();
    router.replace(`/scheduled/${jobId}${query.length > 0 ? `?${query}` : ''}`);
  };

  // Both take the job explicitly rather than reading the outer `job` from closure, so every call
  // site narrows it from a `job !== undefined` guard already in scope instead of asserting it.
  const handleRunNow = async (currentJob: JobSummary) => {
    setRunningNow(true);
    await runNow(currentJob);
    setRunningNow(false);
  };

  // Navigating back is the claim that the job is gone, so it only happens when the request
  // actually succeeded; a failure leaves the user on the page the job still has.
  const confirmDelete = async (currentJob: JobSummary) => {
    setDeleting(true);
    const deleted = await remove(currentJob);
    setDeleting(false);
    if (deleted) {
      router.push('/scheduled');
    }
  };

  if (jobQuery.status === 'error') {
    return (
      <div className="flex flex-col gap-4 p-6">
        <PageHeader title="Job" />
        <ErrorCard
          title="Could not load the job"
          message={jobErrorMessage}
          actions={<Button onClick={() => void jobQuery.refetch()}>Retry</Button>}
        />
      </div>
    );
  }

  if (jobQuery.notFound) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <PageHeader title="Job" />
        <ErrorCard
          title="Job not found"
          message="This job may have been deleted."
          actions={
            <Button
              onClick={() => {
                router.push('/scheduled');
              }}
            >
              Back to scheduled jobs
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      {job === undefined ? (
        <PageHeader title="Job" />
      ) : (
        <JobHeader
          // The optimistic override covers the gap until `useJob`'s own `['job', id]` refetch
          // settles; it is the same mechanism the jobs list uses.
          job={{ ...job, enabled: resolveEnabled(job, overrides) }}
          busy={runningNow}
          toggling={pending[job.id] === true}
          onEdit={() => {
            setEditOpen(true);
          }}
          onDelete={() => {
            setDeleteOpen(true);
          }}
          onToggle={(enabled) => {
            void toggleEnabled(job, enabled);
          }}
          onRunNow={() => {
            void handleRunNow(job);
          }}
        />
      )}
      <h2 className="text-muted-foreground text-[11px] uppercase">Runs</h2>
      {runsQuery.data === undefined && runsQuery.status === 'error' && (
        <ErrorCard
          title="Could not load runs"
          message={runsErrorMessage}
          actions={<Button onClick={() => void runsQuery.refetch()}>Retry</Button>}
        />
      )}
      {runsQuery.data === undefined && runsQuery.status !== 'error' && <RunsSkeleton />}
      {job !== undefined && runsQuery.data?.length === 0 && (
        <EmptyState
          icon={History}
          title="No runs yet."
          description="Run now to start one in a fresh workspace."
          action={
            <Button
              onClick={() => {
                void handleRunNow(job);
              }}
            >
              Run now
            </Button>
          }
        />
      )}
      {runsQuery.data !== undefined && runsQuery.data.length > 0 && (
        <RunsTable runs={runsQuery.data} onOpen={openDrawer} />
      )}
      {job !== undefined && <JobDialog open={editOpen} job={job} onOpenChange={setEditOpen} />}
      {job !== undefined && (
        <DeleteJobDialog
          job={job}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onConfirm={() => {
            void confirmDelete(job);
          }}
          busy={deleting}
        />
      )}
      <RunDrawer
        runId={drawerRunId}
        job={job}
        open={drawerRunId !== null}
        // `open` here is fully controlled by the `?run=` param above, so the sheet's own
        // `onOpenChange` — fired by Escape/overlay-click — only ever signals a close.
        onOpenChange={closeDrawer}
      />
    </div>
  );
}
