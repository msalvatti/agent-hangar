/**
 * Create/update mutation for the job dialog.
 *
 * Layer: hook.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import { ApiClientError } from '@/shared/api/client';
import { invalidateQueries } from '@/shared/api/use-api-query';

import { formToRequest } from '../lib/job-form';
import type { JobFormValues } from '../lib/job-form';
import { createJob, updateJob } from '../services/scheduled-api';

/** Result of {@link useJobMutations}. */
export interface UseJobMutationsResult {
  /** Creates a job (no `jobId`) or updates one (with `jobId`); resolves `true` on success. */
  save: (values: JobFormValues, jobId?: string) => Promise<JobSummary | null>;
  busy: boolean;
  error: string | null;
  clearError: () => void;
}

/**
 * Saves a job form: create when no id is given, update otherwise.
 *
 * @returns The save action plus its busy/error state.
 */
export function useJobMutations(): UseJobMutationsResult {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(async (values: JobFormValues, jobId?: string) => {
    setBusy(true);
    setError(null);

    let job: JobSummary;
    try {
      const body = formToRequest(values);
      job = jobId === undefined ? await createJob(body) : await updateJob(jobId, body);
    } catch (reason) {
      setError(reason instanceof ApiClientError ? reason.message : 'Could not save job');
      setBusy(false);
      return null;
    }

    toast.success('Job saved');
    invalidateQueries(['jobs']);
    if (jobId !== undefined) {
      invalidateQueries(['job', jobId]);
    }
    setBusy(false);
    return job;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return { save, busy, error, clearError };
}
