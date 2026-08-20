/**
 * Job-detail run actions: manual run, stop, copy id.
 *
 * Layer: hook.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { useCallback } from 'react';
import { toast } from 'sonner';

import { ApiClientError } from '@/shared/api/client';
import { invalidateQueries } from '@/shared/api/use-api-query';

import { cancelRun, runJob } from '../services/scheduled-api';

/** Result of {@link useRunActions}. */
export interface UseRunActionsResult {
  /** Triggers a manual run of `job`; a 409 (overlap) is toasted rather than thrown. */
  runNow: (job: JobSummary) => Promise<void>;
  /** Requests cancellation of an active run. */
  stop: (runId: string) => Promise<void>;
  /** Copies a run id to the clipboard. */
  copyId: (runId: string) => Promise<void>;
}

/**
 * Job-detail run actions, each toasting its outcome and invalidating the affected queries.
 *
 * @returns The action callbacks.
 */
export function useRunActions(): UseRunActionsResult {
  const runNow = useCallback(async (job: JobSummary) => {
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
    }
  }, []);

  const stop = useCallback(async (runId: string) => {
    try {
      await cancelRun(runId);
      toast.success('Stop requested');
      invalidateQueries(['run', runId]);
    } catch {
      toast.error('Could not stop run');
    }
  }, []);

  const copyId = useCallback(async (runId: string) => {
    try {
      await navigator.clipboard.writeText(runId);
      toast.success('Run id copied');
    } catch {
      toast.error('Could not copy run id');
    }
  }, []);

  return { runNow, stop, copyId };
}
