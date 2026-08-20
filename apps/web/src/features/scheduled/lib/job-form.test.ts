/**
 * Unit tests for the job form model.
 *
 * Layer: unit.
 * Goal: `emptyJobForm`/`jobToForm` construct the right values, `repoFullName` reduces a picked
 * repository to the stored field, `formToRequest` maps to the contract shape, and
 * `validateJobForm` covers every validation rule plus the schema fallback.
 * Mocks: none.
 */
import type { JobSummary } from '@agent-hangar/core';
import { describe, expect, it } from 'vitest';

import { emptyJobForm, formToRequest, jobToForm, repoFullName, validateJobForm } from './job-form';
import type { JobFormValues } from './job-form';

const job: JobSummary = {
  id: 'job-1',
  name: 'Nightly tests',
  cron: '0 2 * * *',
  timezone: 'UTC',
  prompt: 'Run the suite.',
  repoUrl: 'https://github.com/acme/api',
  branch: 'main',
  enabled: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastRunStatus: null,
};

function validForm(): JobFormValues {
  return {
    name: 'Nightly tests',
    repo: 'acme/api',
    branch: 'main',
    cron: '0 2 * * *',
    timezone: 'UTC',
    prompt: 'Run the suite.',
    enabled: true,
  };
}

describe('emptyJobForm', () => {
  /** Starts enabled, blank fields, timezone defaulted to the system zone. */
  it('builds a blank, enabled form', () => {
    const form = emptyJobForm();
    expect(form.enabled).toBe(true);
    expect(form.name).toBe('');
    expect(form.repo).toBeNull();
    expect(form.timezone.length).toBeGreaterThan(0);
  });
});

describe('jobToForm', () => {
  /** Prefills every field from the job, deriving `repo` from the repo URL. */
  it('prefills from a job', () => {
    const form = jobToForm(job);
    expect(form.repo).toBe('acme/api');
    expect(form.branch).toBe('main');
    expect(form.cron).toBe(job.cron);
    expect(form.enabled).toBe(true);
  });

  /** A repo URL that does not match the expected shape falls back to the raw URL. */
  it('falls back to the raw URL when it does not match the expected shape', () => {
    const form = jobToForm({ ...job, repoUrl: 'not-a-github-url' });
    expect(form.repo).toBe('not-a-github-url');
  });
});

describe('formToRequest', () => {
  /** Maps every field to the contract's request shape. */
  it('maps the form to the request body', () => {
    const request = formToRequest(validForm());
    expect(request).toEqual({
      name: 'Nightly tests',
      cron: '0 2 * * *',
      timezone: 'UTC',
      prompt: 'Run the suite.',
      repoUrl: 'https://github.com/acme/api',
      branch: 'main',
      enabled: true,
    });
  });

  /** A null repo/branch maps to an empty string (the schema/field checks catch it as invalid). */
  it('maps a null repo and branch to empty strings', () => {
    const request = formToRequest({ ...validForm(), repo: null, branch: null });
    expect(request.repoUrl).toBe('https://github.com/');
    expect(request.branch).toBe('');
  });
});

describe('validateJobForm', () => {
  /** A fully valid form has no errors. */
  it('accepts a valid form', () => {
    expect(validateJobForm(validForm())).toEqual({});
  });

  /** An empty name is rejected. */
  it('rejects an empty name', () => {
    expect(validateJobForm({ ...validForm(), name: '   ' }).name).toBeDefined();
  });

  /** A name longer than the UI limit is rejected. */
  it('rejects a name that is too long', () => {
    expect(validateJobForm({ ...validForm(), name: 'x'.repeat(81) }).name).toBeDefined();
  });

  /** A missing repo is rejected. */
  it('rejects a missing repo', () => {
    expect(validateJobForm({ ...validForm(), repo: null }).repo).toBeDefined();
  });

  /** A missing branch is rejected. */
  it('rejects a missing branch', () => {
    expect(validateJobForm({ ...validForm(), branch: '' }).branch).toBeDefined();
  });

  /** An invalid cron expression is rejected with the adapter's reason. */
  it('rejects an invalid cron expression', () => {
    expect(validateJobForm({ ...validForm(), cron: 'nope' }).cron).toBeDefined();
  });

  /** An unknown timezone is rejected. */
  it('rejects an unknown timezone', () => {
    expect(validateJobForm({ ...validForm(), timezone: 'Not/AZone' }).timezone).toBeDefined();
  });

  /** An empty prompt is rejected. */
  it('rejects an empty prompt', () => {
    expect(validateJobForm({ ...validForm(), prompt: '' }).prompt).toBeDefined();
  });

  /** A prompt longer than the UI limit is rejected. */
  it('rejects a prompt that is too long', () => {
    expect(validateJobForm({ ...validForm(), prompt: 'x'.repeat(4001) }).prompt).toBeDefined();
  });

  /**
   * A repo string that passes the "non-empty" field check but produces a `repoUrl` the shared
   * schema rejects (e.g. spaces) falls through to the schema-level error.
   */
  it('rejects a repo that fails the shared schema after passing field checks', () => {
    const errors = validateJobForm({ ...validForm(), repo: 'not a valid repo' });
    expect(errors.prompt).toBeDefined();
  });
});

describe('repoFullName', () => {
  /** A picked repository is stored as its `owner/name`, which is what the request URL is built
   * from. */
  it('reduces a picked repository to its full name', () => {
    expect(
      repoFullName({
        fullName: 'acme/api',
        url: 'https://github.com/acme/api',
        defaultBranch: 'main',
        private: false,
        description: null,
      }),
    ).toBe('acme/api');
  });

  /** Clearing the choice clears the field, so validation reports the repository as required. */
  it('maps a cleared choice to null', () => {
    expect(repoFullName(null)).toBeNull();
  });
});
