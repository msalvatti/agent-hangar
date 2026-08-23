/**
 * Job dialog form model: values, empty/prefilled construction, request mapping, validation.
 *
 * Layer: service (adapter).
 */
import { jobUpsertRequest } from '@agent-hangar/core';
import type { JobSummary, JobUpsertRequest, RepoSummary } from '@agent-hangar/core';

import { repoLabel } from '@/shared/lib/repo-label';

import { validateCron } from './cron';
import { listTimezones, systemTimezone } from './timezones';

/**
 * Form field each request field maps back to, so a schema rejection is shown under the input the
 * user can act on rather than under whichever field happens to be last. Every field the form
 * renders is spelled out even where the two names coincide: the table is what makes a request key
 * the form does NOT render fall through to the default instead of naming a field that is not
 * there.
 */
const FIELD_BY_REQUEST_KEY: Readonly<Record<string, keyof JobFormValues>> = {
  name: 'name',
  cron: 'cron',
  timezone: 'timezone',
  prompt: 'prompt',
  repoUrl: 'repoUrl',
  branch: 'branch',
  enabled: 'enabled',
};

/**
 * Resolves the form field a schema issue belongs to.
 *
 * A pure, exported function so its fallback — unreachable through {@link validateJobForm}, whose
 * schema only ever reports the request's own top-level keys — is directly testable.
 *
 * @param path - The rejected value's path within the request body.
 * @returns The form field to attach the message to; the prompt, for a path naming no field.
 */
export function formFieldForIssue(path: readonly PropertyKey[]): keyof JobFormValues {
  return FIELD_BY_REQUEST_KEY[String(path[0])] ?? 'prompt';
}
const MAX_NAME_LENGTH = 80;
const MAX_PROMPT_LENGTH = 4000;

/** Editable fields of the job create/edit dialog. */
export interface JobFormValues {
  name: string;
  /**
   * The repository's own URL, as the listing reported it or as the job stored it, and the single
   * source of truth for which repository the job runs against. The `owner/name` the dialog shows
   * is derived from it with {@link repoDisplayName}, never the other way round: rebuilding a URL
   * from the short form would pin every job to one hard-coded forge.
   */
  repoUrl: string | null;
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
    repoUrl: null,
    branch: null,
    cron: '',
    timezone: systemTimezone(),
    prompt: '',
    enabled: true,
  };
}

/**
 * Reduces a repository picked in the palette to the value the form stores.
 *
 * @param repo - The chosen repository, or `null` when the choice was cleared.
 * @returns The repository's own URL, or `null`.
 */
export function pickedRepoUrl(repo: RepoSummary | null): string | null {
  return repo === null ? null : repo.url;
}

/**
 * What the listing said about the repository the operator picked, kept with the URL it is about.
 */
export interface PickedRepoDefault {
  repoUrl: string;
  defaultBranch: string;
}

/**
 * Reduces a repository picked in the palette to the branch default the form seeds from.
 *
 * The URL travels with the branch name so a default read for one repository can never seed
 * another: a consumer compares the pair against the repository the form currently holds.
 *
 * @param repo - The chosen repository, or `null` when the choice was cleared.
 * @returns The repository's URL and default branch, or `null`.
 */
export function pickedRepoDefault(repo: RepoSummary | null): PickedRepoDefault | null {
  return repo === null ? null : { repoUrl: repo.url, defaultBranch: repo.defaultBranch };
}

/**
 * The `owner/name` the repository and branch pickers work in, derived from the stored URL.
 *
 * @param repoUrl - The form's repository URL, or `null` while none is chosen.
 * @returns The short form, or `null` when no repository is chosen.
 */
export function repoDisplayName(repoUrl: string | null): string | null {
  // Stryker disable next-line ConditionalExpression: the guard is what keeps a value the label
  // helper is not typed for away from it; handing it nothing happens to come back as nothing too,
  // so no observable behaviour distinguishes the two.
  return repoUrl === null ? null : repoLabel(repoUrl);
}

/**
 * Builds form values prefilled from an existing job.
 *
 * @param job - The job being edited.
 * @returns The form values.
 */
export function jobToForm(job: JobSummary): JobFormValues {
  return {
    name: job.name,
    repoUrl: job.repoUrl,
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
 * @returns The request body (repository URL and branch coerced to empty strings when unset;
 *   schema validation catches that at the caller).
 */
export function formToRequest(values: JobFormValues): JobUpsertRequest {
  return {
    name: values.name.trim(),
    cron: values.cron.trim(),
    timezone: values.timezone,
    prompt: values.prompt,
    repoUrl: values.repoUrl ?? '',
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

  if (values.repoUrl === null) {
    errors.repoUrl = 'Repository is required.';
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
    for (const issue of schemaResult.error.issues) {
      errors[formFieldForIssue(issue.path)] = issue.message;
    }
  }
  return errors;
}
