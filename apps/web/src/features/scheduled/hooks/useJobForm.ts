/**
 * Local form state for the job create/edit dialog.
 *
 * Layer: hook.
 */
'use client';

import type { JobSummary } from '@agent-hangar/core';
import { useCallback, useState } from 'react';

import { emptyJobForm, jobToForm, validateJobForm } from '../lib/job-form';
import type { JobFormErrors, JobFormValues } from '../lib/job-form';

/** Result of {@link useJobForm}. */
export interface UseJobFormResult {
  values: JobFormValues;
  setField: <K extends keyof JobFormValues>(field: K, value: JobFormValues[K]) => void;
  errors: JobFormErrors;
  touched: Readonly<Partial<Record<keyof JobFormValues, boolean>>>;
  touch: (field: keyof JobFormValues) => void;
  isValid: boolean;
  reset: () => void;
}

function buildValues(initial: JobSummary | undefined): JobFormValues {
  return initial === undefined ? emptyJobForm() : jobToForm(initial);
}

/**
 * Manages a job form's values, per-field touched state, and live validation.
 *
 * @param initial - The job being edited, or `undefined` to start a blank create form.
 * @returns The form state and its mutators. `setField`/`touch`/`reset` are referentially stable
 *   (`reset` changes identity only when `initial` does), so a caller may depend on them in an
 *   effect without re-running on every render.
 */
export function useJobForm(initial?: JobSummary): UseJobFormResult {
  const [values, setValues] = useState<JobFormValues>(() => buildValues(initial));
  const [touched, setTouched] = useState<Partial<Record<keyof JobFormValues, boolean>>>({});

  const setField = useCallback(
    <K extends keyof JobFormValues>(field: K, value: JobFormValues[K]) => {
      setValues((previous) => ({ ...previous, [field]: value }));
    },
    [],
  );

  const touch = useCallback((field: keyof JobFormValues) => {
    setTouched((previous) => ({ ...previous, [field]: true }));
  }, []);

  const reset = useCallback(() => {
    setValues(buildValues(initial));
    setTouched({});
  }, [initial]);

  const errors = validateJobForm(values);

  return {
    values,
    setField,
    errors,
    touched,
    touch,
    isValid: Object.keys(errors).length === 0,
    reset,
  };
}
