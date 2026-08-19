/**
 * Job dialog form model: values, empty/prefilled construction, request mapping, validation.
 *
 * Layer: service (adapter).
 */
import { jobUpsertRequest } from '@agent-hangar/core';
import type { JobSummary, JobUpsertRequest } from '@agent-hangar/core';

import { validateCron } from './cron';
import { listTimezones, systemTimezone } from './timezones';

const GITHUB_REPO_URL_PATTERN = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/;
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 4000;

/** Editable fields of the job create/edit dialog. */
export interface JobFormValues {
  name: string;
  repo: string | null;
  branch: string | null;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
}

/** Validation errors keyed by field, present only for fields that failed. */
export type JobFormErrors = Partial<Record<keyof JobFormValues, string>>;

/**
 * A blank form for creating a job: enabled by default, timezone defaulted to the system zone.
 *
 * @returns The empty form values.
 */
export function emptyJobForm(): JobFormValues {
  return {
    name: '',
    repo: null,
    branch: null,
    cron: '',
    timezone: systemTimezone(),
    prompt: '',
    enabled: true,
  };
}

/**
 * Builds form values prefilled from an existing job.
 *
 * @param job - The job being edited.
 * @returns The form values.
 */
export function jobToForm(job: JobSummary): JobFormValues {
  const match = GITHUB_REPO_URL_PATTERN.exec(job.repoUrl);
  return {
    name: job.name,
    repo: match?.[1] ?? job.repoUrl,
    branch: job.branch,
    cron: job.cron,
    timezone: job.timezone,
    prompt: job.prompt,
    enabled: job.enabled,
  };
}

/**
 * Maps form values to the API request body.
 *
 * @param values - The form values.
 * @returns The request body (repo/branch coerced to empty strings when unset; schema validation
 *   catches that at the caller).
 */
export function formToRequest(values: JobFormValues): JobUpsertRequest {
  return {
    name: values.name.trim(),
    cron: values.cron.trim(),
    timezone: values.timezone,
    prompt: values.prompt,
    repoUrl: `https://github.com/${values.repo ?? ''}`,
    branch: values.branch ?? '',
    enabled: values.enabled,
  };
}

/**
 * Validates the form: field-level checks first (required, length, cron shape, known timezone),
 * then the shared schema for anything those checks miss.
 *
 * @param values - The form values.
 * @returns Errors keyed by field; empty when the form is valid.
 */
export function validateJobForm(values: JobFormValues): JobFormErrors {
  const errors: JobFormErrors = {};

  const trimmedName = values.name.trim();
  if (trimmedName.length === 0) {
    errors.name = 'Name is required.';
  } else if (trimmedName.length > MAX_NAME_LENGTH) {
    errors.name = `Name must be ${String(MAX_NAME_LENGTH)} characters or fewer.`;
  }

  if (values.repo === null || values.repo.trim().length === 0) {
    errors.repo = 'Repository is required.';
  }

  if (values.branch === null || values.branch.trim().length === 0) {
    errors.branch = 'Branch is required.';
  }

  const cronValidation = validateCron(values.cron);
  if (!cronValidation.ok) {
    errors.cron = cronValidation.reason;
  }

  if (!listTimezones().includes(values.timezone)) {
    errors.timezone = 'Unknown timezone.';
  }

  if (values.prompt.trim().length === 0) {
    errors.prompt = 'Prompt is required.';
  } else if (values.prompt.length > MAX_PROMPT_LENGTH) {
    errors.prompt = `Prompt must be ${String(MAX_PROMPT_LENGTH)} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    return errors;
  }

  const schemaResult = jobUpsertRequest.safeParse(formToRequest(values));
  if (!schemaResult.success) {
    errors.prompt = schemaResult.error.message;
  }
  return errors;
}
