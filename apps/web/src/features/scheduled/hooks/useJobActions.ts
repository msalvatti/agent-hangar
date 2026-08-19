/**
 * Row-level mutations for the scheduled-jobs list: toggle, run now, delete.
 *
 * Layer: hook.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { ApiClientError } from '@/shared/api/client';
import { invalidateQueries } from '@/shared/api/use-api-query';

import { deleteJob, runJob, updateJob } from '../services/scheduled-api';

/** Result of {@link useJobActions}. */
export interface UseJobActionsResult {
  /** Toggles `enabled`, optimistically, rolling back on error. */
  toggleEnabled: (job: JobSummary, enabled: boolean) => Promise<void>;
  /** Triggers a manual run; a 409 (overlap) is toasted rather than thrown. */
  runNow: (job: JobSummary) => Promise<void>;
  /** Deletes a job and its run history. */
  remove: (job: JobSummary) => Promise<void>;
  /** Whether a mutation is in flight for a given job id. */
  pending: Readonly<Record<string, boolean>>;
  /** Optimistic `enabled` override per job id, cleared once the list query refetches. */
  overrides: Readonly<Record<string, boolean>>;
}

function withEntry(
  map: Readonly<Record<string, boolean>>,
  key: string,
  value: boolean,
): Record<string, boolean> {
  return { ...map, [key]: value };
}

function withoutEntry(
  map: Readonly<Record<string, boolean>>,
  key: string,
): Record<string, boolean> {
  return Object.fromEntries(Object.entries(map).filter(([entryKey]) => entryKey !== key));
}

/**
 * Row actions for the scheduled-jobs list: optimistic enable toggle, manual run, delete.
 *
 * @returns The action callbacks plus per-job pending/override state for the table to render.
 */
export function useJobActions(): UseJobActionsResult {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const toggleEnabled = useCallback(async (job: JobSummary, enabled: boolean) => {
    setOverrides((prev) => withEntry(prev, job.id, enabled));
    setPending((prev) => withEntry(prev, job.id, true));
    try {
      await updateJob(job.id, { enabled });
      invalidateQueries(['jobs']);
    } catch {
      setOverrides((prev) => withoutEntry(prev, job.id));
      toast.error('Could not update job');
    } finally {
      setPending((prev) => withoutEntry(prev, job.id));
    }
  }, []);

  const runNow = useCallback(async (job: JobSummary) => {
    setPending((prev) => withEntry(prev, job.id, true));
    try {
      await runJob(job.id);
      toast.success('Run started');
      invalidateQueries(['runs', job.id]);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 409) {
        toast.error('Skipped: previous run still running');
      } else {
        toast.error('Could not start run');
      }
    } finally {
      setPending((prev) => withoutEntry(prev, job.id));
    }
  }, []);

  const remove = useCallback(async (job: JobSummary) => {
    setPending((prev) => withEntry(prev, job.id, true));
    try {
      await deleteJob(job.id);
      toast.success('Job deleted');
      invalidateQueries(['jobs']);
    } catch {
      toast.error('Could not delete job');
    } finally {
      setPending((prev) => withoutEntry(prev, job.id));
    }
  }, []);

  return { toggleEnabled, runNow, remove, pending, overrides };
}
