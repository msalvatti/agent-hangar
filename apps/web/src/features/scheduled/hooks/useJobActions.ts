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

import { JOBS_KEY, jobKey, runsKey } from '../lib/query-keys';
import { deleteJob, runJob, updateJob } from '../services/scheduled-api';

/** Result of {@link useJobActions}. */
export interface UseJobActionsResult {
  /** Toggles `enabled`, optimistically, rolling back on error. */
  toggleEnabled: (job: JobSummary, enabled: boolean) => Promise<void>;
  /** Triggers a manual run; a 409 (overlap) is toasted rather than thrown. */
  runNow: (job: JobSummary) => Promise<void>;
  /** Deletes a job and its run history; resolves `false` when the request failed. */
  remove: (job: JobSummary) => Promise<boolean>;
  /** Whether a mutation is in flight for a given job id. */
  pending: Readonly<Record<string, boolean>>;
  /** Optimistic `enabled` overrides, keyed by job id. Read them with {@link resolveEnabled}. */
  overrides: EnabledOverrides;
}

/** An optimistic `enabled` value, and the job revision it was applied on top of. */
export interface EnabledOverride {
  enabled: boolean;
  /** The `updatedAt` the job carried when the toggle was clicked. */
  appliedTo: string;
}

/** Optimistic `enabled` overrides, keyed by job id. */
export type EnabledOverrides = Readonly<Record<string, EnabledOverride>>;

/**
 * Resolves the `enabled` state to render for a job.
 *
 * An override only stands in for the value it was applied on top of. Once the job comes back from
 * the server with a newer revision — from this toggle, or from a save through the job dialog —
 * that revision is the truth and the override is spent, so a stale optimistic value can never
 * outlive the write it was covering for.
 *
 * @param job - The job as last loaded.
 * @param overrides - The optimistic overrides currently held.
 * @returns The `enabled` state to render.
 */
export function resolveEnabled(job: JobSummary, overrides: EnabledOverrides): boolean {
  const override = overrides[job.id];
  return override?.appliedTo === job.updatedAt ? override.enabled : job.enabled;
}

function withEntry(
  map: Readonly<Record<string, boolean>>,
  key: string,
  value: boolean,
): Record<string, boolean> {
  return { ...map, [key]: value };
}

function withoutEntry<T>(map: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(map).filter(([entryKey]) => entryKey !== key));
}

/**
 * Row actions for the scheduled-jobs list: optimistic enable toggle, manual run, delete.
 *
 * @returns The action callbacks plus per-job pending/override state for the table to render.
 */
export function useJobActions(): UseJobActionsResult {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [overrides, setOverrides] = useState<Record<string, EnabledOverride>>({});

  // Nothing these callbacks read changes between renders, so their dependency lists are empty —
  // and anything constant added to one would never change either.
  // Stryker disable ArrayDeclaration
  const toggleEnabled = useCallback(async (job: JobSummary, enabled: boolean) => {
    setOverrides((prev) => ({ ...prev, [job.id]: { enabled, appliedTo: job.updatedAt } }));
    setPending((prev) => withEntry(prev, job.id, true));
    try {
      await updateJob(job.id, { enabled });
      invalidateQueries(JOBS_KEY);
      invalidateQueries(jobKey(job.id));
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
      invalidateQueries(runsKey(job.id));
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
      invalidateQueries(JOBS_KEY);
      return true;
    } catch {
      toast.error('Could not delete job');
      return false;
    } finally {
      setPending((prev) => withoutEntry(prev, job.id));
    }
  }, []);

  // Stryker restore ArrayDeclaration

  return { toggleEnabled, runNow, remove, pending, overrides };
}
