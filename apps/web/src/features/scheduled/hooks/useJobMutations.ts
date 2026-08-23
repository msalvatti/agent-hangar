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
import { JOBS_KEY, jobKey } from '../lib/query-keys';
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

  // Nothing these callbacks read changes between renders, so their dependency lists are empty —
  // and anything constant added to one would never change either.
  // Stryker disable ArrayDeclaration
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
    // Both the listing and the saved job's own view, keyed by what the server returned rather than
    // by what was asked for: an update and a create are the same job afterwards, and the created
    // one is the job the dialog is about to navigate to.
    invalidateQueries(JOBS_KEY);
    invalidateQueries(jobKey(job.id));
    setBusy(false);
    return job;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);
  // Stryker restore ArrayDeclaration

  return { save, busy, error, clearError };
}
